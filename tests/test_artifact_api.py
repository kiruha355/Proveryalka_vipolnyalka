import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.checker.artifacts import RunBundle
from proveryalka.verification.checker import incomplete_report
from proveryalka.verification.contracts import VerificationRequest
from test_check_api import prepared, FakeChecker


def bundle_for(settings, store, model):
    run = store.create_check(model["id"], 1, {}, "check")
    row = store.claim_run(run["run_id"])
    request = VerificationRequest.model_validate_json(row["request_json"])
    bundle = RunBundle(settings.artifacts_path/"checks", run["run_id"]).create()
    bundle.write("logs/tlc.out", "TLC log")
    bundle.write("Spec.tla", "spec")
    store.finish_check(run["run_id"], incomplete_report(request,"ENGINE_ERROR","Error",False), True)
    version = store.get_version(model["id"],1)
    bundle.finish({"version_id": version["id"], "spec_hash": version["spec_hash"]})
    return run, bundle


def test_only_manifest_files_and_safe_paths(prepared):
    settings, store, model, version = prepared
    run, bundle = bundle_for(settings, store, model)
    bundle.write("secret", "not in manifest")
    with TestClient(create_app(settings,checker=FakeChecker())) as client:
        base = f'/api/checks/{run["run_id"]}/artifacts'
        assert len(client.get(base).json()) == 2
        assert client.get(base+"/logs/tlc.out").content == b"TLC log"
        for name in ("secret", "unknown", "%2e%2e/secret", "%2Fetc/passwd", "other-run/Spec.tla"):
            assert client.get(base+"/"+name).status_code == 404
        bundle.file("Spec.tla").write_text("tampered")
        assert client.get(base+"/Spec.tla").status_code == 404
        bundle.file("logs/tlc.out").unlink()
        assert client.get(base+"/logs/tlc.out").status_code == 404


def test_foreign_bundle_and_symlink_are_rejected(prepared, tmp_path):
    settings, store, model, _ = prepared
    run, bundle = bundle_for(settings, store, model)
    manifest = bundle.manifest()
    manifest["version_id"] = "foreign"
    bundle.file("manifest.json").write_text(json.dumps(manifest))
    with TestClient(create_app(settings,checker=FakeChecker())) as client:
        url = f'/api/checks/{run["run_id"]}/artifacts/Spec.tla'
        assert client.get(url).status_code == 404
        manifest["version_id"] = store.get_version(model["id"],1)["id"]
        bundle.file("manifest.json").write_text(json.dumps(manifest))
        target = tmp_path/"outside"
        target.write_text("spec")
        bundle.file("Spec.tla").unlink()
        (bundle.path/"Spec.tla").symlink_to(target)
        assert client.get(url).status_code == 404


def test_pending_and_missing_bundle(prepared):
    settings, store, model, _ = prepared
    with TestClient(create_app(settings,checker=FakeChecker())) as client:
        run = store.create_check(model["id"],1,{},"pending")
        url = f'/api/checks/{run["run_id"]}/artifacts'
        assert client.get(url).status_code == 409
        store.fail_run(run["run_id"],"test")
        assert client.get(url).status_code == 404
        assert client.get('/api/checks/missing/artifacts').status_code == 404
