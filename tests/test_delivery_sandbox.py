"""Actual TLC → code generation → Docker pytest → durable version/code receipt."""
import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient

from proveryalka.api.app import create_app
from proveryalka.config import Settings
from test_check_api import wait_run
from test_checker_tlc import JAVA, JAR, PROBLEM
from test_codegen_api import add_version, generate
from test_codegen_sandbox import REASON, no_container

pytestmark = [
    pytest.mark.skipif(PROBLEM is not None, reason=f"TLC unavailable: {PROBLEM}"),
    pytest.mark.skipif(REASON is not None and os.getenv("PROVERYALKA_REQUIRE_SANDBOX") != "1", reason=f"Docker unavailable: {REASON}"),
]


def test_tlc_to_sandbox_report_survives_restart_with_exact_version_and_code(tmp_path):
    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", java_path=JAVA, tla_jar=JAR, check_cache_path=None)
    app = create_app(settings)
    app.state.backend.store.initialize()
    session, model, version = add_version(app.state.backend.store)
    with TestClient(app) as client:
        check = client.post(f"/api/models/{model['id']}/versions/1/checks", json={}, headers={"Idempotency-Key": "real-tlc"}).json()
        assert wait_run(client, check["run_id"])["state"] == "completed"
        report = client.get(f"/api/checks/{check['run_id']}").json()
        assert all(r["status"] == "PROPERTY_HOLDS" and r["engine"]["name"] == "TLC" for r in report["results"])
        response = generate(client, model["id"])
        assert response.status_code == 201, response.text
        generation = response.json()
        assert {p["check_run_id"] for p in generation["verification"]["properties"]} == {check["run_id"]}
        manifest = client.get(f"/api/generations/{generation['generation_id']}/files/GENERATION.json").json()
        assert manifest["model"]["version_id"] == version["id"]
        assert manifest["model"]["spec_hash"] == version["spec_hash"]
        run = client.post(f"/api/generations/{generation['generation_id']}/test-runs", json={}, headers={"Idempotency-Key": "docker"}).json()
        # The normal API wait helper has a five second limit; Docker may take longer.
        import time
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            run = client.get(f"/api/test-runs/{run['test_run_id']}").json()
            if run["status"] not in ("queued", "running"):
                break
            time.sleep(0.1)
        log_response = client.get(f"/api/test-runs/{run['test_run_id']}/log")
        log = log_response.content if log_response.status_code == 200 else b"No sandbox log available"
        (tmp_path / "sandbox.log").write_bytes(log)
        (tmp_path / "delivery-receipt.json").write_text(json.dumps({"proof_level": "API+SQLite+TLC+Docker", "generation": generation,
            "test_run": run, "log_sha256": hashlib.sha256(log).hexdigest()}, ensure_ascii=False, indent=2))
        assert run["status"] == "passed", run
        assert run["counts"]["total"] > 20 and run["counts"]["failed"] == run["counts"]["errors"] == 0
        assert run["sandbox"]["image_id"].startswith("sha256:") and run["sandbox"]["network"] == "none"
        assert (run["version_id"], run["spec_hash"], run["code_hash"]) == (version["id"], version["spec_hash"], generation["code_hash"])
        assert b"passed" in log
        assert no_container(run["test_run_id"])
        # A newer version/generation and a different session must not retarget the old receipt.
        spec = {**version["spec"], "name": "Новая версия"}
        new_version = client.post(f"/api/models/{model['id']}/versions", json={"spec": spec}, headers={"Idempotency-Key": "v2"}).json()
        client.post(f"/api/models/{model['id']}/versions/2/approve")
        newer = generate(client, model["id"], {"allow_unverified": True}, key="new-generation", number=2).json()
        assert newer["version_id"] == new_version["id"] != run["version_id"]
        assert newer["code_hash"] != run["code_hash"]
        foreign = client.post("/api/sessions", json={"title": "Другая"}, headers={"Idempotency-Key": "foreign"}).json()
        assert client.get(f"/api/sessions/{foreign['id']}/generations").json() == []
    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/test-runs/{run['test_run_id']}").json() == run
        assert client.get(f"/api/test-runs/{run['test_run_id']}/log").content == log
        assert client.get(f"/api/generations/{generation['generation_id']}").json() == generation
        assert client.get(f"/api/checks/{check['run_id']}").json() == report
        assert client.get(f"/api/generations/{generation['generation_id']}/test-runs").json() == [run]
    (tmp_path / "delivery-receipt.json").write_text(json.dumps({"proof_level": "API+SQLite+TLC+Docker", "generation": generation,
        "test_run": run, "log_sha256": hashlib.sha256(log).hexdigest()}, ensure_ascii=False, indent=2))
