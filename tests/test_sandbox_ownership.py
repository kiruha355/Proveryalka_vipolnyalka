"""Ownership regression without Docker; deliberately untrusted CLI listing."""
import asyncio
import json

from proveryalka.codegen import sandbox as module
from proveryalka.codegen.sandbox import DockerSandbox, LABEL, OWNER_LABEL
from proveryalka.codegen.service import CodegenService
from proveryalka.storage.sqlite import SQLiteStore


def test_cleanup_checks_owner_active_state_and_never_forces(monkeypatch):
    own, foreign = DockerSandbox(), DockerSandbox()
    def container(n, owner, state="exited", name=None):
        return {"Id": str(n) * 64, "Name": name or f"/container-{n}", "Config": {"Labels": {LABEL: "trun", OWNER_LABEL: owner}}, "State": {"Status": state}}
    records = {str(n) * 64: entry for n, entry in enumerate([
        container(0, own.owner_id), container(1, foreign.owner_id), container(2, own.owner_id, "running"),
        container(3, own.owner_id, name="/active-result"), container(4, None), container(5, own.owner_id),
    ])}
    own._active_names.add("active-result")
    commands = []
    async def tool(command, **kwargs):
        commands.append(command)
        if command[1] == "ps":
            # A broad or faulty listing cannot grant deletion authority.
            return 0, "\n".join(records) + "\nnot-a-container", ""
        if command[1] == "inspect":
            return 0, json.dumps(records[command[-1]]), ""
        if command[1] == "rm":
            # Simulate a concurrent restart of the last candidate: rm fails.
            return (1 if command[-1] == "5" * 64 else 0), "", ""
        raise AssertionError(command)
    monkeypatch.setattr(module, "run_tool", tool)
    assert asyncio.run(own.cleanup_orphans()) == 1
    listing = commands[0]
    assert f"label={OWNER_LABEL}={own.owner_id}" in listing and "status=exited" in listing
    assert [c for c in commands if c[1] == "rm"] == [["docker", "rm", "0" * 64], ["docker", "rm", "5" * 64]]
    async def cannot_stop_foreign():
        await own.remove("1" * 64)
        await own.stop_container("1" * 64)
    asyncio.run(cannot_stop_foreign())
    assert not any(c[1] == "kill" or "-f" in c for c in commands)


def test_service_close_joins_its_cleanup_task(tmp_path):
    class WaitingSandbox:
        def __init__(self):
            self.started = asyncio.Event()
            self.finished = asyncio.Event()
        async def cleanup_orphans(self):
            self.started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.finished.set()
    async def scenario():
        store = SQLiteStore(tmp_path / "db")
        store.initialize()
        sandbox = WaitingSandbox()
        service = CodegenService(store, sandbox=sandbox)
        await service.start()
        await sandbox.started.wait()
        task = service.cleanup_task
        await service.close()
        assert task.done() and sandbox.finished.is_set() and service.cleanup_task is None
    asyncio.run(scenario())
