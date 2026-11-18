import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.services import ServiceError
from proveryalka.storage.sqlite import SQLiteStore


def setup_model(store):
    session = store.create_session({"title": "Versions"}, "s")
    spec = json.loads(Path("tests/fixtures/models/order.json").read_text())
    for source in spec["sources"]:
        old_id = source["id"]
        saved = store.create_source(session["id"], {"text": source["text"]}, old_id)
        source.update(saved)
        for requirement in spec["requirements"]:
            for ref in requirement["source_refs"]:
                if ref["source_id"] == old_id:
                    ref["source_id"] = saved["id"]
    model = store.create_model(session["id"], {"name": "Order"}, "m")
    return session, model, spec


@pytest.fixture
def prepared(tmp_path):
    store = SQLiteStore(tmp_path / "db")
    store.initialize()
    return store, *setup_model(store)


def test_versions_are_immutable_and_approval_preserves_spec(prepared):
    store, session, model, spec = prepared
    first = store.create_version(model["id"], {"spec": spec}, "v1")
    spec["name"] = "Changed"
    second = store.create_version(model["id"], {"spec": spec}, "v2")
    assert second["parent_id"] == first["id"]
    assert second["spec_hash"] != first["spec_hash"]
    assert store.get_version(model["id"], 1) == first
    approved = store.approve_version(model["id"], 1)
    assert approved == {**first, "approved": True}
    assert store.approve_version(model["id"], 1) == approved
    restarted = SQLiteStore(store.path)
    restarted.initialize()
    assert restarted.list_versions(model["id"]) == [approved, second]
    assert restarted.list_models(session["id"]) == [model]


def test_concurrent_versions_and_retries(prepared):
    store, _, model, spec = prepared
    def create(n):
        return store.create_version(model["id"], {"spec": spec}, str(n))
    with ThreadPoolExecutor(max_workers=8) as pool:
        versions = list(pool.map(create, range(20)))
    assert sorted(v["number"] for v in versions) == list(range(1,21))
    ordered = store.list_versions(model["id"])
    assert all(b["parent_id"] == a["id"] for a,b in zip(ordered,ordered[1:]))
    with ThreadPoolExecutor(max_workers=8) as pool:
        repeats = list(pool.map(create, [0]*20))
    assert all(v == versions[0] for v in repeats)
    assert len(store.list_versions(model["id"])) == 20
    with pytest.raises(ServiceError) as error:
        store.create_version(model["id"], {"spec": {**spec, "name": "other"}}, "0")
    assert error.value.status == 409


def test_parent_and_source_membership(prepared):
    store, session, model, spec = prepared
    first = store.create_version(model["id"], {"spec": spec}, "first")
    other = store.create_model(session["id"], {"name": "Other"}, "other")
    with pytest.raises(ServiceError):
        store.create_version(other["id"], {"spec": spec, "parent_id": first["id"]}, "v")
    foreign = store.create_session({"title": "Foreign"}, "foreign")
    foreign_model = store.create_model(foreign["id"], {"name": "Foreign"}, "m")
    with pytest.raises(ServiceError):
        store.create_version(foreign_model["id"], {"spec": spec}, "v")
    assert store.list_versions(foreign_model["id"]) == []
    with pytest.raises(ServiceError):
        store.get_version(other["id"], 1)
    spec["sources"][0]["text"] += " injected"
    with pytest.raises(ServiceError):
        store.create_version(model["id"], {"spec": spec}, "tampered")


def test_http_versions(prepared):
    store, session, model, spec = prepared
    with TestClient(create_app(Settings(database_path=store.path))) as client:
        headers = {"Idempotency-Key": "v1"}
        response = client.post(f'/api/models/{model["id"]}/versions', json={"spec": spec}, headers=headers)
        assert response.status_code == 201, response.text
        assert response.json()["spec"]["requirements"] == spec["requirements"]
        assert client.get(f'/api/sessions/{session["id"]}/models').json() == [model]
        assert client.post(f'/api/models/{model["id"]}/versions/1/approve').json()["approved"] is True
        assert client.get(f'/api/models/{model["id"]}/versions/0').status_code == 404
