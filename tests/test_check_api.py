import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.storage.sqlite import SQLiteStore
from proveryalka.verification.checker import incomplete_report
from test_versions import setup_model


class FakeChecker:
    def __init__(self, status="TIMEOUT"):
        self.calls = []
        self.status = status

    async def run(self, request, run_id=None):
        self.calls.append(request)
        await asyncio.sleep(0.03)
        report = incomplete_report(request, self.status, "Controlled failure", True)
        return SimpleNamespace(report=report, directory=None)

    def cancel(self, run_id):
        return False


def wait_run(client, run_id):
    for _ in range(500):
        response = client.get(f"/api/runs/{run_id}")
        if response.json()["state"] in ("completed", "failed", "cancelled"):
            return response.json()
        time.sleep(0.01)
    pytest.fail("Run did not finish")


@pytest.fixture
def prepared(tmp_path):
    settings = Settings(database_path=tmp_path/"db", artifacts_path=tmp_path/"artifacts", check_cache_path=None)
    store = SQLiteStore(settings.database_path)
    store.initialize()
    session, model, spec = setup_model(store)
    version = store.create_version(model["id"], {"spec": spec}, "v")
    return settings, store, model, version


@pytest.mark.parametrize("status", ["TIMEOUT", "STATE_LIMIT_REACHED", "ENGINE_ERROR", "MODEL_INVALID"])
def test_async_checks_preserve_version_limits_and_status(prepared, status):
    settings, store, model, version = prepared
    checker = FakeChecker(status)
    with TestClient(create_app(settings, checker=checker)) as client:
        url = f'/api/models/{model["id"]}/versions/1/checks'
        headers = {"Idempotency-Key": "check"}
        response = client.post(url, json={"limits": {"timeout_seconds": 5.0}}, headers=headers)
        assert response.status_code == 202, response.text
        run_id = response.json()["run_id"]
        assert client.get("/health").status_code == 200
        assert client.post(url, json={"limits": {"timeout_seconds": 5.0}}, headers=headers).json() == response.json()
        assert client.post(url, json={}, headers=headers).status_code == 409
        assert wait_run(client, run_id)["state"] == "completed"
        result = client.get(f"/api/checks/{run_id}").json()
        assert result["run"]["version_id"] == version["id"]
        assert all(x["status"] == status and not x["conclusive"] for x in result["results"])
        assert checker.calls[0].limits.timeout_seconds == 5.0
        assert len(checker.calls) == 1
    assert store.get_check(run_id) == result


def test_invalid_properties_and_missing_versions(prepared):
    settings, _, model, _ = prepared
    with TestClient(create_app(settings, checker=FakeChecker())) as client:
        for ids in [["missing"], ["x", "x"], []]:
            assert client.post(f'/api/models/{model["id"]}/versions/1/checks', json={"property_ids": ids}, headers={"Idempotency-Key":"c"}).status_code == 422
        assert client.post('/api/models/missing/versions/1/checks',json={},headers={"Idempotency-Key":"c"}).status_code == 404
        assert client.get('/api/checks/missing').status_code == 404


def test_parallel_versions_never_mix(prepared):
    settings, store, model, first = prepared
    second = store.create_version(model["id"], {"spec": {**first["spec"], "name": "Second"}}, "second")
    with TestClient(create_app(settings, checker=FakeChecker())) as client:
        ids = [client.post(f'/api/models/{model["id"]}/versions/{n}/checks',json={},headers={"Idempotency-Key":"same"}).json()["run_id"] for n in (1,2)]
        for run_id, version in zip(ids, [first,second]):
            wait_run(client, run_id)
            result = client.get(f'/api/checks/{run_id}').json()
            assert all(x["version_id"] == version["id"] and x["spec_hash"] == version["spec_hash"] for x in result["results"])


def test_restart_marks_unfinished_work_failed(prepared):
    settings, store, model, _ = prepared
    run = store.create_check(model["id"],1,{},"interrupted")
    with TestClient(create_app(settings,checker=FakeChecker())) as client:
        assert client.get(f'/api/runs/{run["run_id"]}').json()["state"] == "failed"
        assert client.get(f'/api/checks/{run["run_id"]}').json()["results"] == []
