"""End-to-end HTTP + SQLite + real SANY/TLC, no LLM credentials required."""
import json
import os
from pathlib import Path
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from test_check_api import wait_run
from test_checker_tlc import PROBLEM, JAVA, JAR

pytestmark = pytest.mark.skipif(PROBLEM is not None,reason=f"TLC unavailable: {PROBLEM}")


@pytest.mark.parametrize("name,status", [("order_bug","PROPERTY_VIOLATED"),("order_fixed","PROPERTY_HOLDS")])
def test_http_acceptance_persistence_and_artifacts(tmp_path,name,status):
    settings = Settings(database_path=tmp_path/"db",artifacts_path=tmp_path/"artifacts",java_path=JAVA,tla_jar=JAR,check_cache_path=None)
    with TestClient(create_app(settings)) as client:
        assert client.get('/ready').status_code == 200
        headers = {"Idempotency-Key":"session"}
        sid = client.post('/api/sessions',json={"title":name},headers=headers).json()["id"]
        spec = json.loads(Path(f'tests/fixtures/models/{name}.json').read_text())
        for source in spec["sources"]:
            old = source["id"]
            saved = client.post(f'/api/sessions/{sid}/sources',json={"text":source["text"]},headers={"Idempotency-Key":old}).json()
            source.update(saved)
            for req in spec["requirements"]:
                for ref in req["source_refs"]:
                    if ref["source_id"] == old:
                        ref["source_id"] = saved["id"]
        mid = client.post(f'/api/sessions/{sid}/models',json={"name":name},headers=headers).json()["id"]
        version = client.post(f'/api/models/{mid}/versions',json={"spec":spec},headers=headers).json()
        run = client.post(f'/api/models/{mid}/versions/1/checks',json={"property_ids":["NoCancelledExecution"]},headers=headers).json()
        assert wait_run(client,run["run_id"])["state"] == "completed"
        result = client.get(f'/api/checks/{run["run_id"]}').json()
        assert result["results"][0]["status"] == status
        assert result["results"][0]["version_id"] == version["id"]
        assert result["results"][0]["engine"]["name"] == "TLC"
        files = client.get(f'/api/checks/{run["run_id"]}/artifacts').json()
        assert files
        assert client.get(f'/api/checks/{run["run_id"]}/artifacts/report.json').json()["results"][0]["status"] == status
    with TestClient(create_app(settings)) as client:
        assert client.get(f'/api/checks/{run["run_id"]}').json() == result
        assert client.get(f'/api/models/{mid}/versions/1').json() == version
