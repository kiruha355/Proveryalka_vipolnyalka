from fastapi.testclient import TestClient
from pydantic import BaseModel, StrictInt

from proveryalka.app import create_app
from proveryalka.services import ServiceError


class RecordingBackend:
    def __init__(self):
        self.calls = []

    def call(self, operation, **arguments):
        self.calls.append((operation, arguments))
        if operation == "create_session":
            return {"id": "s1", "created_at": "2026-01-01T00:00:00Z", **arguments["body"]}
        raise ServiceError(404, "NOT_FOUND", "Entity not found")


def test_health_and_missing_components_are_honest():
    client = TestClient(create_app())
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/sessions").status_code == 503
    response = client.post("/api/models/m/versions", json={"spec": {}}, headers={"Idempotency-Key": "v1"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "CONTRACT_UNAVAILABLE"


def test_transport_validation_and_idempotency_key_forwarding():
    backend = RecordingBackend()
    client = TestClient(create_app(backend=backend))
    assert client.post("/api/sessions", json={"title": "test"}).status_code == 422
    assert client.post("/api/sessions", json={"title": 123}, headers={"Idempotency-Key": "s1"}).status_code == 422
    response = client.post("/api/sessions", json={"title": "test"}, headers={"Idempotency-Key": "s1"})
    assert response.status_code == 201
    assert backend.calls == [("create_session", {"body": {"title": "test", "mode": "analyzer"}, "key": "s1"})]
    assert client.get("/api/sessions/missing").json()["error"]["code"] == "NOT_FOUND"


def test_shared_contracts_are_referenced_and_validate_requests():
    class SharedModel(BaseModel):
        value: StrictInt

    class SharedResult(BaseModel):
        engine: str

    backend = RecordingBackend()
    client = TestClient(create_app(backend=backend, behavioral_model=SharedModel, verification_result=SharedResult))
    schema = client.get("/openapi.json").json()
    assert schema["components"]["schemas"]["VersionCreate"]["properties"]["spec"]["$ref"].endswith("/SharedModel")
    assert "SharedResult" in schema["components"]["schemas"]
    response = client.post("/api/models/m/versions", json={"spec": {"value": True}}, headers={"Idempotency-Key": "v1"})
    assert response.status_code == 422
    assert not backend.calls


def test_sse_reconnect_and_cancel_contract():
    backend = RecordingBackend()
    client = TestClient(create_app(backend=backend))
    assert client.get("/api/runs/r1/events", headers={"Last-Event-ID": "-1"}).status_code == 422
    client.get("/api/runs/r1/events", headers={"Last-Event-ID": "12"})
    client.post("/api/runs/r1/cancel")
    assert backend.calls == [("events", {"run_id": "r1", "after": 12}), ("cancel_run", {"run_id": "r1"})]


def test_errors_do_not_reflect_request_content():
    client = TestClient(create_app())
    response = client.post("/api/sessions", json={"title": "ok", "secret": "sensitive"}, headers={"Idempotency-Key": "s1"})
    assert response.status_code == 422
    assert "sensitive" not in response.text
    assert "error" in client.get("/unknown").json()
