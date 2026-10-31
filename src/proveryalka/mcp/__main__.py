"""Standalone MCP process. Do not share its SQLite database with another running process."""
from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
import uvicorn

from ..api.backend import ApplicationBackend
from ..codegen.service import CodegenService
from ..config import Settings
from ..storage.sqlite import SQLiteStore
from . import LocalAccessPolicy, MCPIntegration


def create_local_app(settings=None, policy=None):
    if settings is None and not os.getenv("PROVERYALKA_DATABASE_PATH"):
        raise ValueError("Standalone MCP requires an explicit, exclusively owned PROVERYALKA_DATABASE_PATH")
    settings = settings or Settings.from_env()
    store = SQLiteStore(settings.database_path)
    backend = ApplicationBackend(store, settings)
    codegen = CodegenService(store)
    mcp = MCPIntegration(backend, codegen, policy or LocalAccessPolicy.from_env())

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        await backend.start()
        try:
            await codegen.start()
            try:
                async with mcp.lifespan():
                    yield
            finally:
                await codegen.close()
        finally:
            await backend.close()

    app = FastAPI(lifespan=lifespan)
    app.mount("/", mcp.app)
    return app


if __name__ == "__main__":
    uvicorn.run(create_local_app(), host="127.0.0.1", port=4190, workers=1)
