import asyncio
import logging
import json
from fastapi.responses import StreamingResponse
from .analyst import run_analyst
from ..services import ServiceError

from ..checker import TLCChecker
from .artifacts import ArtifactAPI
from ..storage.sqlite import SQLiteBackend
from ..verification.contracts import VerificationRequest

logger = logging.getLogger(__name__)


class ApplicationBackend(SQLiteBackend):
    def __init__(self, store, settings, checker=None, analyst=None):
        super().__init__(store)
        self.checker = checker or TLCChecker(settings)
        self.artifacts = ArtifactAPI(store, settings.artifacts_path)
        self.loop = None
        self.tasks = {}
        self.analyst = analyst or run_analyst
        self.settings = settings
        self.store.max_pending_runs = settings.max_pending_runs
        self.closing = False

    async def start(self):
        self.loop = asyncio.get_running_loop()
        self.store.recover_runs()
        self.semaphores = {"agent":asyncio.Semaphore(self.settings.agent_parallel), "check":asyncio.Semaphore(self.settings.check_parallel)}
        with self.store.transaction() as connection:
            stopped = [r[0] for r in connection.execute("SELECT run_id FROM runs WHERE state IN ('failed','cancelled')")]
        for run_id in stopped:
            self.store.finalize_events(run_id)

    def schedule(self, run_id):
        if run_id not in self.tasks:
            self.tasks[run_id] = self.loop.create_task(self.execute(run_id))
            self.tasks[run_id].add_done_callback(lambda _: self.tasks.pop(run_id, None))

    async def execute(self, run_id):
        with self.store.transaction() as connection:
            row = self.store._run(connection, run_id)
        try:
            async with self.semaphores[row["kind"]]:
                if self.store.get_run(run_id)["state"] == "cancelling":
                    return
                await self.execute_unbounded(run_id)
        except asyncio.CancelledError:
            # TLC's cancellation handler terminates child processes before returning here.
            await asyncio.to_thread(self.store.fail_run, run_id, "CANCELLED")
        finally:
            await asyncio.to_thread(self.store.finalize_events, run_id)

    def stop(self, run_id):
        self.checker.cancel(run_id)
        task = self.tasks.get(run_id)
        if task is not None and not task.done():
            # Let newly scheduled coroutines enter their try/finally first.
            self.loop.call_soon(task.cancel)
        elif task is None:
            self.store.finalize_events(run_id)

    async def execute_unbounded(self, run_id):
        with self.store.transaction() as connection:
            row = self.store._run(connection, run_id)
        if row["kind"] == "agent":
            await self.execute_agent(run_id)
        else:
            await self.execute_check(run_id)

    async def execute_agent(self, run_id):
        row = await asyncio.to_thread(self.store.claim_run, run_id)
        if row is None:
            return
        try:
            body = json.loads(row["request_json"])
            body["source_key"] = run_id
            state = await asyncio.wait_for(self.analyst(self.store, row["session_id"], body), timeout=self.settings.agent_timeout_seconds)
            await asyncio.to_thread(self.store.save_dialogue_sources, row["session_id"], state.sources)
            for question in state.pending_questions:
                await asyncio.to_thread(self.store.event, run_id, "clarification_requested", question.model_dump(mode="json"))
            version_id = None
            if state.analysis.behavior is not None:
                model = await asyncio.to_thread(self.store.create_model, row["session_id"], {"name": "Analyst model"}, "analyst-model")
                version = await asyncio.to_thread(self.store.create_version, model["id"], {"spec": state.analysis.behavior.model_dump(mode="json")}, run_id)
                version_id = version["id"]
                await asyncio.to_thread(self.store.event, run_id, "model_proposed", {"model_id":model["id"],"version_id":version_id,"number":version["number"]})
            # The current analyst exposes a complete structured turn, not token streaming.
            text = state.analysis.subject or state.status
            await asyncio.to_thread(self.store.event, run_id, "message_delta", {"text":text})
            await asyncio.to_thread(self.store.complete_agent, run_id, version_id)
        except Exception as error:
            code = "RUN_TIMEOUT" if isinstance(error, TimeoutError) else getattr(error, "code", "AGENT_FAILED")
            logger.error("agent_failed run_id=%s session_id=%s code=%s",run_id,row["session_id"],code)
            await asyncio.to_thread(self.store.fail_run, run_id, code)

    def stream(self, run_id, after):
        self.store.events(run_id, after)  # Validate before sending HTTP headers.
        async def generate():
            cursor = after
            terminal_seen = False
            while True:
                events = await asyncio.to_thread(self.store.events, run_id, cursor)
                for event in events:
                    cursor = event["event_id"]
                    terminal_seen = terminal_seen or event["type"] == "run_finished"
                    yield f'id: {cursor}\nevent: {event["type"]}\ndata: {json.dumps(event,ensure_ascii=False)}\n\n'
                run = await asyncio.to_thread(self.store.get_run, run_id)
                # Drain all persisted events before closing, even when more than 100.
                if run["state"] in ("completed","failed","cancelled") and not events and (terminal_seen or self.store.terminal_event_saved(run_id)):
                    break
                if not events:
                    yield ": keepalive\n\n"
                    await asyncio.sleep(0.1)
        return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

    async def execute_check(self, run_id):
        row = await asyncio.to_thread(self.store.claim_run, run_id)
        if row is None:
            return
        try:
            await asyncio.to_thread(self.store.event, run_id, "check_started", {"check_run_id":run_id,"version_id":row["version_id"]})
            request = VerificationRequest.model_validate_json(row["request_json"])
            result = await self.checker.run(request, run_id=run_id)
            await asyncio.to_thread(self.store.finish_check, run_id, result.report, result.directory is not None)
            await asyncio.to_thread(self.store.event, run_id, "check_finished", {"check_run_id":run_id,"version_id":row["version_id"]})
        except Exception:
            logger.error("check_failed run_id=%s session_id=%s", run_id, row["session_id"])
            await asyncio.to_thread(self.store.fail_run, run_id, "CHECK_FAILED")

    async def close(self):
        # Stop the actual tool before waiting for persistence and loop shutdown.
        self.closing = True
        for run_id in list(self.tasks):
            self.store.request_cancel(run_id)
            self.stop(run_id)
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)

    def call(self, operation, **arguments):
        if operation in ("send_message", "create_check") and self.closing:
            raise ServiceError(503, "SHUTTING_DOWN", "Server is shutting down")
        if operation == "cancel_run":
            run = self.store.request_cancel(**arguments)
            if run["state"] == "cancelling":
                self.loop.call_soon_threadsafe(self.stop, run["run_id"])
            return run
        if operation == "send_message":
            if not arguments["body"]["text"].strip() or len(arguments["body"]["text"]) > self.settings.max_input_chars:
                raise ServiceError(422, "INPUT_LIMIT", "Message is empty or exceeds configured input limit")
            run = self.store.create_agent_run(**arguments)
            self.loop.call_soon_threadsafe(self.schedule, run["run_id"])
            return run
        if operation == "events":
            return self.stream(**arguments)
        if operation in ("list_artifacts", "get_artifact"):
            return getattr(self.artifacts, operation)(**arguments)
        if operation == "create_check":
            run = self.store.create_check(**arguments)
            self.loop.call_soon_threadsafe(self.schedule, run["run_id"])
            return run
        if operation in ("get_run", "get_check"):
            return getattr(self.store, operation)(**arguments)
        return super().call(operation, **arguments)
