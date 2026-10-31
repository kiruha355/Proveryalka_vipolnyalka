import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import os
from pathlib import Path
import socket

from fastapi import FastAPI
import pytest
import uvicorn

from proveryalka.api.backend import ApplicationBackend
from proveryalka.codegen.sandbox import DockerSandbox
from proveryalka.codegen.service import CodegenService
from proveryalka.config import Settings
from proveryalka.mcp import MCPIntegration, LocalAccessPolicy
from proveryalka.mcp.policy import TOOLS
from proveryalka.storage.sqlite import SQLiteStore
from test_codegen_api import add_version, FakeChecker


@pytest.fixture
def anyio_backend():
    return "asyncio"


@asynccontextmanager
async def running(tmp_path, *, policy_changes=None, real_tlc=False, sandbox=None, checker=None):
    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", check_cache_path=None,
                        tla_jar=Path(os.getenv("PROVERYALKA_TLA_JAR", "tools/tla2tools.jar")))
    store = SQLiteStore(settings.database_path)
    store.initialize()
    session, model, version = add_version(store)
    policy = replace(LocalAccessPolicy(model_ids=frozenset({model["id"]}), tools=TOOLS), **(policy_changes or {}))
    backend = ApplicationBackend(store, settings, checker=checker or (None if real_tlc else FakeChecker()))
    codegen = CodegenService(store, sandbox=sandbox or DockerSandbox())
    integration = MCPIntegration(backend, codegen, policy)

    @asynccontextmanager
    async def lifespan(app):
        await backend.start()
        await codegen.start()
        try:
            async with integration.lifespan():
                yield
        finally:
            await codegen.close()
            await backend.close()

    app = FastAPI(lifespan=lifespan)
    app.mount("/", integration.app)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="on"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        ref = {"model_id": model["id"], "version_number": 1, "version_id": version["id"], "spec_hash": version["spec_hash"]}
        yield f"http://127.0.0.1:{sock.getsockname()[1]}/mcp", integration, backend, codegen, ref
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 15)
        sock.close()
