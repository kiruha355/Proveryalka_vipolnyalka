"""Explicit opt-in wiring for an existing FastAPI app; never restarts its services."""
from contextlib import asynccontextmanager

from .server import MCPIntegration


def install_mcp(app, backend, codegen, policy):
    """Call once after all HTTP routers are included, before ASGI startup.

    The host lifespan already owns backend/codegen start/close. Mounting at /
    preserves the SDK's exact /mcp endpoint without slash redirects. The mount
    is last, so all existing host routes retain precedence.
    """
    if hasattr(app.state, "mcp"):
        raise ValueError("MCP is already installed")
    integration = MCPIntegration(backend, codegen, policy)
    host_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with host_lifespan(app) as state:
            async with integration.lifespan():
                yield state

    app.router.lifespan_context = lifespan
    app.state.mcp = integration
    app.mount("/", integration.app, name="mcp")
    return integration
