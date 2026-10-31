import threading

from fastapi.testclient import TestClient

from proveryalka.agent import errors
from proveryalka.api.app import create_app
from test_analyst_http import world, TEXT, draft, question, post, session
from test_check_api import wait_run


def entries(client, sid):
    response = client.get(f"/api/sessions/{sid}/dialogue")
    assert response.status_code == 200, response.text
    return response.json()["entries"]


def test_public_entries_keep_turn_order_identity_questions_and_reload(world):
    world.script.turns = [
        lambda s, p: draft(s, p, [question("Кто согласует?")], reply="Нужен ответ."),
        lambda s, p: draft(s, p, resolutions=[{"question_id": qid, "decision": "answered", "quote": "Руководитель."}], reply="Модель готова."),
    ]
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        url = f"/api/sessions/{sid}/messages"
        run = post(client, url, {"text": TEXT}, "first").json()
        assert wait_run(client, run["run_id"])["state"] == "completed"
        first = entries(client, sid)
        qid = first[1]["questions"][0]["id"]
        assert first[1]["questions"][0]["text"] == "Кто согласует?"
        run = post(client, url, {"text": "Руководитель.", "question_id": qid}, "answer").json()
        assert wait_run(client, run["run_id"])["state"] == "completed"
        saved = entries(client, sid)
        assert [(e["kind"], e["text"]) for e in saved] == [
            ("user", TEXT), ("assistant", "Нужен ответ."), ("user", "Руководитель."), ("assistant", "Модель готова.")]
        assert saved[:2] == first
        assert saved[2]["question_id"] == qid and saved[2]["source_id"]
        assert [e["sequence"] for e in saved] == sorted(e["sequence"] for e in saved)
        assert len({e["id"] for e in saved}) == 4 and all(e["created_at"] for e in saved)
        assert not any("analyst_" in e["text"] for e in saved)
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        assert entries(client, sid) == saved


def test_retry_discard_and_cancel_do_not_duplicate_user_entries(world):
    world.script.fail = errors.AgentError("PROVIDER_TIMEOUT", "Timeout")
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        url = f"/api/sessions/{sid}/messages"
        run = post(client, url, {"text": TEXT}, "first").json()
        assert wait_run(client, run["run_id"])["state"] == "failed"
        pending = entries(client, sid)
        assert len(pending) == 1 and pending[0]["status"] == "pending"
        world.script.fail = None
        run = post(client, f"/api/sessions/{sid}/pending/retry", key="retry").json()
        assert wait_run(client, run["run_id"])["state"] == "completed"
        done = entries(client, sid)
        assert len(done) == 2 and done[0]["id"] == pending[0]["id"] and done[0]["status"] == "processed"
        world.script.fail = errors.AgentError("PROVIDER_TIMEOUT", "Timeout")
        run = post(client, url, {"text": "Новый ответ"}, "second").json()
        assert wait_run(client, run["run_id"])["state"] == "failed"
        client.post(f"/api/sessions/{sid}/pending/discard")
        assert entries(client, sid)[-1]["status"] == "discarded"
        world.script.fail = None
        world.script.started.clear()
        world.script.gate = threading.Event()
        run = post(client, url, {"text": "Отменённый ход"}, "third").json()
        assert world.script.started.wait(2)
        client.post(f"/api/runs/{run['run_id']}/cancel")
        assert wait_run(client, run["run_id"])["state"] == "cancelled"
        saved = entries(client, sid)
        assert saved[-1]["status"] == "discarded" and saved[-1]["text"] == "Отменённый ход"
        assert sum(e["text"] == TEXT for e in saved) == 1
        world.script.gate.set()


def test_actual_user_json_is_preserved_while_internal_requests_are_hidden():
    import json
    from proveryalka.api.history import dialogue_entries
    text = json.dumps({"verification_request": {"text": "Actual user input"}})
    def row(number, role, content):
        return {"id": str(number), "sequence": number, "created_at": "2026-10-31", "message_data": {"role": role, "content": content}}
    internal = row(1, "user", text)
    assert dialogue_entries([internal], lambda _: "") == []
    marker = row(2, "assistant", json.dumps({"analyst_pending": {"source": {"id": "source", "text": text}, "question_id": None}}))
    public = dialogue_entries([internal, marker], lambda _: "")
    assert len(public) == 1 and public[0]["text"] == text and public[0]["source_id"] == "source"
