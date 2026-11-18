"""Real API/SQLite/SANY/TLC; scripted LLM boundary, never provider evidence."""
import pytest
from fastapi.testclient import TestClient

from proveryalka.api.app import create_app
from proveryalka.agent.clarification import DialogueDraft
from test_analyst_http import TEXT, draft, post, session, wait_explanation, world
from test_check_api import wait_run
from test_checker_tlc import JAVA, JAR, PROBLEM
from dataclasses import replace

pytestmark = pytest.mark.skipif(PROBLEM is not None, reason=f"TLC unavailable: {PROBLEM}")

APPROVE = "Approve разрешён только в Created и устанавливает status=Approved, approved=true."
CANCEL = "Cancel разрешён только в Created или Approved и устанавливает status=Cancelled, cancelled=true, approved=false."
REFINEMENT = APPROVE + " " + CANCEL


def fixed_draft(sources, previous):
    data = draft(sources, previous).analysis.model_dump(mode="json")
    corrections = []
    for index, text in ((1, APPROVE), (2, CANCEL)):
        fact = data["requirements"][index]
        fact.update(text=text, quote=text, source_id=sources[-1].id)
        corrections.append({"requirement_id": fact["previous_id"], "quote": text, "reason": "Явное уточнение пользователя"})
        data["events"][index - 1]["quote"] = text
    from test_codegen import load
    transitions = load("order_fixed").transitions
    for index in (0, 1):
        data["events"][index]["guard"] = transitions[index].guard.model_dump(mode="json")
        data["events"][index]["effects"] = [item.model_dump(mode="json") for item in transitions[index].effects]
    return DialogueDraft(analysis=data, questions=[], resolutions=[], corrections=corrections, reply="Учёл уточнение Cancel и ограничение Approve.")


def test_text_agent_tlc_explicit_refinement_restart_and_isolation(world):
    settings = replace(world.settings, java_path=JAVA, tla_jar=JAR)
    world.script.turns = [lambda s, p: draft(s, p), fixed_draft]
    with TestClient(create_app(settings)) as client:
        sid = session(client)
        foreign = session(client, key="foreign")
        message = post(client, f"/api/sessions/{sid}/messages", {"text": TEXT}, "m1").json()
        assert wait_run(client, message["run_id"])["state"] == "completed"
        model = client.get(f"/api/sessions/{sid}/dialogue").json()["model"]
        mid = model["model_id"]
        first = post(client, f"/api/models/{mid}/versions/1/checks", {"explain": True}, "c1").json()
        assert wait_run(client, first["run_id"])["state"] == "completed"
        assert wait_explanation(client, first["run_id"])["state"] == "ready"
        original = client.get(f"/api/checks/{first['run_id']}").json()
        result = original["results"][0]
        assert result["status"] == "PROPERTY_VIOLATED" and result["engine"]["name"] == "TLC"
        assert [step["transition_id"] for step in result["trace"][1:]] == ["Approve", "Cancel", "Execute"]
        assert [step["number"] for step in original["explanation"]["narrative"]["properties"][0]["steps"]] == [step["number"] for step in result["trace"]]
        assert len(client.get(f"/api/models/{mid}/versions").json()) == 1
        update = post(client, f"/api/sessions/{sid}/messages", {"text": REFINEMENT}, "m2").json()
        assert wait_run(client, update["run_id"])["state"] == "completed"
        view = client.get(f"/api/sessions/{sid}/dialogue").json()
        assert view["model"]["number"] == 2 and len(view["corrections"]) == 2
        version = client.get(f"/api/models/{mid}/versions/2").json()
        assert version["parent_id"] == model["version_id"]
        assert version["spec_hash"] != result["spec_hash"]
        second = post(client, f"/api/models/{mid}/versions/2/checks", {}, "c2").json()
        assert wait_run(client, second["run_id"])["state"] == "completed"
        fixed = client.get(f"/api/checks/{second['run_id']}").json()
        assert fixed["results"][0]["status"] == "PROPERTY_HOLDS"
        assert fixed["results"][0]["version_id"] == version["id"]
        assert client.get(f"/api/sessions/{foreign}/models").json() == []
        assert client.get(f"/api/sessions/{foreign}/dialogue").json()["model"] is None
        assert client.get(f"/api/checks/{first['run_id']}").json() == original
    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/checks/{first['run_id']}").json() == original
        assert client.get(f"/api/checks/{second['run_id']}").json() == fixed
        assert client.get(f"/api/models/{mid}/versions/2").json() == version
