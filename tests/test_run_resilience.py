import asyncio
import threading
import time
from dataclasses import replace

from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from test_check_api import FakeChecker, wait_run, prepared


class BlockingAnalyst:
    def __init__(self):
        self.started = threading.Event()
        self.stopped = threading.Event()

    async def __call__(self, store, session_id, body):
        self.started.set()
        try:
            await asyncio.sleep(100)
        finally:
            self.stopped.set()


def send(client, session_id, key="m"):
    return client.post(f'/api/sessions/{session_id}/messages',json={"text":"message"},headers={"Idempotency-Key":key})


def session(client, key):
    return client.post('/api/sessions',json={"title":key},headers={"Idempotency-Key":key}).json()["id"]


def test_cancel_active_and_queued_and_queue_capacity(tmp_path):
    settings = Settings(database_path=tmp_path/"db", max_pending_runs=2, agent_parallel=1)
    analyst = BlockingAnalyst()
    with TestClient(create_app(settings,analyst=analyst,checker=FakeChecker())) as client:
        first, second, third = [session(client,str(i)) for i in range(3)]
        active = send(client,first).json()["run_id"]
        assert analyst.started.wait(2)
        assert send(client,first,"duplicate").status_code == 409
        queued = send(client,second).json()["run_id"]
        assert send(client,third).status_code == 429
        assert send(client,first).json()["run_id"] == active
        client.post(f'/api/runs/{queued}/cancel')
        assert wait_run(client,queued)["state"] == "cancelled"
        response = client.post(f'/api/runs/{active}/cancel')
        assert response.status_code == 202
        assert wait_run(client,active)["state"] == "cancelled"
        assert analyst.stopped.is_set()
        assert client.post(f'/api/runs/{active}/cancel').json()["state"] == "cancelled"
        stream = client.get(f'/api/runs/{active}/events').text
        assert 'CANCELLED' in stream and 'event: run_finished' in stream


def test_agent_timeout_and_input_limits(tmp_path):
    settings = Settings(database_path=tmp_path/"db",agent_timeout_seconds=0.02,max_input_chars=10)
    analyst = BlockingAnalyst()
    with TestClient(create_app(settings,analyst=analyst,checker=FakeChecker())) as client:
        sid = session(client,"s")
        run_id = send(client,sid).json()["run_id"]
        run = wait_run(client,run_id)
        assert run["state"] == "failed" and run["error_code"] == "RUN_TIMEOUT"
        assert analyst.stopped.is_set()
        assert client.post(f'/api/sessions/{sid}/messages',json={"text":"x"*11},headers={"Idempotency-Key":"big"}).status_code == 422


def test_shutdown_stops_agent(tmp_path):
    analyst = BlockingAnalyst()
    with TestClient(create_app(Settings(database_path=tmp_path/"db"),analyst=analyst,checker=FakeChecker())) as client:
        sid = session(client,"s")
        send(client,sid)
        assert analyst.started.wait(2)
    assert analyst.stopped.is_set()


def test_large_event_replay_finishes_with_cursor_at_end(prepared):
    settings, store, model, _ = prepared
    with TestClient(create_app(settings,checker=FakeChecker())) as client:
        run = store.create_check(model["id"],1,{},"manual")
        for n in range(120):
            store.event(run["run_id"],"message_delta",{"text":str(n)})
        store.fail_run(run["run_id"],"FAILED")
        store.finalize_events(run["run_id"])
        url = f'/api/runs/{run["run_id"]}/events'
        assert client.get(url).text.count('data: ') == 122
        assert client.get(url,headers={"Last-Event-ID":"122"}).text == ""


def test_stream_waits_for_terminal_event_saved_after_empty_read(prepared):
    settings, store, model, _ = prepared
    with TestClient(create_app(settings,checker=FakeChecker())) as client:
        run = store.create_check(model["id"],1,{},"race")
        store.fail_run(run["run_id"],"FAILED")
        backend = client.app.state.backend
        original = backend.store.get_run

        def racing(run_id):
            # Терминальные события сохраняются сразу после пустого чтения потока.
            store.finalize_events(run_id)
            return original(run_id)

        backend.store.get_run = racing
        stream = client.get(f'/api/runs/{run["run_id"]}/events').text
        assert 'event: error' in stream and 'event: run_finished' in stream
