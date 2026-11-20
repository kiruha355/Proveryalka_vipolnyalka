from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from proveryalka.mcp import LocalAccessPolicy
from proveryalka.mcp.integration import install_mcp
from proveryalka.mcp.__main__ import create_local_app
from proveryalka.services import ServiceError


class MissingBackend:
    def call(self, operation, **kwargs):
        raise ServiceError(404, "NOT_FOUND", "Unknown version")


def test_host_lifespan_mount_and_schema_do_not_replace_http_routes():
    events = []

    @asynccontextmanager
    async def lifespan(app):
        events.append("host_started")
        yield {"owned": True}
        events.append("host_closed")

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    integration = install_mcp(app, MissingBackend(), None, LocalAccessPolicy())
    with pytest.raises(ValueError, match="already installed"):
        install_mcp(app, MissingBackend(), None, LocalAccessPolicy())
    # TestClient peer is explicitly emulated as a real loopback connection for the local policy.
    with TestClient(app, client=("127.0.0.1", 12345), base_url="http://127.0.0.1") as client:
        assert events == ["host_started"]
        assert client.get("/health").json() == {"status": "ok"}
        r = client.post("/mcp", headers={"Accept": "application/json, text/event-stream"}, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
        assert r.status_code == 200 and "mcp-session-id" in r.headers
    assert events == ["host_started", "host_closed"]


def test_policy_environment_is_explicit_and_secret_is_not_in_repr(monkeypatch):
    monkeypatch.setenv("PROVERYALKA_MCP_MODEL_IDS", "model_a, model_b")
    monkeypatch.setenv("PROVERYALKA_MCP_TOOLS", "get_model,check_behavior")
    monkeypatch.setenv("PROVERYALKA_MCP_BEARER_TOKEN", "ephemeral-test-value")
    policy = LocalAccessPolicy.from_env()
    assert policy.model_ids == frozenset({"model_a", "model_b"})
    assert policy.tools == frozenset({"get_model", "check_behavior"})
    assert "ephemeral-test-value" not in repr(policy)
    with pytest.raises(ValueError):
        LocalAccessPolicy(origins=("*",))
    with pytest.raises(ValueError):
        LocalAccessPolicy(max_result_bytes=10)
    monkeypatch.delenv("PROVERYALKA_DATABASE_PATH", raising=False)
    with pytest.raises(ValueError, match="exclusively owned"):
        create_local_app()
