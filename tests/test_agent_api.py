import asyncio
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.behavior import BehavioralModel
from proveryalka.config import Settings
from proveryalka.storage.sqlite import SQLiteStore
from test_versions import setup_model
from test_check_api import wait_run, FakeChecker


class Analyst:
    def __init__(self, spec=None, fail=False):
        self.spec = spec
        self.fail = fail
        self.calls = 0

    async def __call__(self, store, session_id, body):
        self.calls += 1
        await asyncio.sleep(0.03)
        store.append_messages(session_id,[{"role":"user","content":body["text"]}])
        if self.fail:
            raise RuntimeError("secret provider response")
        store.append_messages(session_id,[{"role":"assistant","content":"Saved reply"}])
        behavior = BehavioralModel.model_validate(self.spec) if self.spec else None
        return SimpleNamespace(sources=behavior.sources if behavior else [],pending_questions=[],
                               analysis=SimpleNamespace(subject="Saved reply",behavior=behavior),status="ready")


def test_agent_persists_version_and_replays_without_rerun(tmp_path):
    settings = Settings(database_path=tmp_path/"db")
    store = SQLiteStore(settings.database_path)
    store.initialize()
    session, _, spec = setup_model(store)
    analyst = Analyst(spec)
    with TestClient(create_app(settings,checker=FakeChecker(),analyst=analyst)) as client:
        url = f'/api/sessions/{session["id"]}/messages'
        response = client.post(url,json={"text":"Analyze"},headers={"Idempotency-Key":"message"})
        assert response.status_code == 202
        run_id = response.json()["run_id"]
        assert wait_run(client,run_id)["state"] == "completed"
        stream = client.get(f'/api/runs/{run_id}/events').text
        assert 'event: model_proposed' in stream and 'event: run_finished' in stream
        events = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith('data: ')]
        assert [e["event_id"] for e in events] == [1,2,3]
        assert client.get(f'/api/runs/{run_id}/events',headers={"Last-Event-ID":"1"}).text.count('data: ') == 2
        assert client.get(f'/api/runs/{run_id}/events',headers={"Last-Event-ID":"99"}).status_code == 409
        assert client.post(url,json={"text":"Analyze"},headers={"Idempotency-Key":"message"}).json() == response.json()
        assert analyst.calls == 1
        assert len(store.history(session["id"])) == 2
        assert client.get(f'/api/runs/{run_id}').json()["version_id"] is not None
    with TestClient(create_app(settings,checker=FakeChecker(),analyst=analyst)) as client:
        assert client.get(f'/api/runs/{run_id}/events').text == stream


def test_agent_errors_and_session_isolation(tmp_path):
    settings = Settings(database_path=tmp_path/"db")
    analyst = Analyst(fail=True)
    with TestClient(create_app(settings,checker=FakeChecker(),analyst=analyst)) as client:
        sessions = [client.post('/api/sessions',json={"title":str(i)},headers={"Idempotency-Key":str(i)}).json()["id"] for i in range(2)]
        run = client.post(f'/api/sessions/{sessions[0]}/messages',json={"text":"input"},headers={"Idempotency-Key":"m"}).json()
        assert wait_run(client,run["run_id"])["state"] == "failed"
        stream = client.get(f'/api/runs/{run["run_id"]}/events').text
        assert 'event: error' in stream and 'secret' not in stream
        assert client.get(f'/api/sessions/{sessions[1]}').json()["messages"] == []
        assert client.get('/api/runs/missing/events').status_code == 404
