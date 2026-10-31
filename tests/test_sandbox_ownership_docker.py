"""Two actual Docker executors and a service startup on one daemon; own containers only."""
import asyncio
import json
from uuid import uuid4

import pytest

from proveryalka.codegen.sandbox import DockerSandbox, OWNER_LABEL, run_tool
from proveryalka.codegen.service import CodegenService
from proveryalka.storage.sqlite import SQLiteStore
from test_codegen_sandbox import REASON

pytestmark = pytest.mark.skipif(REASON is not None and __import__('os').getenv("PROVERYALKA_REQUIRE_SANDBOX") != "1", reason=f"Docker unavailable: {REASON}")


def test_startup_cleanup_and_cancel_preserve_other_active_instance(tmp_path):
    async def scenario():
        first, second = DockerSandbox(), DockerSandbox()
        stop_first, stop_second = asyncio.Event(), asyncio.Event()
        run_id = "trun_shared_" + uuid4().hex[:12]
        files = [("tests/test_wait.py", b"import time\ndef test_wait():\n    time.sleep(90)\n")]
        a = asyncio.create_task(first.run(files, run_id=run_id, timeout_seconds=120, stop=stop_first))
        b = asyncio.create_task(second.run(files, run_id=run_id, timeout_seconds=120, stop=stop_second))
        store = SQLiteStore(tmp_path / "db")
        store.initialize()
        service = CodegenService(store, sandbox=first)
        async def running(sandbox):
            code, out, _ = await run_tool(["docker", "ps", "-q", "--filter", f"label={OWNER_LABEL}={sandbox.owner_id}"])
            assert code == 0
            return out.split()
        try:
            for _ in range(100):
                if await running(first) and await running(second):
                    break
                assert not a.done() and not b.done()
                await asyncio.sleep(0.1)
            assert await running(first) and await running(second)
            assert first._active_names.isdisjoint(second._active_names)
            await service.start()
            await service.cleanup_task
            assert await running(first) and await running(second)
            assert await first.cleanup_orphans() == await second.cleanup_orphans() == 0
            stop_first.set()
            result, _ = await a
            assert result["status"] == "cancelled"
            assert not await running(first)
            assert await running(second) and not b.done()
        finally:
            stop_first.set()
            stop_second.set()
            await asyncio.gather(a, b)
            await service.close()
        assert not await running(first) and not await running(second)
    asyncio.run(scenario())
