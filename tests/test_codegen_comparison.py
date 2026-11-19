import hashlib

import pytest
from fastapi.testclient import TestClient

from proveryalka.api.app import create_app
from proveryalka.codegen.settings import CodegenSettings
from proveryalka.config import Settings
from proveryalka.sources.repositories.index import manifest_hash
from proveryalka.sources.repositories.policy import POLICY_VERSION
from proveryalka.storage.repositories import RepositoryStore

from test_codegen_api import add_version, generate, wait
from test_codegen_sandbox import pytestmark


def save_snapshot(store, session_id, candidate):
    url = "https://github.com/example/project"
    commit = "b" * 40
    files = [{"path": path, "size_bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
             for path, raw in sorted(candidate.items())]
    digest = manifest_hash(url, commit, files, {})
    return RepositoryStore(store).save(session_id, {}, digest, {
        "remote_url": url, "commit_sha": commit, "manifest_sha256": digest, "parent_snapshot_id": None,
        "files": files, "excluded": {}, "policy_version": POLICY_VERSION,
    }, {path: content.decode("utf-8") for path, content in candidate.items()})


@pytest.mark.parametrize(("mutation", "expected"), [
    ("correct", "matches"),
    ("guard", "mismatch"),
    ("effect", "mismatch"),
    ("unchanged", "mismatch"),
    ("adapter", "incompatible_adapter"),
    ("runtime", "execution_error"),
])
def test_snapshot_comparison_uses_model_cases_in_docker(tmp_path, mutation, expected):
    app = create_app(Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts"),
                     codegen_settings=CodegenSettings())
    store = app.state.backend.store
    with TestClient(app) as client:
        session, model, version = add_version(store)
        generation = generate(client, model["id"], {"allow_unverified": True}).json()
        _, files = app.state.codegen.repo.project(generation["generation_id"])
        candidate = {item.path: item.content for item in files if item.path.startswith("app/")}
        # The snapshot's tests and pytest configuration must have no effect.
        candidate["tests/test_transitions.py"] = b"raise RuntimeError('candidate tests were loaded')\n"
        candidate["pytest.ini"] = b"[pytest]\naddopts=--nonexistent-option\n"
        engine = candidate["app/engine.py"]
        rules = candidate["app/rules.py"]
        if mutation == "guard":
            assert b"if not rule.guard(current):" in engine
            candidate["app/engine.py"] = engine.replace(b"if not rule.guard(current):", b"if False:")
        elif mutation == "effect":
            assert b"'approved': False," in rules
            candidate["app/rules.py"] = rules.replace(b"'approved': False,", b"'approved': True,", 1)
        elif mutation == "unchanged":
            candidate["app/engine.py"] = engine.replace(b"    try:\n        return check_state(following)",
                                                        b"    following['cancelled'] = not following['cancelled']\n"
                                                        b"    try:\n        return check_state(following)")
        elif mutation == "runtime":
            candidate["app/engine.py"] = engine.replace(b"    following = ", b"    raise RuntimeError('failure')\n    following = ")
        saved = save_snapshot(store, session["id"], candidate)
        endpoint = f"/api/generations/{generation['generation_id']}/comparisons"
        body = {"snapshot_id": saved["id"], "manifest_sha256": saved["manifest_sha256"],
                "reference_code_hash": generation["code_hash"],
                "adapter": {"kind": "fastapi-evaluate-v1", "module": "app.api",
                            "api_prefix": "/missing" if mutation == "adapter" else ""}}
        response = client.post(endpoint, json=body, headers={"Idempotency-Key": "comparison"})
        assert response.status_code == 202, response.text
        run = wait(client, response.json()["test_run_id"])
        assert client.get(endpoint).json() == [run]
        assert client.get(f"/api/generations/{generation['generation_id']}/test-runs").json() == []
        result = run["comparison"]
        assert result["status"] == expected, run
        assert run["spec_hash"] == version["spec_hash"]
        assert run["code_hash"] != generation["code_hash"]
        assert result["reference_code_hash"] == generation["code_hash"]
        assert result["commit_sha"] == saved["commit_sha"]
        assert len(result["tests_hash"]) == 64
        if expected == "mismatch":
            assert any(case["transition_id"] and case["requirement_ids"] for case in result["differences"])
