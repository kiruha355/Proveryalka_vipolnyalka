"""Настоящий MCP SDK transport с ограниченной локальной ASGI boundary."""
import hmac
import ipaddress
import json
import time
from urllib.parse import urlsplit

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import ValidationError
from starlette.responses import JSONResponse

from .dto import CheckBehavior, CompareWithCode, GetModel, GetTests, ToolResult
from .policy import LocalAccessPolicy
from .service import MCPService

SCHEMAS = {"get_model": GetModel, "check_behavior": CheckBehavior, "get_tests": GetTests,
           "compare_with_code": CompareWithCode}
DESCRIPTIONS = {
    "get_model": "Read an explicit immutable model version; approval is reported without changing it.",
    "check_behavior": "Run the existing TLC service for an immutable model reference. Technical statuses stay inconclusive.",
    "get_tests": "Read actual tests of a stored generation pinned by model reference and code_hash; never generates tests implicitly.",
    "compare_with_code": "Run tests of an exact stored generation in the existing Docker executor. Arbitrary code equivalence is unsupported.",
}


class LocalBoundary:
    """No proxy trust. One credential/policy per process, not user/session authorization."""
    def __init__(self, app, policy):
        self.app, self.policy = app, policy
        self.active = 0
        self.sessions = {}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope["headers"]:
            if key in headers and key in {b"host", b"origin", b"authorization", b"mcp-session-id", b"mcp-protocol-version"}:
                return await self.reject(scope, receive, send, 400, "DUPLICATE_HEADER")
            headers[key] = value.decode("latin-1")
        host = headers.get(b"host", "")
        try:
            parsed = urlsplit("//" + host)
            host_ok = (parsed.hostname in self.policy.hosts and parsed.username is None and parsed.password is None
                       and not parsed.path and not parsed.query and not parsed.fragment)
            parsed.port  # validates port syntax/range
        except ValueError:
            host_ok = False
        if not host_ok:
            return await self.reject(scope, receive, send, 421, "HOST_DENIED")
        peer = (scope.get("client") or ("", 0))[0]
        try:
            loopback = ipaddress.ip_address(peer).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            return await self.reject(scope, receive, send, 403, "LOOPBACK_REQUIRED")
        if b"origin" in headers and headers[b"origin"] not in self.policy.origins:
            return await self.reject(scope, receive, send, 403, "ORIGIN_DENIED")
        token = self.policy.bearer_token
        if token is not None and not hmac.compare_digest(headers.get(b"authorization", "").encode(), ("Bearer " + token).encode()):
            return await self.reject(scope, receive, send, 401, "AUTH_REQUIRED")
        if self.active >= self.policy.max_http_requests:
            return await self.reject(scope, receive, send, 429, "HTTP_BUSY")
        now = time.monotonic()
        self.sessions = {k: v for k, v in self.sessions.items() if v[1] > now}
        sid = headers.get(b"mcp-session-id")
        version = headers.get(b"mcp-protocol-version", "2025-03-26")
        if sid in self.sessions:
            if version != self.sessions[sid][0]:
                return await self.reject(scope, receive, send, 400, "SESSION_VERSION_MISMATCH")
            self.sessions[sid] = (version, now + self.policy.session_idle_seconds)
        response_sid, status, body = None, None, bytearray()

        async def capture(message):
            nonlocal response_sid, status
            if message["type"] == "http.response.start":
                status = message["status"]
                response_sid = dict(message["headers"]).get(b"mcp-session-id")
            elif message["type"] == "http.response.body" and response_sid and len(body) < 16384:
                body.extend(message.get("body", b"")[:16384 - len(body)])
                if not message.get("more_body", False):
                    # initialize result in either the SDK's JSON or SSE response.
                    for line in bytes(body).splitlines():
                        try:
                            data = json.loads(line.removeprefix(b"data: "))
                            negotiated = data.get("result", {}).get("protocolVersion")
                            if negotiated and len(self.sessions) < self.policy.max_sessions:
                                self.sessions[response_sid.decode()] = (negotiated, time.monotonic() + self.policy.session_idle_seconds)
                        except (ValueError, AttributeError):
                            pass
            await send(message)

        self.active += 1
        try:
            if scope["method"] == "POST":
                length = headers.get(b"content-length")
                if length is not None and length.isdigit() and int(length) > self.policy.max_body_bytes:
                    return await self.reject(scope, receive, send, 413, "BODY_TOO_LARGE")
                body = bytearray()
                try:
                    with anyio.fail_after(self.policy.body_seconds):
                        while True:
                            message = await receive()
                            if message["type"] == "http.disconnect":
                                return
                            chunk = message.get("body", b"")
                            if len(body) + len(chunk) > self.policy.max_body_bytes:
                                return await self.reject(scope, receive, send, 413, "BODY_TOO_LARGE")
                            body.extend(chunk)
                            if not message.get("more_body", False):
                                break
                except TimeoutError:
                    return await self.reject(scope, receive, send, 408, "BODY_TIMEOUT")
                inbound = bytes(body)
                replayed = False

                async def replay():
                    nonlocal replayed
                    if not replayed:
                        replayed = True
                        return {"type": "http.request", "body": inbound, "more_body": False}
                    return await receive()

                # Response capture uses a different buffer from the inbound request.
                body = bytearray()
                await self.app(scope, replay, capture)
            else:
                await self.app(scope, receive, capture)
        finally:
            self.active -= 1
            if sid and (status == 404 or scope["method"] == "DELETE" and status == 200):
                self.sessions.pop(sid, None)

    @staticmethod
    async def reject(scope, receive, send, status, code):
        headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
        await JSONResponse({"error": {"code": code}}, status_code=status, headers=headers)(scope, receive, send)


class MCPIntegration:
    def __init__(self, backend, codegen=None, policy=None, path="/mcp"):
        self.policy = policy or LocalAccessPolicy()
        self.service = MCPService(backend, codegen, self.policy)

        async def list_tools(context, params):
            return types.ListToolsResult(tools=[types.Tool(
                name=name, description=DESCRIPTIONS[name], inputSchema=SCHEMAS[name].model_json_schema(),
                outputSchema=ToolResult.model_json_schema(),
                annotations=types.ToolAnnotations(readOnlyHint=name in {"get_model", "get_tests"},
                                                  destructiveHint=False, openWorldHint=False),
            ) for name in sorted(self.policy.tools)])

        async def call_tool(context, params):
            if params.name not in SCHEMAS:
                result = self.service.result(None, "unsupported", error={"code": "UNKNOWN_TOOL", "message": "Unknown tool"})
            else:
                try:
                    request = SCHEMAS[params.name].model_validate(params.arguments or {})
                except ValidationError:
                    # Do not reflect untrusted inputs, source text or potential credentials in errors.
                    result = self.service.result(None, "error", error={"code": "INVALID_ARGUMENTS", "message": "Arguments do not match tool schema 1.0"})
                else:
                    result = await self.service.call(params.name, request)
            return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                                        structuredContent=result, isError=result["status"] != "completed")

        self.server = Server("proveryalka", version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)
        self.transport = self.server.streamable_http_app(
            streamable_http_path=path, max_request_body_size=self.policy.max_body_bytes,
            session_idle_timeout=self.policy.session_idle_seconds, max_sessions=self.policy.max_sessions,
            transport_security=TransportSecuritySettings(
                allowed_hosts=[v for h in self.policy.hosts for v in ((f"[{h}]", f"[{h}]:*") if ":" in h else (h, f"{h}:*"))],
                allowed_origins=list(self.policy.origins)),
        )
        self.app = LocalBoundary(self.transport, self.policy)

    def lifespan(self):
        """Host lifespan must enter this exactly once, after backend/codegen start."""
        return self.server.session_manager.run()
