"""HTTP-сценарий аналитика: уточнения, модель, проверка, объяснение, отмена.

Настоящие run_analyst, состояние диалога, SQLite и HTTP; подменён только вызов LLM
(generate_state и модель Agents SDK для объяснения) и, где не нужен TLC, проверяющий адаптер.
"""
import asyncio
import copy
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from agents import Agent, Model, ModelResponse
from agents.usage import Usage
from fastapi.testclient import TestClient
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

from proveryalka.agent import dialogue, errors, verification
from proveryalka.agent.clarification import DialogueDraft, build_state
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.verification.contracts import VerificationReport
from test_check_api import wait_run
from test_verification import fixture_report


CASE = json.loads((Path(__file__).parent / "fixtures/formal_cases.json").read_text(encoding="utf-8"))[0]
TEXT = CASE["source"]["text"]


def draft(sources, previous, questions=(), resolutions=(), reply=None):
    data = copy.deepcopy(CASE["draft"])
    for index, fact in enumerate(data["requirements"]):
        fact["source_id"] = sources[0].id
        fact["previous_id"] = previous.analysis.requirements[index].id if previous else None
    return DialogueDraft(analysis=data, questions=list(questions), resolutions=list(resolutions), corrections=[], reply=reply)


def question(text):
    return {"text": text, "reason": "Нужно для модели", "kind": "missing", "assumption": None}


class Script:
    """Сценарий ответов LLM для generate_state; всё остальное — настоящий код диалога."""

    def __init__(self, turns=()):
        self.turns = list(turns)
        self.payloads = []
        self.question_ids = []
        self.fail = None
        self.gate = None
        self.started = threading.Event()

    async def __call__(self, payload, sources, previous, question_id, max_rounds):
        self.payloads.append(copy.deepcopy(payload))
        self.question_ids.append(question_id)
        self.started.set()
        while self.gate is not None and not self.gate.is_set():
            await asyncio.sleep(0.01)
        if self.fail is not None:
            raise self.fail
        turn = self.turns.pop(0) if self.turns else (lambda s, p: draft(s, p, reply="Готово"))
        return build_state(sources, turn(sources, previous), previous, question_id, max_rounds)


class APIChecker:
    def __init__(self):
        self.calls = []

    async def run(self, request, run_id=None):
        self.calls.append(request)
        return SimpleNamespace(report=fixture_report(request), directory=None)

    def cancel(self, run_id):
        return False


class NarrativeModel(Model):
    """LLM объяснения: строит VerificationNarrative строго по полученному отчёту."""

    def __init__(self, failures=0):
        self.calls = []
        self.failures = failures

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs):
        self.calls.append(json.loads(input[0]["content"] if isinstance(input, list) else input))
        if len(self.calls) <= self.failures:
            raise RuntimeError("provider failed")
        report = VerificationReport.model_validate(self.calls[-1]["verification_result"]["report"])
        narrative = verification.VerificationNarrative(
            summary="Найдено нарушение правила об отменённых заявках",
            question="Должна ли отмена сбрасывать согласование?",
            properties=[verification.PropertyExplanation(
                property_id=result.property_id, explanation="Отменённая заявка исполняется после согласования",
                steps=[verification.TraceComment(number=step.number, explanation=f"Шаг {step.number}") for step in result.trace],
            ) for result in report.results],
        )
        return ModelResponse(output=[ResponseOutputMessage(
            id="m", type="message", role="assistant", status="completed",
            content=[ResponseOutputText(type="output_text", text=narrative.model_dump_json(), annotations=[])],
        )], usage=Usage(), response_id="r")

    async def stream_response(self, *args, **kwargs):
        raise AssertionError("not used")
        yield


@pytest.fixture
def world(tmp_path, monkeypatch):
    script = Script()
    narrator = NarrativeModel()

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr(dialogue, "generate_state", script)
    monkeypatch.setattr(verification, "create_client", Client)
    monkeypatch.setattr(verification, "create_agent", lambda client: Agent(name="explainer", model=narrator))
    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", check_cache_path=None)
    return SimpleNamespace(script=script, narrator=narrator, settings=settings, checker=APIChecker())


def post(client, url, body=None, key="k"):
    return client.post(url, json=body, headers={"Idempotency-Key": key}) if body is not None else client.post(url, headers={"Idempotency-Key": key})


def events(client, run_id):
    stream = client.get(f"/api/runs/{run_id}/events").text
    return [json.loads(line[6:]) for line in stream.splitlines() if line.startswith("data: ")]


def wait_explanation(client, check_id):
    for _ in range(500):
        explanation = client.get(f"/api/checks/{check_id}").json()["explanation"]
        if explanation["state"] in ("ready", "failed", "cancelled"):
            return explanation
        time.sleep(0.01)
    pytest.fail("Explanation did not finish")


def session(client, key="s"):
    return post(client, "/api/sessions", {"title": "Заявка"}, key).json()["id"]


def test_text_to_explained_counterexample_over_http(world):
    q1, q2 = question("Кто согласует заявку?"), question("Нужен ли журнал изменений?")
    world.script.turns = [
        lambda s, p: draft(s, p, [q1, q2], reply="Разобрал правила заявки; нужны два уточнения."),
        lambda s, p: draft(s, p, resolutions=[{"question_id": ids[1], "decision": "answered", "quote": "Журнал изменений не нужен."}], reply="Журнал не моделирую."),
        lambda s, p: draft(s, p, resolutions=[{"question_id": ids[0], "decision": "answered", "quote": "Согласует руководитель."}], reply="Модель готова к проверке."),
        lambda s, p: draft(s, p, reply="Контрпример: Approve, затем Cancel, затем Execute исполняет отменённую заявку."),
    ]
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        url = f"/api/sessions/{sid}/messages"
        first = post(client, url, {"text": TEXT}, "m1").json()
        assert wait_run(client, first["run_id"])["state"] == "completed"
        view = client.get(f"/api/sessions/{sid}/dialogue").json()
        assert view["status"] == "needs_clarification" and view["reply"] == "Разобрал правила заявки; нужны два уточнения."
        ids = [item["id"] for item in view["questions"]]
        assert view["open_question_ids"] == ids and view["model"] is None and view["pending"] is None
        assert [r["code"] for r in view["requirements"]] == ["R1", "R2", "R3", "R4", "R5"]
        assert all(r["source_refs"][0]["quote"] in TEXT for r in view["requirements"])
        kinds = [e["type"] for e in events(client, first["run_id"])]
        assert kinds == ["dialogue_updated", "clarification_requested", "clarification_requested", "message_delta", "run_finished"]

        assert post(client, url, {"text": "Да", "question_id": "q_unknown"}, "bad").json()["error"]["code"] == "UNKNOWN_QUESTION"
        assert post(client, url, {"question_id": ids[0]}, "bad2").status_code == 422
        second = post(client, url, {"text": "Журнал изменений не нужен.", "question_id": ids[1]}, "m2").json()
        assert wait_run(client, second["run_id"])["state"] == "completed"
        assert world.script.question_ids[-1] == ids[1]
        view = client.get(f"/api/sessions/{sid}/dialogue").json()
        assert view["open_question_ids"] == [ids[0]]
        assert [q["status"] for q in view["questions"]] == ["open", "answered"]
        assert post(client, url, {"text": "Ещё раз", "question_id": ids[1]}, "closed").json()["error"]["code"] == "UNKNOWN_QUESTION"

        third = post(client, url, {"text": "Согласует руководитель.", "question_id": ids[0]}, "m3").json()
        assert wait_run(client, third["run_id"])["state"] == "completed"
        view = client.get(f"/api/sessions/{sid}/dialogue").json()
        assert view["status"] == "ready" and view["model"]["number"] == 1
        model_id, version_id = view["model"]["model_id"], view["model"]["version_id"]
        assert [e["data"] for e in events(client, third["run_id"]) if e["type"] == "message_delta"] == [{"text": "Модель готова к проверке."}]

        # TLC запускается только явным запросом пользователя.
        assert world.checker.calls == []
        check = post(client, f"/api/models/{model_id}/versions/1/checks", {"explain": True}, "c1").json()
        assert wait_run(client, check["run_id"])["state"] == "completed"
        explanation = wait_explanation(client, check["run_id"])
        result = client.get(f"/api/checks/{check['run_id']}").json()
        assert result["results"][0]["status"] == "PROPERTY_VIOLATED"
        assert result["results"][0]["related_requirements"]
        assert explanation["state"] == "ready"
        trace = [step["number"] for step in result["results"][0]["trace"]]
        assert [step["number"] for step in explanation["narrative"]["properties"][0]["steps"]] == trace
        assert [e["type"] for e in events(client, check["run_id"])] == ["check_started", "check_finished", "explanation_queued", "run_finished"]
        assert [e["type"] for e in events(client, explanation["run_id"])] == ["explanation_started", "explanation_ready", "run_finished"]
        explained = world.narrator.calls[0]["verification_result"]
        assert explained["version_id"] == version_id and explained["report"]["results"][0]["status"] == "PROPERTY_VIOLATED"

        fourth = post(client, url, {"text": "Объясни найденный контрпример."}, "m4").json()
        assert wait_run(client, fourth["run_id"])["state"] == "completed"
        context = world.script.payloads[-1]["verification_context"]
        assert context["report"]["results"][0]["status"] == "PROPERTY_VIOLATED"
        assert context["question"] == "Должна ли отмена сбрасывать согласование?"
        delta = [e["data"]["text"] for e in events(client, fourth["run_id"]) if e["type"] == "message_delta"]
        assert delta == ["Контрпример: Approve, затем Cancel, затем Execute исполняет отменённую заявку."]
        proposed = [e["data"] for e in events(client, fourth["run_id"]) if e["type"] == "model_proposed"]
        assert proposed[0]["version_id"] == version_id and proposed[0]["changed"] is False
        assert len(client.get(f"/api/models/{model_id}/versions").json()) == 1
        assert len(world.checker.calls) == 1


def test_failed_explanation_keeps_report_and_retries_saved_version(world):
    world.narrator.failures = 1
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        assert wait_run(client, post(client, f"/api/sessions/{sid}/messages", {"text": TEXT}, "m").json()["run_id"])["state"] == "completed"
        model = client.get(f"/api/sessions/{sid}/dialogue").json()["model"]
        check = post(client, f"/api/models/{model['model_id']}/versions/1/checks", {"explain": True}, "c").json()
        wait_run(client, check["run_id"])
        failed = wait_explanation(client, check["run_id"])
        assert failed["state"] == "failed" and failed["error_code"] == "EXPLANATION_FAILED" and failed["narrative"] is None
        saved = client.get(f"/api/checks/{check['run_id']}").json()
        assert saved["run"]["state"] == "completed" and saved["results"][0]["status"] == "PROPERTY_VIOLATED"

        # Пользователь меняет модель вручную: объяснение остаётся привязанным к проверенной версии 1.
        spec = client.get(f"/api/models/{model['model_id']}/versions/1").json()["spec"]
        changed = post(client, f"/api/models/{model['model_id']}/versions", {"spec": {**spec, "name": "Изменённая"}}, "v2").json()
        retry = post(client, f"/api/checks/{check['run_id']}/explanation", None, "e1")
        assert retry.status_code == 202
        assert wait_run(client, retry.json()["run_id"])["state"] == "completed"
        ready = client.get(f"/api/checks/{check['run_id']}").json()
        assert ready["explanation"]["state"] == "ready" and ready["results"] == saved["results"]
        request = world.narrator.calls[-1]["verification_result"]
        assert request["version_id"] == model["version_id"] != changed["id"]
        assert request["spec_hash"] == model["spec_hash"] != changed["spec_hash"]
        assert len(world.checker.calls) == 1
        assert post(client, f"/api/checks/{check['run_id']}/explanation", None, "e2").json()["error"]["code"] == "EXPLANATION_READY"
        assert post(client, f"/api/checks/{check['run_id']}/explanation", None, "e1").json() == retry.json()


def test_explicit_cancel_releases_the_dialogue(world):
    world.script.gate = threading.Event()
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        url = f"/api/sessions/{sid}/messages"
        first = post(client, url, {"text": TEXT}, "a").json()
        assert world.script.started.wait(2)
        client.post(f"/api/runs/{first['run_id']}/cancel")
        run = wait_run(client, first["run_id"])
        assert run["state"] == "cancelled" and run["error_code"] == "CANCELLED"
        assert client.get(f"/api/sessions/{sid}/dialogue").json()["pending"] is None
        world.script.gate.set()
        other = TEXT + " Дополнение пользователя."
        second = post(client, url, {"text": other}, "b")
        assert second.status_code == 202
        assert wait_run(client, second.json()["run_id"])["state"] == "completed"
        assert world.script.payloads[-1]["sources"][0]["text"] == other


def test_provider_failure_keeps_pending_for_retry_or_discard(world):
    world.script.fail = errors.AgentError("PROVIDER_UNAVAILABLE", "Не удалось подключиться")
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        url = f"/api/sessions/{sid}/messages"
        first = post(client, url, {"text": TEXT}, "a").json()
        run = wait_run(client, first["run_id"])
        assert run["state"] == "failed" and run["error_code"] == "PROVIDER_UNAVAILABLE"
        pending = client.get(f"/api/sessions/{sid}/dialogue").json()["pending"]
        assert pending["text"] == TEXT and pending["run_state"] == "failed"
        blocked = post(client, url, {"text": "Другой текст"}, "b")
        assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "PENDING_MESSAGE"
        world.script.fail = None
        retry = post(client, f"/api/sessions/{sid}/pending/retry", None, "r")
        assert retry.status_code == 202 and wait_run(client, retry.json()["run_id"])["state"] == "completed"
        view = client.get(f"/api/sessions/{sid}/dialogue").json()
        assert view["status"] == "ready" and view["pending"] is None
        assert post(client, f"/api/sessions/{sid}/pending/retry", None, "r2").json()["error"]["code"] == "NO_PENDING"

        world.script.fail = errors.AgentError("PROVIDER_TIMEOUT", "Время истекло")
        failed = post(client, url, {"text": "Согласует руководитель."}, "c").json()
        assert wait_run(client, failed["run_id"])["error_code"] == "PROVIDER_TIMEOUT"
        discarded = client.post(f"/api/sessions/{sid}/pending/discard").json()
        assert discarded["pending"] is None and discarded["status"] == "ready"
        world.script.fail = None
        assert wait_run(client, post(client, url, {"text": "Другой ответ."}, "d").json()["run_id"])["state"] == "completed"


def test_server_shutdown_is_not_a_user_cancel(world):
    world.script.gate = threading.Event()
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        first = post(client, f"/api/sessions/{sid}/messages", {"text": TEXT}, "a").json()
        assert world.script.started.wait(2)
    world.script.gate.set()
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        run = client.get(f"/api/runs/{first['run_id']}").json()
        assert run["state"] == "cancelled" and run["error_code"] == "SERVER_SHUTDOWN"
        assert client.get(f"/api/sessions/{sid}/dialogue").json()["pending"]["text"] == TEXT
        retry = post(client, f"/api/sessions/{sid}/pending/retry", None, "r").json()
        assert wait_run(client, retry["run_id"])["state"] == "completed"
        assert client.get(f"/api/sessions/{sid}/dialogue").json()["status"] == "ready"
