import asyncio
import logging

from ..checker import TLCChecker
from .artifacts import ArtifactAPI
from ..storage.sqlite import SQLiteBackend
from ..verification.contracts import VerificationRequest

logger = logging.getLogger(__name__)


class ApplicationBackend(SQLiteBackend):
    def __init__(self, store, settings, checker=None):
        super().__init__(store)
        self.checker = checker or TLCChecker(settings)
        self.artifacts = ArtifactAPI(store, settings.artifacts_path)
        self.loop = None
        self.tasks = {}

    async def start(self):
        self.loop = asyncio.get_running_loop()
        self.store.recover_runs()

    def schedule(self, run_id):
        if run_id not in self.tasks:
            self.tasks[run_id] = self.loop.create_task(self.execute_check(run_id))
            self.tasks[run_id].add_done_callback(lambda _: self.tasks.pop(run_id, None))

    async def execute_check(self, run_id):
        row = await asyncio.to_thread(self.store.claim_run, run_id)
        if row is None:
            return
        try:
            request = VerificationRequest.model_validate_json(row["request_json"])
            result = await self.checker.run(request, run_id=run_id)
            await asyncio.to_thread(self.store.finish_check, run_id, result.report, result.directory is not None)
        except Exception:
            logger.error("check_failed run_id=%s session_id=%s", run_id, row["session_id"])
            await asyncio.to_thread(self.store.fail_run, run_id, "CHECK_FAILED")

    async def close(self):
        # Stop the actual tool before waiting for persistence and loop shutdown.
        for run_id in list(self.tasks):
            self.checker.cancel(run_id)
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)

    def call(self, operation, **arguments):
        if operation in ("list_artifacts", "get_artifact"):
            return getattr(self.artifacts, operation)(**arguments)
        if operation == "create_check":
            run = self.store.create_check(**arguments)
            self.loop.call_soon_threadsafe(self.schedule, run["run_id"])
            return run
        if operation in ("get_run", "get_check"):
            return getattr(self.store, operation)(**arguments)
        return super().call(operation, **arguments)
