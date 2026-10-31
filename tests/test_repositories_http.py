"""Изолированный testapp с настоящим ApplicationBackend/run_analyst, SQLite и роутером #46.

Подменены network transport (real local Git blobs) и generate_state (LLM).
Это deterministic API/pipeline evidence, а не provider/browser E2E.
"""
import copy
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from proveryalka.agent import dialogue
from proveryalka.agent.clarification import DialogueDraft, build_state
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from test_repositories import GitFixture, REMOTE, selection


CASE = json.loads((Path(__file__).parent / "fixtures/formal_cases.json").read_text())[0]


@pytest.fixture
def web(tmp_path, monkeypatch):
    repo = GitFixture(tmp_path / "git")
    repo.write("requirements.md", CASE["source"]["text"])
    repo.write("unselected.py", "UNSELECTED_SENTINEL\n")
    repo.commit()
    captured = []

    async def generate(payload, sources, previous, question_id, max_rounds):
        captured.append(copy.deepcopy(payload))
        analysis = copy.deepcopy(CASE["draft"])
        for requirement in analysis["requirements"]:
            requirement["source_id"] = sources[0].id
            requirement["previous_id"] = None
        candidate = DialogueDraft(analysis=analysis, questions=[], resolutions=[], corrections=[], reply="Модель подготовлена")
        return build_state(sources, candidate, previous, question_id, max_rounds)

    monkeypatch.setattr(dialogue, "generate_state", generate)
    app = create_app(settings=Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", check_cache_path=None),
                     codegen_sandbox=object())  # Этот сценарий не запускает Docker/cleanup вообще.
    backend = app.state.backend
    service = app.state.repositories
    service.transport = repo
    with TestClient(app) as client:
        session = client.post("/api/sessions", json={"title": "Repository"}, headers={"Idempotency-Key": "session"}).json()["id"]
        yield client, session, service, captured


def post(client, url, body, key):
    return client.post(url, json=body, headers={"Idempotency-Key": key})


def test_http_import_select_analyze_existing_pipeline(web):
    client, session, service, captured = web
    url = f"/api/sessions/{session}/repositories"
    response = post(client, url, {"remote_url": REMOTE}, "import")
    assert response.status_code == 201, response.text
    snapshot = response.json()
    assert snapshot == post(client, url, {"remote_url": REMOTE}, "import").json()
    assert client.get(url).json() == [snapshot]
    assert client.get(url + "/" + snapshot["id"]).json() == snapshot
    assert "text" not in snapshot["files"][0]
    body = selection(snapshot, "requirements.md", 1, len(CASE["source"]["text"].splitlines()))
    run_response = post(client, url + "/" + snapshot["id"] + "/analysis", body, "analysis")
    assert run_response.status_code == 202, run_response.text
    run = run_response.json()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.get("/api/runs/" + run["run_id"]).json()
        if result["state"] in ("completed", "failed"):
            break
        time.sleep(0.01)
    assert result["state"] == "completed", result
    assert len(captured) == 1
    payload = json.dumps(captured[0], ensure_ascii=False)
    assert "UNSELECTED_SENTINEL" not in payload
    assert snapshot["commit_sha"] in payload
    assert "requirements.md" in payload
    view = client.get(f"/api/sessions/{session}/dialogue").json()
    assert view["requirements"]
    for requirement in view["requirements"]:
        assert requirement["source_refs"]
    # Same request reuses the same durable run/source, no repeated inference.
    assert post(client, url + "/" + snapshot["id"] + "/analysis", body, "analysis").json()["run_id"] == run["run_id"]
    assert len(captured) == 1
    with service.store.transaction() as conn:
        assert conn.execute("SELECT count(*) FROM repository_source_contexts").fetchone()[0] == 1


def test_http_rejects_hostpaths_client_text_and_cross_session(web):
    client, session, service, captured = web
    url = f"/api/sessions/{session}/repositories"
    response = post(client, url, {"remote_url": "/etc/passwd"}, "path")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REPOSITORY_URL_DENIED"
    response = post(client, url, {"remote_url": REMOTE, "transport": "local", "host_path": "/etc"}, "local")
    assert response.status_code == 422
    assert "/etc" not in response.text
    snapshot = post(client, url, {"remote_url": REMOTE}, "import").json()
    body = selection(snapshot, "requirements.md", 1, 1)
    body["files"][0]["text"] = "injected client text"
    response = post(client, url + "/" + snapshot["id"] + "/analysis", body, "analysis")
    assert response.status_code == 422
    assert "injected client text" not in response.text
    response = post(client, f"/api/sessions/missing/repositories/{snapshot['id']}/context",
                    selection(snapshot, "requirements.md", 1, 1), "other")
    assert response.status_code == 404
    assert captured == []


def test_http_openapi_and_credential_status(web):
    client, session, service, captured = web
    schema = client.get("/openapi.json").json()
    assert "RepositorySelection" in schema["components"]["schemas"]
    selection_schema = schema["components"]["schemas"]["RepositorySelection"]
    assert selection_schema["additionalProperties"] is False
    from proveryalka.sources.repositories.transport import GitHubArchiveTransport
    service.transport = GitHubArchiveTransport()
    response = post(client, f"/api/sessions/{session}/repositories",
                    {"remote_url": REMOTE, "credential_ref": "configured-reference-missing"}, "private")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "REPOSITORY_CREDENTIAL_UNAVAILABLE"
    assert captured == []
