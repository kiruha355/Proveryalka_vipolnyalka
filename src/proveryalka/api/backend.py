import asyncio
import logging
import json
from fastapi.responses import StreamingResponse
from .analyst import run_analyst
from ..services import ServiceError

from ..checker import TLCChecker
from .artifacts import ArtifactAPI
from .documents import extract_document
from ..storage.session import StoredSession
from ..storage.sqlite import SQLiteBackend
from ..verification.checker import spec_hash, validate_report
from ..verification.contracts import VerificationReport, VerificationRequest

logger = logging.getLogger(__name__)

STATUS_TEXT = {
    "needs_clarification": "Нужны уточнения",
    "model_incomplete": "Модель пока неполная",
    "ready": "Модель готова к проверке",
    "limit_reached": "Достигнут лимит уточняющих раундов",
}
CANCELLED_MARK = {"role": "assistant", "content": json.dumps({"analyst_pending_cancelled": True})}


def render_turn(state):
    """Запасной текст хода, если аналитик не дал reply: только факты из сохранённого состояния."""
    analysis = state.analysis
    lines = [f"Объект: {analysis.subject}."] if getattr(analysis, "subject", None) else []
    lines.append(STATUS_TEXT.get(state.status, str(state.status)) + ".")
    lines += [f"Вопрос: {question.text}" for question in state.pending_questions]
    issues = getattr(analysis, "model_issues", None) or []
    if issues and state.status != "ready":
        lines.append("Не определено: " + ", ".join(issue.path for issue in issues[:5]))
    return "\n".join(lines)


class ApplicationBackend(SQLiteBackend):
    def __init__(self, store, settings, checker=None, analyst=None, explainer=None):
        super().__init__(store)
        self.checker = checker or TLCChecker(settings)
        self.artifacts = ArtifactAPI(store, settings.artifacts_path)
        self.loop = None
        self.tasks = {}
        self.analyst = analyst or run_analyst
        self.explainer = explainer
        self.settings = settings
        self.store.max_pending_runs = settings.max_pending_runs
        self.closing = False

    async def start(self):
        self.loop = asyncio.get_running_loop()
        self.store.recover_runs()
        self.semaphores = {
            "agent": asyncio.Semaphore(self.settings.agent_parallel),
            "explain": asyncio.Semaphore(self.settings.agent_parallel),
            "check": asyncio.Semaphore(self.settings.check_parallel),
        }
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
            if row["kind"] == "agent":
                await asyncio.to_thread(self.release_cancelled_turn, row["session_id"], run_id)
            await asyncio.to_thread(self.store.finalize_events, run_id)

    def release_cancelled_turn(self, session_id, run_id):
        """Явная отмена пользователем отказывается от незавершённого хода; сбой и остановка сервера его сохраняют."""
        from ..agent.dialogue import find_pending
        run = self.store.get_run(run_id)
        if run["state"] not in ("cancelling", "cancelled") or run["error_code"] != "CANCELLED":
            return
        if find_pending(self.store.history(session_id)) is not None:
            self.store.append_messages(session_id, [CANCELLED_MARK])

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
        elif row["kind"] == "explain":
            await self.execute_explain(run_id)
        else:
            await self.execute_check(run_id)

    def save_version(self, session_id, behavior, run_id):
        model = self.store.create_model(session_id, {"name": "Analyst model"}, "analyst-model")
        spec = behavior.model_dump(mode="json")
        latest = self.store.latest_version(model["id"])
        # Ход без изменения модели не создаёт новую версию.
        if latest is not None and latest["spec_hash"] == spec_hash(behavior):
            return latest, False
        return self.store.create_version(model["id"], {"spec": spec}, run_id), True

    async def execute_agent(self, run_id):
        row = await asyncio.to_thread(self.store.claim_run, run_id)
        if row is None:
            return
        try:
            body = json.loads(row["request_json"])
            body["source_key"] = run_id
            body["run_id"] = run_id
            state = await asyncio.wait_for(self.analyst(self.store, row["session_id"], body), timeout=self.settings.agent_timeout_seconds)
            await asyncio.to_thread(self.store.save_dialogue_sources, row["session_id"], state.sources)
            version, changed = None, False
            if state.analysis.behavior is not None:
                version, changed = await asyncio.to_thread(self.save_version, row["session_id"], state.analysis.behavior, run_id)
            await asyncio.to_thread(self.store.event, run_id, "dialogue_updated", {
                "status": state.status, "round": getattr(state, "round", None),
                "open_question_ids": [question.id for question in state.pending_questions],
                "version_id": version["id"] if version else None,
            })
            for question in state.pending_questions:
                await asyncio.to_thread(self.store.event, run_id, "clarification_requested", question.model_dump(mode="json"))
            if version is not None:
                await asyncio.to_thread(self.store.event, run_id, "model_proposed", {
                    "model_id": version["model_id"], "version_id": version["id"], "number": version["number"],
                    "spec_hash": version["spec_hash"], "changed": changed,
                })
            # The analyst returns a complete structured turn, not token streaming.
            text = getattr(state, "reply", None) or render_turn(state)
            await asyncio.to_thread(self.store.event, run_id, "message_delta", {"text": text})
            await asyncio.to_thread(self.store.complete_agent, run_id, version["id"] if version else None)
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
                # run_finished may be saved between the read above and this check: close only once it was sent.
                if run["state"] in ("completed","failed","cancelled") and not events:
                    terminal = await asyncio.to_thread(self.store.terminal_event_id, run_id)
                    if terminal_seen or (terminal is not None and terminal <= cursor):
                        break
                if not events:
                    yield ": keepalive\n\n"
                    await asyncio.sleep(0.1)
        return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

    def remember_report(self, session_id, outcome):
        """Отчёт проверки в истории сессии: следующий ход аналитика получает его как verification_context."""
        try:
            self.store.append_messages(session_id, [{"role": "assistant", "content": json.dumps(
                {"analyst_verification": outcome.model_dump(mode="json")}, ensure_ascii=False)}])
        except Exception:
            # Отчёт и объяснение уже сохранены в runs; без записи в историю теряется только контекст диалога.
            logger.error("verification_history_failed session_id=%s check_id=%s", session_id, outcome.check_id)

    async def execute_check(self, run_id):
        row = await asyncio.to_thread(self.store.claim_run, run_id)
        if row is None:
            return
        try:
            await asyncio.to_thread(self.store.event, run_id, "check_started", {"check_run_id":run_id,"version_id":row["version_id"]})
            request = VerificationRequest.model_validate_json(row["request_json"])
            result = await self.checker.run(request, run_id=run_id)
            try:
                # Общая проверка трасс и привязка related_requirements до сохранения.
                report = validate_report(request, VerificationReport.model_validate_json(result.report.model_dump_json()))
            except ValueError:
                logger.error("check_invalid_result run_id=%s", run_id)
                await asyncio.to_thread(self.store.fail_run, run_id, "INVALID_CHECKER_RESULT")
                return
            # Отчёт сохраняется до любого вызова LLM; сбой объяснения его не отменяет.
            await asyncio.to_thread(self.store.finish_check, run_id, report, result.directory is not None)
            from ..agent.verification import VerificationOutcome
            outcome = VerificationOutcome(request=request, report=report, explanation=None, check_id=run_id)
            await asyncio.to_thread(self.remember_report, row["session_id"], outcome)
            await asyncio.to_thread(self.store.event, run_id, "check_finished", {
                "check_run_id": run_id, "version_id": row["version_id"],
                "results": [{"property_id": r.property_id, "status": r.status, "conclusive": r.conclusive} for r in report.results],
            })
            if row["explain"] and report.executed:
                await asyncio.to_thread(self.queue_explanation, run_id)
        except Exception:
            logger.error("check_failed run_id=%s session_id=%s", run_id, row["session_id"])
            await asyncio.to_thread(self.store.fail_run, run_id, "CHECK_FAILED")

    def queue_explanation(self, check_run_id):
        try:
            run = self.store.create_explanation(check_run_id, "auto")
        except ServiceError as error:
            # Очередь заполнена или проверка отменена: отчёт сохранён, объяснение можно запросить позже.
            logger.warning("explanation_not_queued check_run_id=%s code=%s", check_run_id, error.code)
            return
        self.store.event(check_run_id, "explanation_queued", {"check_run_id": check_run_id, "explanation_run_id": run["run_id"]})
        self.loop.call_soon_threadsafe(self.schedule, run["run_id"])

    async def execute_explain(self, run_id):
        row = await asyncio.to_thread(self.store.claim_run, run_id)
        if row is None:
            return
        try:
            check = await asyncio.to_thread(self.store.check_record, row["parent_run_id"])
            # Объясняется отчёт неизменяемой проверенной версии, а не текущая модель диалога.
            request = VerificationRequest.model_validate_json(check["request_json"])
            report = VerificationReport.model_validate_json(check["result_json"])
            await asyncio.to_thread(self.store.event, run_id, "explanation_started", {"check_run_id": check["run_id"], "version_id": check["version_id"]})
            explain = self.explainer
            if explain is None:
                from ..agent.verification import explain_saved_report as explain
            narrative = await asyncio.wait_for(explain(request, report), timeout=self.settings.agent_timeout_seconds)
            from ..agent.verification import VerificationOutcome
            # Повторная сверка: объяснение относится ровно к свойствам и шагам этого отчёта.
            outcome = VerificationOutcome(request=request, report=report, explanation=narrative, check_id=check["run_id"])
            data = outcome.explanation.model_dump(mode="json")
            if not await asyncio.to_thread(self.store.finish_explanation, run_id, json.dumps(data, ensure_ascii=False)):
                return
            await asyncio.to_thread(self.remember_report, row["session_id"], outcome)
            await asyncio.to_thread(self.store.event, run_id, "explanation_ready", {"check_run_id": check["run_id"], "version_id": check["version_id"], "narrative": data})
        except Exception as error:
            code = "RUN_TIMEOUT" if isinstance(error, TimeoutError) else getattr(error, "code", "EXPLANATION_FAILED")
            logger.error("explanation_failed run_id=%s code=%s", run_id, code)
            await asyncio.to_thread(self.store.fail_run, run_id, code)

    async def close(self):
        # Stop the actual tool before waiting for persistence and loop shutdown.
        self.closing = True
        for run_id in list(self.tasks):
            # Не пользовательская отмена: незавершённый ход остаётся доступным для повтора.
            self.store.request_cancel(run_id, "SERVER_SHUTDOWN")
            self.stop(run_id)
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)

    def dialogue_items(self, session_id, repair=False):
        from ..agent.dialogue import find_dialogue, find_pending
        items = self.store.history(session_id)
        try:
            state = find_dialogue(items)
        except ValueError as error:
            raise ServiceError(409, "DIALOGUE_FORMAT", "The session uses an old dialogue format; start a new session") from error
        pending = find_pending(items)
        if pending is not None and pending.run_id is not None:
            run = self.store.get_run(pending.run_id)
            # Отмена могла прийти, пока ход ещё записывался: такой ход больше не блокирует диалог.
            if run["state"] == "cancelled" and run["error_code"] == "CANCELLED" and self.store.active_agent_run(session_id) is None:
                if repair:
                    self.store.append_messages(session_id, [CANCELLED_MARK])
                pending = None
        return state, pending

    def get_dialogue(self, session_id):
        state, pending = self.dialogue_items(session_id)
        view = {"session_id": session_id, "status": "not_started"}
        if state is not None:
            behavior = state.analysis.behavior
            view.update(
                status=state.status, round=state.round, max_rounds=state.max_rounds, reply=state.reply,
                requirements=[{"code": f"R{index}", **item.model_dump(mode="json")} for index, item in enumerate(state.analysis.requirements, 1)],
                questions=[item.model_dump(mode="json") for item in state.questions],
                open_question_ids=[item.id for item in state.pending_questions],
                corrections=[item.model_dump(mode="json") for item in state.corrections],
                analysis=state.analysis.model_dump(mode="json"),
                model=self.store.analyst_version(session_id, spec_hash(behavior)) if behavior is not None else None,
            )
        if pending is not None:
            run = self.store.get_run(pending.run_id) if pending.run_id else None
            view["pending"] = {"source_id": pending.source.id, "text": pending.source.text, "question_id": pending.question_id,
                               "run_id": pending.run_id, "run_state": run["state"] if run else None}
        return view

    def send_message(self, session_id, body, key):
        text = body.get("text")
        if text is not None and (not text.strip() or len(text) > self.settings.max_input_chars):
            raise ServiceError(422, "INPUT_LIMIT", "Message is empty or exceeds configured input limit")
        if self.store.idempotent_response(f"agent:{session_id}", key, body) is None:
            if self.store.active_agent_run(session_id) is not None:
                raise ServiceError(409, "SESSION_BUSY", "An agent run is already active in this session")
            state, pending = self.dialogue_items(session_id, repair=True)
            if pending is not None:
                if body.get("source_id") is not None or pending.source.text != text or body.get("question_id") != pending.question_id:
                    raise ServiceError(409, "PENDING_MESSAGE", "Retry or discard the unfinished message before sending a new one")
            elif body.get("source_id") is not None:
                if state is not None:
                    raise ServiceError(409, "DIALOGUE_STARTED", "A stored source can only start a new dialogue")
                self.store.get_source(session_id, body["source_id"])
            elif state is not None:
                if state.status == "limit_reached":
                    raise ServiceError(409, "CLARIFICATION_LIMIT", "The clarification round limit is reached; start a new session")
                if body.get("question_id") is not None and body["question_id"] not in {q.id for q in state.pending_questions}:
                    raise ServiceError(422, "UNKNOWN_QUESTION", "question_id is not an open question of this dialogue")
            elif body.get("question_id") is not None:
                raise ServiceError(422, "UNKNOWN_QUESTION", "The dialogue has no questions yet")
        run = self.store.create_agent_run(session_id, body, key)
        self.loop.call_soon_threadsafe(self.schedule, run["run_id"])
        return run

    def retry_pending(self, session_id, key):
        body = {"retry_pending": True}
        if self.store.idempotent_response(f"agent:{session_id}", key, body) is None:
            if self.store.active_agent_run(session_id) is not None:
                raise ServiceError(409, "SESSION_BUSY", "An agent run is already active in this session")
            _, pending = self.dialogue_items(session_id, repair=True)
            if pending is None:
                raise ServiceError(409, "NO_PENDING", "There is no unfinished message to retry")
        run = self.store.create_agent_run(session_id, body, key)
        self.loop.call_soon_threadsafe(self.schedule, run["run_id"])
        return run

    def discard_pending(self, session_id):
        if self.store.active_agent_run(session_id) is not None:
            raise ServiceError(409, "SESSION_BUSY", "Cancel the active agent run first")
        _, pending = self.dialogue_items(session_id, repair=True)
        if pending is not None:
            self.store.append_messages(session_id, [CANCELLED_MARK])
        return self.get_dialogue(session_id)

    def create_document(self, session_id, filename, data, key):
        text, document = extract_document(filename, data, self.settings.max_document_bytes, self.settings.max_input_chars)
        return self.store.create_document(session_id, document, text, key)

    def call(self, operation, **arguments):
        if operation in ("send_message", "create_check", "create_explanation", "retry_pending") and self.closing:
            raise ServiceError(503, "SHUTTING_DOWN", "Server is shutting down")
        if operation == "cancel_run":
            run = self.store.request_cancel(**arguments)
            if run["state"] == "cancelling":
                self.loop.call_soon_threadsafe(self.stop, run["run_id"])
            return run
        if operation in ("send_message", "retry_pending", "discard_pending", "get_dialogue", "create_document"):
            return getattr(self, operation)(**arguments)
        if operation == "events":
            return self.stream(**arguments)
        if operation in ("list_artifacts", "get_artifact"):
            return getattr(self.artifacts, operation)(**arguments)
        if operation in ("create_check", "create_explanation"):
            run = getattr(self.store, operation)(**arguments)
            self.loop.call_soon_threadsafe(self.schedule, run["run_id"])
            return run
        if operation in ("get_run", "get_check"):
            return getattr(self.store, operation)(**arguments)
        return super().call(operation, **arguments)
