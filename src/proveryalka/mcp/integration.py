"""Explicit opt-in wiring for an existing FastAPI app; never restarts its services."""
from contextlib import asynccontextmanager
from starlette.routing import Route

from .server import MCPIntegration


def install_mcp(app, backend, codegen, policy):
    """Call once after all HTTP routers are included, before ASGI startup.

    The host lifespan already owns backend/codegen start/close. An exact ASGI
    route preserves the SDK's /mcp endpoint without redirects or intercepting
    the delivery application's static mount at /.
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
    # An ASGI endpoint (not a request handler) keeps scope.path unchanged for
    # the SDK and lets LocalBoundary inspect every HTTP method itself.
    app.router.routes.append(Route("/mcp", integration.app, name="mcp", include_in_schema=False))
    return integration
