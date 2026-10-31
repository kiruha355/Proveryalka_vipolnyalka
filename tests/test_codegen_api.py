"""HTTP-контракт генерации и запусков тестов: APIRouter поверх настоящего приложения и SQLite.

Песочница здесь подменена: тесты Docker находятся в test_codegen_sandbox.py.
"""
import asyncio
import hashlib
import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from proveryalka.api.app import create_app
from proveryalka.api.codegen import create_codegen_router
from proveryalka.codegen.settings import CodegenSettings
from proveryalka.config import Settings
from proveryalka.services import ServiceError
from proveryalka.storage.sqlite import SQLiteStore
from proveryalka.verification.contracts import CheckLimits, VerificationReport
from test_check_api import FakeChecker


MODELS = Path(__file__).parent / "fixtures" / "models"
TERMINAL = {"passed", "failed", "timeout", "engine_unavailable", "cancelled", "error"}
ORDER_BUG_TRACE = [
    {"number": 0, "transition_id": None, "state": {"status": "Created", "approved": False, "cancelled": False}},
    {"number": 1, "transition_id": "Approve", "state": {"status": "Approved", "approved": True, "cancelled": False}},
    {"number": 2, "transition_id": "Cancel", "state": {"status": "Cancelled", "approved": True, "cancelled": True}},
    {"number": 3, "transition_id": "Execute", "state": {"status": "Executed", "approved": True, "cancelled": True}},
]


class FakeSandbox:
    """Записывает переданные файлы; по умолчанию сразу «проходит», с gate — ждёт отмены."""

    def __init__(self, status="passed", gate=False):
        self.status = status
        self.gate = gate
        self.calls = []

    def policy(self):
        return {"engine": "fake", "image": "fake", "network": "none", "read_only_root": True, "user": "10001:10001",
                "capabilities": [], "no_new_privileges": True, "memory_mb": 512, "swap_mb": 0, "cpus": 1.0,
                "pids_limit": 128, "tmpfs_mb": 64, "project_mount": "read-only"}

    async def probe(self):
        return {"engine_version": "fake", "image_id": "sha256:fake"}

    async def run(self, files, *, run_id, timeout_seconds, stop=None):
        self.calls.append({"run_id": run_id, "files": dict(files), "timeout": timeout_seconds})
        if self.gate:
            await stop.wait()
            status, code = "cancelled", "CANCELLED"
        else:
            await asyncio.sleep(0.01)
            status, code = self.status, None if self.status == "passed" else "TESTS_FAILED"
        counts = {"total": 3, "passed": 3 if status == "passed" else 2, "failed": 0 if status == "passed" else 1, "errors": 0, "skipped": 0}
        if status == "cancelled":
            counts = {"total": None, "passed": None, "failed": None, "errors": None, "skipped": None}
        return {"status": status, "error_code": code, "message": status, "exit_code": 0 if status == "passed" else None,
                "counts": counts, "cases": [{"name": "test_x", "classname": "tests.test_x", "outcome": "passed", "duration_seconds": 0.01, "message": None}],
                "duration_seconds": 0.01, "sandbox": {**self.policy(), "engine_version": "fake"}, "log_truncated": False}, "pytest output\n"


def build(tmp_path, sandbox=None, **codegen):
    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", check_cache_path=None)
    app = create_app(settings, checker=FakeChecker())
    router = create_codegen_router(app.state.backend.store, CodegenSettings(image="img:test", **codegen), sandbox or FakeSandbox())
    app.include_router(router)
    return app, router.codegen


def add_version(store, fixture="order_fixed", approve=True):
    """Сессия, источник и версия модели из fixture через штатные методы хранилища."""
    spec = json.loads((MODELS / f"{fixture}.json").read_text(encoding="utf-8"))
    session = store.create_session({"title": fixture}, f"s-{fixture}")
    source = store.create_source(session["id"], {"text": spec["sources"][0]["text"]}, f"src-{fixture}")
    spec["sources"] = [source]
    for requirement in spec["requirements"]:
        for ref in requirement["source_refs"]:
            ref["source_id"] = source["id"]
    model = store.create_model(session["id"], {"name": fixture}, f"m-{fixture}")
    version = store.create_version(model["id"], {"spec": spec}, "v1")
    if approve:
        version = store.approve_version(model["id"], 1)
    return session, model, version


def complete_check(store, model_id, number, statuses, traces=None):
    """Завершённая проверка через штатный путь хранилища (create_check → claim → finish_check)."""
    run = store.create_check(model_id, number, {"property_ids": None, "limits": None}, f"check-{time.monotonic_ns()}")
    store.claim_run(run["run_id"])
    version = store.get_version(model_id, number)
    results = []
    for prop in version["spec"]["properties"]:
        status = statuses[prop["id"]]
        conclusive = status in ("PROPERTY_HOLDS", "PROPERTY_VIOLATED")
        results.append({"spec_hash": version["spec_hash"], "version_id": version["id"], "mode": "engine", "executed": True,
                        "engine": {"name": "TLC", "version": "test"}, "limits": CheckLimits().model_dump(),
                        "property_id": prop["id"], "status": status, "conclusive": conclusive, "message": status,
                        "trace": (traces or {}).get(prop["id"], []) if conclusive else []})
    store.finish_check(run["run_id"], VerificationReport.model_validate({"results": results}))
    return run["run_id"]


def wait(client, test_run_id):
    for _ in range(500):
        run = client.get(f"/api/test-runs/{test_run_id}").json()
        if run["status"] in TERMINAL:
            return run
        time.sleep(0.01)
    pytest.fail("Test run did not finish")


def generate(client, model_id, body=None, key="g1", number=1):
    return client.post(f"/api/models/{model_id}/versions/{number}/generations", json=body if body is not None else {}, headers={"Idempotency-Key": key})


HOLDS = {"NoCancelledExecution": "PROPERTY_HOLDS", "CanExecute": "PROPERTY_HOLDS", "EndsProperly": "PROPERTY_HOLDS"}


def test_generation_requires_approved_version_and_verified_or_acknowledged(tmp_path):
    app, _ = build(tmp_path)
    store = app.state.backend.store
    store.initialize()
    _, model, version = add_version(store, approve=False)
    with TestClient(app) as client:
        response = generate(client, model["id"])
        assert response.status_code == 409 and response.json()["error"]["code"] == "VERSION_NOT_APPROVED"
        store.approve_version(model["id"], 1)
        response = generate(client, model["id"], key="g2")
        assert response.status_code == 409
        error = response.json()["error"]
        assert error["code"] == "VERIFICATION_REQUIRED"
        assert {d["property_id"]: d["status"] for d in error["details"]} == {p: None for p in HOLDS}
        response = generate(client, model["id"], {"allow_unverified": True}, key="g3")
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["verification"]["state"] == "not_checked" and body["verification"]["acknowledged"] is True
        assert body["version_id"] == version["id"] and body["spec_hash"] == version["spec_hash"]
        readme = client.get(f"/api/generations/{body['generation_id']}/files/README.md").text
        assert "нет завершённой проверки TLC" in readme


def test_holds_generation_files_archive_and_idempotency(tmp_path):
    app, service = build(tmp_path)
    store = app.state.backend.store
    store.initialize()
    session, model, version = add_version(store)
    check_id = complete_check(store, model["id"], 1, HOLDS, {"CanExecute": ORDER_BUG_TRACE[:2] + [
        {"number": 2, "transition_id": "Execute", "state": {"status": "Executed", "approved": True, "cancelled": False}}]})
    with TestClient(app) as client:
        response = generate(client, model["id"], None)
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["status"] == "completed" and body["target"] == "python-fastapi"
        assert body["verification"] == {"state": "holds", "acknowledged": False, "properties": [
            {"property_id": p, "status": "PROPERTY_HOLDS", "check_run_id": check_id} for p in HOLDS]}
        assert body["coverage"]["trace_replays"] == 1 and body["coverage"]["exhaustive"] is True
        assert body["file_count"] == len(body["files"]) and body["total_bytes"] == sum(f["size"] for f in body["files"])
        generation_id = body["generation_id"]
        assert generate(client, model["id"], None).json() == body
        assert generate(client, model["id"], {"allow_unverified": True}).json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
        again = generate(client, model["id"], None, key="g2").json()
        assert again["generation_id"] != generation_id and again["code_hash"] == body["code_hash"]

        files = client.get(f"/api/generations/{generation_id}/files").json()
        assert files == body["files"]
        paths = {f["path"] for f in files}
        assert {"README.md", "GENERATION.json", "app/rules.py", "app/api.py", "tests/test_transitions.py", "tests/test_traces.py",
                "requirements.txt", "model/behavioral_model.json"} <= paths
        rules = next(f for f in files if f["path"] == "app/rules.py")
        assert [e["id"] for e in rules["elements"]] == ["Approve", "Cancel", "Execute"]
        for entry in files:
            response = client.get(f"/api/generations/{generation_id}/files/{entry['path']}")
            assert response.status_code == 200
            assert hashlib.sha256(response.content).hexdigest() == entry["sha256"] == response.headers["X-Content-SHA256"]
            assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert json.loads(client.get(f"/api/generations/{generation_id}/files/model/behavioral_model.json").content) == version["spec"]
        # Клиент нормализует буквальные «..» в URL; закодированные точки доходят до сервера как есть.
        for bad in ["missing.py", "../db", "%2e%2e/db", "app/%2e%2e/README.md", "app/%2E%2E/README.md", "app%2F..%2FREADME.md", ".env"]:
            response = client.get(f"/api/generations/{generation_id}/files/{bad}")
            assert response.status_code == 404 and response.json()["error"]["code"] in ("FILE_NOT_FOUND", "HTTP_ERROR"), bad

        for bad in ["app/../README.md", "/etc/passwd", "app\\rules.py"]:
            with pytest.raises(ServiceError) as error:
                service.file(generation_id, bad)
            assert error.value.status == 404

        archive = client.get(f"/api/generations/{generation_id}/archive")
        assert archive.status_code == 200 and archive.headers["content-type"] == "application/zip"
        assert archive.headers["X-Code-Hash"] == body["code_hash"]
        assert f'{body["project_name"]}-{generation_id}.zip' in archive.headers["content-disposition"]
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert sorted(bundle.namelist()) == sorted(f"{body['project_name']}/{p}" for p in paths)
            for entry in files:
                assert hashlib.sha256(bundle.read(f"{body['project_name']}/{entry['path']}")).hexdigest() == entry["sha256"]

        assert [g["generation_id"] for g in client.get(f"/api/models/{model['id']}/versions/1/generations").json()] == [generation_id, again["generation_id"]]
        assert len(client.get(f"/api/sessions/{session['id']}/generations").json()) == 2
        assert client.get("/api/generations/missing").status_code == 404
        assert client.get(f"/api/models/{model['id']}/versions/9/generations").status_code == 404
        assert client.post(f"/api/models/{model['id']}/versions/1/generations", json={"target": "java"}, headers={"Idempotency-Key": "x"}).status_code == 422
        assert client.post(f"/api/models/{model['id']}/versions/1/generations", json={}).status_code == 422
        paths_in_openapi = client.get("/openapi.json").json()["paths"]
        assert "/api/generations/{generation_id}/archive" in paths_in_openapi and "/api/test-runs/{test_run_id}/cancel" in paths_in_openapi


def test_violated_model_requires_acknowledgement_and_is_not_reported_as_holds(tmp_path):
    app, _ = build(tmp_path)
    store = app.state.backend.store
    store.initialize()
    _, model, version = add_version(store, fixture="order_bug")
    statuses = {"NoCancelledExecution": "PROPERTY_VIOLATED", "CanExecute": "PROPERTY_HOLDS", "EndsProperly": "PROPERTY_HOLDS"}
    complete_check(store, model["id"], 1, {p: "TIMEOUT" for p in statuses})
    check_id = complete_check(store, model["id"], 1, statuses, {"NoCancelledExecution": ORDER_BUG_TRACE})
    with TestClient(app) as client:
        response = generate(client, model["id"])
        assert response.status_code == 409
        assert {d["property_id"]: d["status"] for d in response.json()["error"]["details"]} == statuses
        response = generate(client, model["id"], {"allow_unverified": True}, key="ack")
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["verification"]["state"] == "violated" and body["verification"]["acknowledged"] is True
        assert {p["property_id"]: (p["status"], p["check_run_id"]) for p in body["verification"]["properties"]} == {p: (s, check_id) for p, s in statuses.items()}
        spec = json.loads(client.get(f"/api/generations/{body['generation_id']}/files/model/behavioral_model.json").content)
        assert spec == version["spec"]
        data = json.loads(client.get(f"/api/generations/{body['generation_id']}/files/tests/data/conformance.json").content)
        assert data["traces"][0]["property_id"] == "NoCancelledExecution" and data["traces"][0]["status"] == "PROPERTY_VIOLATED"
        assert "PROPERTY_HOLDS" not in json.dumps([p for p in body["verification"]["properties"] if p["property_id"] == "NoCancelledExecution"])


def test_integrity_and_unsupported_models_are_rejected(tmp_path):
    app, _ = build(tmp_path)
    store = app.state.backend.store
    store.initialize()
    _, model, version = add_version(store)
    with TestClient(app) as client:
        body = generate(client, model["id"], {"allow_unverified": True}).json()
        with store.transaction(write=True) as connection:
            connection.execute("UPDATE codegen_files SET content=? WHERE generation_id=? AND path='app/rules.py'", (b"import os\n", body["generation_id"]))
        response = client.get(f"/api/generations/{body['generation_id']}/files/app/rules.py")
        assert response.status_code == 409 and response.json()["error"]["code"] == "INTEGRITY_MISMATCH"
        assert client.get(f"/api/generations/{body['generation_id']}/archive").json()["error"]["code"] == "INTEGRITY_MISMATCH"
        run = client.post(f"/api/generations/{body['generation_id']}/test-runs", json={}, headers={"Idempotency-Key": "t"}).json()
        assert wait(client, run["test_run_id"])["error_code"] == "INTEGRITY_MISMATCH"
        with store.transaction(write=True) as connection:
            connection.execute("UPDATE model_versions SET spec_hash=? WHERE id=?", ("0" * 64, version["id"]))
        assert generate(client, model["id"], {"allow_unverified": True}, key="h").json()["error"]["code"] == "SPEC_HASH_MISMATCH"

        spec = json.loads(json.dumps(version["spec"]))
        spec["variables"] += [{"id": f"v{i}", "name": "x", "requirement_ids": ["R1"], "domain": {"kind": "boolean"}, "initial_value": False} for i in range(128)]
        store.create_version(model["id"], {"spec": spec}, "big")
        store.approve_version(model["id"], 2)
        response = generate(client, model["id"], {"allow_unverified": True}, key="big", number=2)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "UNSUPPORTED_MODEL"
        assert response.json()["error"]["details"][0]["path"] == "variables"


def test_test_run_lifecycle_counts_logs_and_cancel(tmp_path):
    sandbox = FakeSandbox()
    app, service = build(tmp_path, sandbox, parallel=1, max_pending=3)
    store = app.state.backend.store
    store.initialize()
    _, model, _ = add_version(store)
    with TestClient(app) as client:
        generation = generate(client, model["id"], {"allow_unverified": True}).json()
        url = f"/api/generations/{generation['generation_id']}/test-runs"
        response = client.post(url, json={"timeout_seconds": 30}, headers={"Idempotency-Key": "t1"})
        assert response.status_code == 202 and response.json()["status"] in ("queued", "running")
        assert response.json()["counts"] == {"total": None, "passed": None, "failed": None, "errors": None, "skipped": None}
        run = wait(client, response.json()["test_run_id"])
        assert run["status"] == "passed" and run["counts"]["passed"] == 3
        assert (run["version_id"], run["spec_hash"], run["code_hash"]) == (generation["version_id"], generation["spec_hash"], generation["code_hash"])
        assert run["timeout_seconds"] == 30 and run["started_at"] and run["finished_at"] and run["log_available"]
        assert client.get(f"/api/test-runs/{run['test_run_id']}/log").text == "pytest output\n"
        sent = sandbox.calls[0]["files"]
        assert {f["path"]: f["sha256"] for f in generation["files"]} == {p: hashlib.sha256(c).hexdigest() for p, c in sent.items()}
        assert client.post(url, json={"timeout_seconds": 30}, headers={"Idempotency-Key": "t1"}).json()["test_run_id"] == run["test_run_id"]
        assert client.post(url, json={"timeout_seconds": 9999}, headers={"Idempotency-Key": "t2"}).status_code == 422

        sandbox.gate = True
        running = client.post(url, json={}, headers={"Idempotency-Key": "t3"}).json()
        queued = client.post(url, json={}, headers={"Idempotency-Key": "t4"}).json()
        for _ in range(200):
            if client.get(f"/api/test-runs/{running['test_run_id']}").json()["status"] == "running":
                break
            time.sleep(0.01)
        assert client.post(url, json={}, headers={"Idempotency-Key": "t5"}).status_code == 202
        assert client.post(url, json={}, headers={"Idempotency-Key": "t6"}).json()["error"]["code"] == "QUEUE_FULL"
        cancelled = client.post(f"/api/test-runs/{queued['test_run_id']}/cancel").json()
        assert cancelled["status"] == "cancelled" and cancelled["error_code"] == "CANCELLED"
        assert client.get(f"/api/test-runs/{queued['test_run_id']}/log").status_code == 404
        response = client.post(f"/api/test-runs/{running['test_run_id']}/cancel")
        assert response.status_code == 202 and response.json()["cancel_requested"] is True
        stopped = wait(client, running["test_run_id"])
        assert stopped["status"] == "cancelled" and stopped["counts"]["total"] is None
        assert [r["test_run_id"] for r in client.get(url).json()][:3] == [run["test_run_id"], running["test_run_id"], queued["test_run_id"]]
        assert client.get("/api/test-runs/missing").status_code == 404
    with SQLiteStore(tmp_path / "db").transaction() as connection:
        rows = {row["status"]: row["error_code"] for row in connection.execute("SELECT status,error_code FROM codegen_test_runs WHERE test_run_id NOT IN (?,?,?)",
                                                                              (run["test_run_id"], running["test_run_id"], queued["test_run_id"]))}
    assert rows == {"cancelled": "SERVER_SHUTDOWN"}


def test_restart_marks_unfinished_runs_and_unavailable_engine_is_reported(tmp_path):
    from proveryalka.codegen.sandbox import DockerSandbox
    sandbox = DockerSandbox(CodegenSettings(docker=str(tmp_path / "no-docker"), image="img:test"))
    app, _ = build(tmp_path, sandbox)
    store = app.state.backend.store
    store.initialize()
    _, model, _ = add_version(store)
    with TestClient(app) as client:
        generation = generate(client, model["id"], {"allow_unverified": True}).json()
        status = client.get("/api/codegen/status").json()
        assert status["sandbox_status"] == "engine_unavailable" and "Docker CLI unavailable" in status["sandbox_reason"]
        assert status["sandbox"]["network"] == "none" and status["target"] == "python-fastapi"
        run = client.post(f"/api/generations/{generation['generation_id']}/test-runs", json={}, headers={"Idempotency-Key": "t"}).json()
        run = wait(client, run["test_run_id"])
        assert run["status"] == "engine_unavailable" and run["error_code"] == "ENGINE_UNAVAILABLE"
        assert run["counts"] == {"total": None, "passed": None, "failed": None, "errors": None, "skipped": None}
        with store.transaction(write=True) as connection:
            connection.execute("INSERT INTO codegen_test_runs(test_run_id,generation_id,session_id,status,timeout_seconds,created_at) VALUES ('trun_stale',?,?,'running',5,'2026-10-31')",
                               (generation["generation_id"], generation["session_id"]))
    app, _ = build(tmp_path, FakeSandbox())
    with TestClient(app) as client:
        stale = client.get("/api/test-runs/trun_stale").json()
        assert stale["status"] == "error" and stale["error_code"] == "SERVER_RESTARTED"
