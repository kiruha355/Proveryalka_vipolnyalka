import asyncio
import hashlib
import json

import httpx
import httpx2
from mcp import Client, ClientSession
from mcp.client.streamable_http import streamable_http_client
import pytest

from conftest import running
from proveryalka.mcp.policy import TOOLS, LocalAccessPolicy
from proveryalka.mcp.server import LocalBoundary
from test_codegen_api import FakeSandbox

HEADERS = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"}


def decode(response):
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")][-1]
    return response.json()


async def initialize(client):
    r = await client.post(str(client.base_url).rstrip("/"), json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
    assert r.status_code == 200, r.text
    sid = r.headers["mcp-session-id"]
    client.headers["Mcp-Session-Id"] = sid
    r = await client.post(str(client.base_url).rstrip("/"), json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert r.status_code == 202
    return sid


@pytest.mark.anyio
async def test_real_sdk_initialize_list_call_and_modern_client(tmp_path):
    async with running(tmp_path) as (url, integration, backend, codegen, ref):
        async with streamable_http_client(url) as (read, write):
            async with ClientSession(read, write) as client:
                initialized = await client.initialize()
                assert initialized.protocol_version == "2025-11-25"
                listing = await client.list_tools()
                assert {t.name for t in listing.tools} == TOOLS
                assert all(t.input_schema["additionalProperties"] is False for t in listing.tools)
                assert all(t.output_schema["properties"]["contract_version"]["const"] == "1.0" for t in listing.tools)
                result = await client.call_tool("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}})
                assert not result.is_error
                assert result.structured_content["model_ref"] == ref
                assert result.structured_content["data"]["model"]["approved"] is True
                assert json.loads(result.content[0].text) == result.structured_content
        assert not integration.app.sessions  # SDK DELETE on exit
        async with Client(url) as client:
            result = await client.call_tool("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}})
            assert result.structured_content["model_ref"] == ref
        assert not integration.app.sessions  # modern protocol is sessionless


@pytest.mark.anyio
async def test_policy_auth_origin_host_body_unknown_version_and_sessions(tmp_path):
    token = "ephemeral-test-credential"
    async with running(tmp_path, policy_changes={"bearer_token": token, "max_body_bytes": 2048}) as (url, integration, _, _, _):
        async with httpx.AsyncClient(base_url=url, headers=HEADERS) as client:
            assert (await client.post(str(client.base_url).rstrip("/"), json={})).status_code == 401
            client.headers["Authorization"] = "Bearer wrong"
            assert (await client.post(str(client.base_url).rstrip("/"), json={})).status_code == 401
            client.headers["Authorization"] = "Bearer " + token
            assert (await client.post(str(client.base_url).rstrip("/"), json={}, headers={"Origin": "https://evil.example"})).status_code == 403
            assert (await client.post(str(client.base_url).rstrip("/"), json={}, headers={"Origin": "null"})).status_code == 403
            assert (await client.post(str(client.base_url).rstrip("/"), json={}, headers={"Host": "evil.example"})).status_code == 421
            assert (await client.post(str(client.base_url).rstrip("/"), content=b"x" * 2049)).status_code == 413
            async def chunks():
                yield b"x" * 1024
                yield b"x" * 1025
            assert (await client.post(str(client.base_url).rstrip("/"), content=chunks())).status_code == 413
            assert not integration.app.sessions
            sid = await initialize(client)
            r = await client.post(str(client.base_url).rstrip("/"), json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers={"Mcp-Session-Id": "unknown"})
            assert r.status_code == 404
            r = await client.post(str(client.base_url).rstrip("/"), json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers={"MCP-Protocol-Version": "2025-03-26"})
            assert r.status_code == 400 and r.json()["error"]["code"] == "SESSION_VERSION_MISMATCH"
            assert (await client.delete(str(client.base_url).rstrip("/"))).status_code == 200
            assert sid not in integration.app.sessions
            assert (await client.post(str(client.base_url).rstrip("/"), json={"jsonrpc": "2.0", "id": 3, "method": "tools/list"})).status_code == 404
            del client.headers["Mcp-Session-Id"]
            r = await client.post(str(client.base_url).rstrip("/"), headers={"MCP-Protocol-Version": "1900-01-01", "Mcp-Method": "tools/list"}, json={
                "jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {"_meta": {
                    "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {}}}})
            assert r.status_code == 400
            assert decode(r)["error"]["code"] == -32022, r.text


@pytest.mark.anyio
async def test_sdk_auth_client(tmp_path):
    async with running(tmp_path, policy_changes={"bearer_token": "temporary-test-only"}) as (url, _, _, _, ref):
        async with httpx2.AsyncClient(headers={"Authorization": "Bearer temporary-test-only"}) as http:
            async with streamable_http_client(url, http_client=http) as (read, write):
                async with ClientSession(read, write) as client:
                    await client.initialize()
                    result = await client.call_tool("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}})
                    assert not result.is_error and result.structured_content["model_ref"] == ref


@pytest.mark.anyio
async def test_get_tests_actual_generation_hash_and_unsupported(tmp_path):
    sandbox = FakeSandbox()
    async with running(tmp_path, sandbox=sandbox) as (url, _, backend, codegen, ref):
        generation = codegen.generate(ref["model_id"], 1, {"allow_unverified": True}, "gen1")
        args = {"model": ref, "generation_id": generation["generation_id"], "code_hash": generation["code_hash"]}
        async with Client(url) as client:
            result = await client.call_tool("get_tests", args)
            data = result.structured_content["data"]
            assert not result.is_error and data["files"]
            assert data["tlc_at_generation"]["state"] == "not_checked"
            for item in data["files"]:
                assert hashlib.sha256(item["content"].encode()).hexdigest() == item["sha256"]
                _, stored = codegen.file(generation["generation_id"], item["path"])
                assert stored.decode() == item["content"]
            bad = await client.call_tool("get_tests", {**args, "code_hash": "0" * 64})
            assert bad.is_error and bad.structured_content["error"]["code"] == "GENERATION_REF_MISMATCH"
            bad = await client.call_tool("get_tests", {**args, "model": {**ref, "version_id": "different"}})
            assert bad.is_error and bad.structured_content["error"]["code"] == "MODEL_REF_MISMATCH"
            bad = await client.call_tool("compare_with_code", {**args, "mode": "arbitrary_files"})
            assert bad.is_error and bad.structured_content["status"] == "unsupported"
            assert not sandbox.calls
            # Even consistent generation metadata cannot bypass file integrity verification.
            with backend.store.transaction(write=True) as connection:
                connection.execute("UPDATE codegen_files SET content=? WHERE generation_id=? AND path='tests/test_transitions.py'",
                                   (b"malicious replacement", generation["generation_id"]))
            bad = await client.call_tool("get_tests", args)
            assert bad.is_error and bad.structured_content["error"]["code"] == "INTEGRITY_MISMATCH"


@pytest.mark.anyio
async def test_denied_models_tools_invalid_args_result_limit_and_scope(tmp_path):
    async with running(tmp_path, policy_changes={"tools": frozenset({"get_model"})}) as (url, _, backend, _, ref):
        async with Client(url) as client:
            for name, args, code in [
                ("get_model", {"model": {"model_id": "foreign", "version_number": 1}}, "ACCESS_DENIED"),
                ("get_tests", {"model": ref, "generation_id": "gen", "code_hash": "0" * 64}, "ACCESS_DENIED"),
                ("unknown", {}, "UNKNOWN_TOOL"),
                ("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}, "contract_version": "2.0"}, "INVALID_ARGUMENTS"),
                ("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}, "injection": "secret-test-value"}, "INVALID_ARGUMENTS"),
            ]:
                result = await client.call_tool(name, args)
                assert result.is_error and result.structured_content["error"]["code"] == code
                assert result.structured_content["model_ref"] is None
                assert "secret-test-value" not in str(result)
    async with running(tmp_path / "small", policy_changes={"max_result_bytes": 1024}) as (url, _, _, _, ref):
        async with Client(url) as client:
            result = await client.call_tool("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}})
            assert result.is_error and result.structured_content["error"]["code"] == "RESULT_TOO_LARGE"
            assert result.structured_content["model_ref"] == ref


@pytest.mark.anyio
async def test_remote_peer_denied_even_with_forwarded_loopback():
    async def should_not_run(*args):
        pytest.fail("Boundary was bypassed")
    app = LocalBoundary(should_not_run, LocalAccessPolicy())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.0.2.1", 123)), base_url="http://localhost") as client:
        assert (await client.post("/mcp", headers={"X-Forwarded-For": "127.0.0.1"})).status_code == 403


@pytest.mark.anyio
async def test_body_time_http_parallel_origin_allowlist_and_legacy_session_cap(tmp_path):
    changes = {"body_seconds": 0.15, "max_sessions": 1, "origins": ("http://localhost:4190",)}
    async with running(tmp_path, policy_changes=changes) as (url, integration, _, _, _):
        async with httpx.AsyncClient(base_url=url, headers=HEADERS) as client:
            async def slow():
                yield b"{"
                await asyncio.sleep(0.3)
                yield b"}"
            response = await client.post(url, content=slow())
            assert response.status_code == 408 and response.json()["error"]["code"] == "BODY_TIMEOUT"
            client.headers["Origin"] = "http://localhost:4190"
            await initialize(client)
            async with httpx.AsyncClient(base_url=url, headers=HEADERS) as another:
                response = await another.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "second", "version": "1"}}})
                assert response.status_code == 503
            assert (await client.delete(url)).status_code == 200
    changes = {"body_seconds": 1.0, "max_http_requests": 1}
    async with running(tmp_path / "parallel", policy_changes=changes) as (url, integration, _, _, _):
        async with httpx.AsyncClient(base_url=url, headers=HEADERS) as client:
            async def slow():
                yield b"{"
                await asyncio.sleep(0.4)
                yield b"}"
            pending = asyncio.create_task(client.post(url, content=slow()))
            async with asyncio.timeout(3):
                while integration.app.active == 0:
                    await asyncio.sleep(0.01)
            response = await client.post(url, json={})
            assert response.status_code == 429 and response.json()["error"]["code"] == "HTTP_BUSY"
            await pending
