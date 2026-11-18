import asyncio
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient

from proveryalka.agent import dialogue, errors
from proveryalka.agent.activity import activity, observe_activity
from proveryalka.api.app import create_app
from proveryalka.contracts import Source
from proveryalka.storage.sqlite import SQLiteStore
from test_analyst_http import world, TEXT, draft, post, session
from test_check_api import wait_run
from test_file_dialogue import world as file_world, send as send_file


def page(client, sid, **params):
    response = client.get(f"/api/sessions/{sid}/agent-runs", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def finish(client, sid, text=TEXT, key="first"):
    run = post(client, f"/api/sessions/{sid}/messages", {"text": text}, key).json()
    assert wait_run(client, run["run_id"])["state"] == "completed"
    # This also waits for the durable terminal event after the state transition.
    client.get(f"/api/runs/{run['run_id']}/events")
    return run


def test_agent_trace_preserves_exact_entries_and_server_times_after_restart(world):
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        run = finish(client, sid)
        assert post(client, f"/api/sessions/{sid}/messages", {"text": TEXT}, "first").json()["run_id"] == run["run_id"]
        entries = client.get(f"/api/sessions/{sid}/dialogue").json()["entries"]
        trace = page(client, sid)["runs"][0]
        assert trace["input_entry_id"] == entries[0]["id"]
        assert trace["reply_entry_id"] == entries[1]["id"]
        assert trace["source_id"] == entries[0]["source_id"]
        assert trace["created_at"] <= trace["started_at"] <= trace["finished_at"]
        assert all(event["created_at"].endswith("Z") or "+00:00" in event["created_at"] for event in trace["events"])
        assert len({event["event_id"] for event in trace["events"]}) == len(trace["events"])
        assert trace["events"][-1]["type"] == "run_finished"
        assert len(page(client, sid)["runs"]) == 1
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        assert page(client, sid)["runs"] == [trace]


def test_failed_and_retried_runs_share_input_but_never_the_failed_reply(world):
    world.script.fail = errors.AgentError("PROVIDER_TIMEOUT", "Do not expose provider body")
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        first = post(client, f"/api/sessions/{sid}/messages", {"text": TEXT}, "first").json()
        assert wait_run(client, first["run_id"])["state"] == "failed"
        world.script.fail = None
        retry = post(client, f"/api/sessions/{sid}/pending/retry", key="retry").json()
        assert wait_run(client, retry["run_id"])["state"] == "completed"
        client.get(f"/api/runs/{retry['run_id']}/events")
        traces = {trace["run"]["run_id"]: trace for trace in page(client, sid)["runs"]}
        assert traces[first["run_id"]]["input_entry_id"] == traces[retry["run_id"]]["input_entry_id"]
        assert traces[first["run_id"]]["reply_entry_id"] is None
        assert traces[retry["run_id"]]["reply_entry_id"]
        assert "Do not expose provider body" not in json.dumps(traces)


def test_cursor_and_session_scope_are_independent_of_newer_runs(world):
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        one = finish(client, sid)
        two = finish(client, sid, "Без изменений.", "second")
        latest = page(client, sid, limit=1)
        assert latest["runs"][0]["run"]["run_id"] == two["run_id"]
        assert latest["next_cursor"]
        three = finish(client, sid, "Правила прежние.", "third")
        older = page(client, sid, limit=1, before=latest["next_cursor"])
        assert older["runs"][0]["run"]["run_id"] == one["run_id"] and older["next_cursor"] is None
        other = post(client, "/api/sessions", {"title": "Other"}, "other").json()["id"]
        assert page(client, other)["runs"] == []
        assert client.get("/api/sessions/missing/agent-runs").status_code == 404
        for params in ({"limit": 0}, {"limit": 101}, {"before": 0}):
            assert client.get(f"/api/sessions/{sid}/agent-runs", params=params).status_code == 422


def test_legacy_trace_never_fabricates_phases_times_or_provider_content(world):
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        run = finish(client, sid)
        store = client.app.state.backend.store
        with store.transaction(write=True) as connection:
            for row in connection.execute("SELECT event_id,event_json FROM run_events WHERE run_id=?", (run["run_id"],)).fetchall():
                event = json.loads(row["event_json"])
                if event["type"] == "activity":
                    connection.execute("DELETE FROM run_events WHERE run_id=? AND event_id=?", (run["run_id"], row["event_id"]))
                else:
                    event.pop("created_at", None)
                    connection.execute("UPDATE run_events SET event_json=? WHERE run_id=? AND event_id=?", (json.dumps(event), run["run_id"], row["event_id"]))
        store.event(run["run_id"], "tool_call", {"name": "private", "prompt": "PRIVATE_PROVIDER_PAYLOAD"})
        trace = page(client, sid)["runs"][0]
        assert trace["created_at"] is None and trace["started_at"] is None and trace["finished_at"] is None
        assert all(event["type"] != "activity" for event in trace["events"])
        serialized = json.dumps(trace)
        assert TEXT not in serialized and "PRIVATE_PROVIDER_PAYLOAD" not in serialized
        assert next(event for event in trace["events"] if event["type"] == "message_delta")["data"] == {"characters": 6}


def test_truncated_trace_keeps_terminal_time_and_declares_limit(world):
    store = SQLiteStore(world.settings.database_path)
    store.initialize()
    sid = store.create_session({"title": "Long run"}, "long")["id"]
    run = store.create_agent_run(sid, {"text": "do not expose"}, "r")
    store.claim_run(run["run_id"])
    for _ in range(205):
        store.event(run["run_id"], "message_delta", {"text": "private output"})
    store.fail_run(run["run_id"], "PROVIDER_TIMEOUT")
    store.finalize_events(run["run_id"])
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        trace = page(client, sid)["runs"][0]
        assert trace["events_truncated"] and len(trace["events"]) == 200
        assert trace["finished_at"] and trace["run"]["state"] == "failed"
        assert "private output" not in json.dumps(trace)


def test_file_trace_links_the_actual_selected_file_without_exposing_bytes(file_world):
    client, store, owner, model, version, generation, ref, calls = file_world
    run = send_file(client, owner["id"], ref).json()
    assert wait_run(client, run["run_id"])["state"] == "completed"
    client.get(f"/api/runs/{run['run_id']}/events")
    entries = client.get(f"/api/sessions/{owner['id']}/dialogue").json()["entries"]
    trace = page(client, owner["id"])["runs"][0]
    assert trace["input_entry_id"] == entries[0]["id"]
    assert trace["reply_entry_id"] == entries[1]["id"]
    context_event = next(e for e in trace["events"] if e["data"].get("phase") == "file_context_ready")
    assert context_event["data"]["path"] == "app/rules.py" and context_event["data"]["version_id"] == version["id"]
    assert "untrusted_file" not in json.dumps(trace) and "selected_model" not in json.dumps(trace)


def test_cancelled_trace_keeps_actual_stop_and_input_link(world):
    import threading
    world.script.gate = threading.Event()
    with TestClient(create_app(world.settings, checker=world.checker)) as client:
        sid = session(client)
        run = post(client, f"/api/sessions/{sid}/messages", {"text": TEXT}, "cancel").json()
        assert world.script.started.wait(2)
        client.post(f"/api/runs/{run['run_id']}/cancel")
        assert wait_run(client, run["run_id"])["state"] == "cancelled"
        client.get(f"/api/runs/{run['run_id']}/events")
        trace = page(client, sid)["runs"][0]
        assert trace["run"]["error_code"] == "CANCELLED"
        assert trace["input_entry_id"] and trace["reply_entry_id"] is None
        assert trace["finished_at"] and trace["events"][-1]["data"] == {"state": "cancelled"}
        world.script.gate.set()


def test_operation_observer_is_async_context_local_and_failures_do_not_escape():
    async def scenario():
        records = {"a": [], "b": []}
        async def one(name):
            async def save(phase, facts): records[name].append((phase, facts))
            with observe_activity(save):
                await activity("model_request", source_id=name)
                await asyncio.sleep(0)
                await activity("model_response", source_id=name)
        await asyncio.gather(one("a"), one("b"))
        assert all(all(facts["source_id"] == name for _, facts in events) for name, events in records.items())
        async def broken(*_): raise RuntimeError("observer failed")
        with observe_activity(broken): await activity("validation", outcome="passed")
        await activity("answer_ready")
    asyncio.run(scenario())


def test_model_attempts_and_validation_are_observed_at_actual_boundaries(monkeypatch):
    source = Source(id="s", session_id="session", text=TEXT)
    good = draft([source], None, reply="Done")
    bad = good.model_copy(deep=True)
    bad.analysis.requirements[0].source_id = "missing"
    candidates = iter([bad, good])
    calls, observed = [], []
    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
    monkeypatch.setattr(dialogue, "create_client", Client)
    monkeypatch.setattr(dialogue, "create_agent", lambda _: SimpleNamespace(clone=lambda **_: object()))
    async def model(*_, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(final_output=next(candidates))
    monkeypatch.setattr(dialogue, "run_agent", model)
    async def scenario():
        async def save(phase, facts): observed.append((phase, facts))
        with observe_activity(save): return await dialogue.generate_state({}, [source], None, None, 5)
    result = asyncio.run(scenario())
    assert result.reply == "Done" and len(calls) == 2
    assert [phase for phase, _ in observed] == ["model_request", "model_response", "validation", "retry", "model_request", "model_response", "validation"]
    assert observed[2][1]["outcome"] == "failed" and observed[-1][1]["outcome"] == "passed"
    assert all("prompt" not in facts and "diagnostic" not in facts for _, facts in observed)
