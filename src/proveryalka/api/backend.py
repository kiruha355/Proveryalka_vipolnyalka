import asyncio
import logging
import json
from fastapi.responses import StreamingResponse
from .analyst import run_analyst

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

    async def start(self):
        self.loop = asyncio.get_running_loop()
        self.store.recover_runs()

    def schedule(self, run_id):
        if run_id not in self.tasks:
            self.tasks[run_id] = self.loop.create_task(self.execute(run_id))
            self.tasks[run_id].add_done_callback(lambda _: self.tasks.pop(run_id, None))

    async def execute(self, run_id):
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
            state = await self.analyst(self.store, row["session_id"], body)
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
            await asyncio.to_thread(self.store.event, run_id, "run_finished", {"state":"completed"})
        except Exception as error:
            code = getattr(error, "code", "AGENT_FAILED")
            logger.error("agent_failed run_id=%s session_id=%s code=%s",run_id,row["session_id"],code)
            await asyncio.to_thread(self.store.fail_run, run_id, code)
            await asyncio.to_thread(self.store.event, run_id, "error", {"code":code,"message":"Agent run failed; history was preserved"})
            await asyncio.to_thread(self.store.event, run_id, "run_finished", {"state":"failed"})

    def stream(self, run_id, after):
        self.store.events(run_id, after)  # Validate before sending HTTP headers.
        async def generate():
            cursor = after
            while True:
                events = await asyncio.to_thread(self.store.events, run_id, cursor)
                for event in events:
                    cursor = event["event_id"]
                    yield f'id: {cursor}\nevent: {event["type"]}\ndata: {json.dumps(event,ensure_ascii=False)}\n\n'
                run = await asyncio.to_thread(self.store.get_run, run_id)
                # Drain all persisted events before closing, even when more than 100.
                if run["state"] in ("completed","failed","cancelled") and not events:
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
            await asyncio.to_thread(self.store.event, run_id, "run_finished", {"state":self.store.get_run(run_id)["state"]})
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
        if operation == "send_message":
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
