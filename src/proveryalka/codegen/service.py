"""Генерация по согласованной версии и асинхронный запуск тестов в песочнице.

Генерация синхронна и детерминирована. Допуск: версия approved, spec_hash совпадает с сохранённой
спецификацией, модель в поддерживаемом объёме. Результат TLC модель не меняет: если TLC не
подтвердил все свойства (violated / inconclusive / not_checked), генерация требует явного
allow_unverified=true, а снимок статусов сохраняется в записи и README проекта.
"""
import asyncio
import logging
from uuid import uuid4

from pydantic import ValidationError

from ..behavior import BehavioralModel
from ..services import ServiceError
from ..storage.codegen import CodegenStore, ensure_schema
from ..storage.sqlite import now
from ..verification import spec_hash
from . import comparison
from .dto import ComparisonCreate, GenerationCreate, TestRunCreate
from .paths import UnsafePath, build_archive, safe_path
from .project import Provenance, generate_project
from .sandbox import DockerSandbox, SandboxUnavailable
from .scope import (
    GENERATOR_NAME, GENERATOR_VERSION, LIMITS, SUPPORTED_CONDITIONS, TARGET, TECHNICAL_CONDITIONS,
    UnsupportedModel, check_supported, condition_issues, technical_conditions,
)
from .settings import CodegenSettings


logger = logging.getLogger(__name__)


class CodegenError(ServiceError):
    def __init__(self, status, code, message, details=None):
        super().__init__(status, code, message)
        self.details = details or []


class CodegenService:
    def __init__(self, store, settings=None, sandbox=None, planner=None):
        self.settings = settings or CodegenSettings.from_env()
        self.repo = CodegenStore(store)
        self.sandbox = sandbox or DockerSandbox(self.settings)
        self.planner = planner
        self.loop = None
        self.semaphore = None
        self.tasks = {}
        self.stops = {}
        self.closing = False
        self.cleanup_task = None

    # Жизненный цикл

    async def start(self):
        await asyncio.to_thread(ensure_schema, self.repo.store)
        await asyncio.to_thread(self.repo.recover)
        self.loop = asyncio.get_running_loop()
        self.semaphore = asyncio.Semaphore(self.settings.parallel)
        self.closing = False
        if hasattr(self.sandbox, "cleanup_orphans"):
            self.cleanup_task = self.loop.create_task(self._cleanup_orphans())

    async def _cleanup_orphans(self):
        try:
            removed = await self.sandbox.cleanup_orphans()
            if removed:
                logger.warning("codegen_sandbox_orphans_removed count=%s", removed)
        except Exception:
            logger.exception("codegen_sandbox_cleanup_failed")

    async def close(self):
        self.closing = True
        if self.cleanup_task is not None:
            self.cleanup_task.cancel()
            await asyncio.gather(self.cleanup_task, return_exceptions=True)
            self.cleanup_task = None
        for test_run_id in list(self.tasks):
            self.stop(test_run_id)
        if self.tasks:
            done, pending = await asyncio.wait(list(self.tasks.values()), timeout=30)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    # Генерация

    def generate(self, model_id, number, body, key):
        prepared = self.prepare_generation(model_id, number, body, key)
        if isinstance(prepared, dict):
            return prepared
        if prepared[1].get("application_mode") == "agent":
            raise CodegenError(422, "INVALID_REQUEST", "Use the asynchronous generation endpoint for agent mode")
        return self.save_generation(prepared, key)

    async def generate_request(self, model_id, number, body, key):
        prepared = await asyncio.to_thread(self.prepare_generation, model_id, number, body, key)
        if isinstance(prepared, dict):
            return prepared
        _, request, _, _, model = prepared
        application_files = ()
        if request.get("application_mode") == "agent":
            from .application import plan_application, render_application

            transitions = [{"id": item.id, "name": item.name, "requirement_ids": item.requirement_ids}
                           for item in model.transitions]
            try:
                plan = await asyncio.wait_for(
                    (self.planner or plan_application)(request["technical_conditions"], transitions), timeout=120,
                )
                application_files = render_application(plan, model)
            except ValueError as error:
                raise CodegenError(502, "INVALID_APPLICATION_PLAN", "Agent plan does not match the approved model") from error
            except Exception as error:
                logger.warning("codegen_application_planner_failed type=%s", type(error).__name__)
                raise CodegenError(503, "APPLICATION_PLANNER_FAILED", "Application agent did not produce a plan") from error
        return await asyncio.to_thread(self.save_generation, prepared, key, application_files)

    def prepare_generation(self, model_id, number, body, key):
        try:
            request = GenerationCreate.model_validate(body)
        except ValidationError as error:
            raise CodegenError(422, "INVALID_REQUEST", "Invalid generation request") from error
        body = request.model_dump()
        conditions = body.pop("technical_conditions")
        if body["application_mode"] == "template":
            body.pop("application_mode")
        if conditions is not None or request.application_mode == "agent":
            missing, unsupported = condition_issues(conditions or {})
            if unsupported:
                raise CodegenError(422, "UNSUPPORTED_TECHNICAL_CONDITIONS", "Unsupported technical conditions", unsupported)
            if missing:
                raise CodegenError(422, "CONDITIONS_INCOMPLETE", "Confirm all required technical conditions", missing)
            body["technical_conditions"] = conditions
        scope = f"codegen:generate:{model_id}:{number}"
        previous = self.repo.replay(scope, key, body)
        if previous is not None:
            return previous
        version, snapshot = self.repo.version(model_id, number)
        if not version["approved"]:
            raise CodegenError(409, "VERSION_NOT_APPROVED", "Code is generated only for an approved model version")
        try:
            model = BehavioralModel.model_validate(version["spec"])
        except ValidationError as error:
            raise CodegenError(422, "UNSUPPORTED_MODEL", "Stored model is not a valid BehavioralModel 1.0") from error
        if spec_hash(model) != version["spec_hash"]:
            raise CodegenError(409, "SPEC_HASH_MISMATCH", "Stored model does not match its spec_hash")
        try:
            check_supported(model, body["target"])
        except UnsupportedModel as error:
            raise CodegenError(422, "UNSUPPORTED_MODEL", "Model is outside the supported generation scope", error.issues) from error
        if snapshot["state"] != "holds" and not body["allow_unverified"]:
            details = [{"property_id": item["property_id"], "status": item["status"], "check_run_id": item["check_run_id"]}
                       for item in snapshot["properties"]]
            raise CodegenError(409, "VERIFICATION_REQUIRED",
                               f"TLC verification state is {snapshot['state']}; confirm generation with allow_unverified=true", details)
        snapshot["acknowledged"] = snapshot["state"] != "holds"
        return scope, body, version, snapshot, model

    def save_generation(self, prepared, key, application_files=()):
        scope, body, version, snapshot, model = prepared
        conditions = body.get("technical_conditions")
        project = generate_project(model, Provenance(version["id"], version["spec_hash"], snapshot), body["target"],
                                   conditions=conditions, application_files=application_files)
        record = {
            "generation_id": "gen_" + uuid4().hex, "session_id": version["session_id"], "model_id": version["model_id"],
            "version_id": version["id"], "version_number": version["number"], "spec_hash": version["spec_hash"],
            "code_hash": project.code_hash, "status": "completed", "target": body["target"],
            "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION},
            "technical_conditions": technical_conditions(conditions), "project_name": project.name,
            "application_mode": body.get("application_mode", "template"),
            "verification": project.verification, "coverage": project.coverage,
            "file_count": len(project.files), "total_bytes": sum(len(item.content) for item in project.files),
            "created_at": now(),
        }
        return self.repo.save_generation(scope, key, body, version, record, project.files)

    def get_generation(self, generation_id):
        return self.repo.get_generation(generation_id)

    def list_for_version(self, model_id, number):
        return self.repo.list_for_version(model_id, number)

    def list_for_session(self, session_id):
        return self.repo.list_for_session(session_id)

    def files(self, generation_id):
        return self.repo.files(generation_id)

    def file(self, generation_id, path):
        try:
            safe_path(path)
        except UnsafePath as error:
            raise CodegenError(404, "FILE_NOT_FOUND", "File is not part of this generation") from error
        return self.repo.file(generation_id, path)

    def archive(self, generation_id):
        record, files = self.repo.project(generation_id)
        return record, build_archive(record["project_name"], [(item.path, item.content) for item in files])

    # Запуски тестов

    def create_test_run(self, generation_id, body, key):
        try:
            body = TestRunCreate.model_validate(body).model_dump()
        except ValidationError as error:
            raise CodegenError(422, "INVALID_REQUEST", "Invalid test run request") from error
        return self.enqueue_test_run(generation_id, body, key)

    def create_comparison(self, generation_id, body, key):
        try:
            body = ComparisonCreate.model_validate(body).model_dump()
        except ValidationError as error:
            raise CodegenError(422, "INVALID_REQUEST", "Invalid comparison request") from error
        record, files = self.repo.project(generation_id)
        info, _, _ = comparison.prepare(self.repo.store, record, files, body)
        return self.enqueue_test_run(generation_id, body, key, info)

    def enqueue_test_run(self, generation_id, body, key, info=None):
        if self.closing:
            raise CodegenError(503, "SHUTTING_DOWN", "Server is shutting down")
        if self.loop is None:
            raise CodegenError(503, "COMPONENT_UNAVAILABLE", "Code generation executor is not started")
        timeout = float(body["timeout_seconds"] or self.settings.test_timeout_seconds)
        if timeout > self.settings.max_test_timeout_seconds:
            raise CodegenError(422, "INVALID_TIMEOUT", f"timeout_seconds must not exceed {self.settings.max_test_timeout_seconds:g}")
        run = self.repo.create_test_run(generation_id, body, key, timeout, self.settings.max_pending, info)
        if run["status"] == "queued":
            self.loop.call_soon_threadsafe(self.schedule, run["test_run_id"])
        return run

    def get_test_run(self, test_run_id):
        return self.repo.get_test_run(test_run_id)

    def list_test_runs(self, generation_id):
        return self.repo.list_test_runs(generation_id)

    def list_comparisons(self, generation_id):
        return self.repo.list_test_runs(generation_id, comparisons=True)

    def test_run_log(self, test_run_id):
        return self.repo.log(test_run_id)

    def cancel_test_run(self, test_run_id):
        run = self.repo.request_cancel(test_run_id)
        if run["status"] == "running" and self.loop is not None:
            self.loop.call_soon_threadsafe(self.stop, test_run_id)
        return run

    def schedule(self, test_run_id):
        if test_run_id in self.tasks:
            return
        self.stops[test_run_id] = asyncio.Event()
        task = self.loop.create_task(self.execute(test_run_id))
        self.tasks[test_run_id] = task

        def forget(_):
            self.tasks.pop(test_run_id, None)
            self.stops.pop(test_run_id, None)
        task.add_done_callback(forget)

    def stop(self, test_run_id):
        event = self.stops.get(test_run_id)
        if event is not None:
            event.set()

    async def execute(self, test_run_id):
        finish = self.repo.finish_test_run
        try:
            async with self.semaphore:
                if self.closing:
                    await asyncio.to_thread(finish, test_run_id, "cancelled", "SERVER_SHUTDOWN", {"message": "Сервер остановлен до начала запуска"})
                    return
                row = await asyncio.to_thread(self.repo.claim_test_run, test_run_id)
                if row is None:
                    return
                try:
                    record, files = await asyncio.to_thread(self.repo.project, row["generation_id"])
                    run = await asyncio.to_thread(self.repo.get_test_run, test_run_id)
                    saved = run.get("comparison")
                    cases = None
                    if saved is None:
                        job = [(item.path, item.content) for item in files]
                    else:
                        info, job, cases = await asyncio.to_thread(comparison.prepare, self.repo.store, record, files, saved)
                        if any(saved[key] != value for key, value in info.items()):
                            raise CodegenError(409, "COMPARISON_HASH_MISMATCH", "Pinned comparison inputs changed")
                except ServiceError as error:
                    await asyncio.to_thread(finish, test_run_id, "error", error.code, {"message": error.message})
                    return
                result, log = await self.sandbox.run(job, run_id=test_run_id,
                                                     timeout_seconds=row["timeout_seconds"], stop=self.stops.get(test_run_id))
                if cases is not None:
                    result["comparison"] = comparison.comparison_result(result, cases)
                    verdict = result["comparison"]["status"]
                    if verdict == "incompatible_adapter":
                        result.update(error_code="INCOMPATIBLE_ADAPTER")
                    elif verdict == "execution_error" and result["error_code"] in {None, "TESTS_FAILED"}:
                        result.update(status="error", error_code="COMPARISON_EXECUTION_ERROR")
                if result["status"] == "cancelled" and self.closing:
                    current = await asyncio.to_thread(self.repo.get_test_run, test_run_id)
                    if not current["cancel_requested"]:
                        result = {**result, "error_code": "SERVER_SHUTDOWN", "message": "Запуск прерван остановкой сервера"}
                await asyncio.to_thread(finish, test_run_id, result["status"], result["error_code"], result, log)
        except asyncio.CancelledError:
            await asyncio.to_thread(finish, test_run_id, "cancelled", "SERVER_SHUTDOWN", {"message": "Запуск прерван остановкой сервера"})
            raise
        except Exception:
            logger.exception("codegen_test_run_failed test_run_id=%s", test_run_id)
            await asyncio.to_thread(finish, test_run_id, "error", "SANDBOX_ERROR", {"message": "Внутренняя ошибка исполнителя тестов"})

    async def status(self):
        policy = self.sandbox.policy()
        try:
            policy.update(await self.sandbox.probe())
            state, reason = "ready", None
        except (SandboxUnavailable, asyncio.TimeoutError) as error:
            state, reason = "engine_unavailable", str(error) or "Docker did not answer"
        return {"target": TARGET, "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION},
                "technical_conditions": TECHNICAL_CONDITIONS, "supported_conditions": SUPPORTED_CONDITIONS, "limits": LIMITS,
                "sandbox_status": state, "sandbox_reason": reason, "sandbox": policy,
                "default_timeout_seconds": self.settings.test_timeout_seconds,
                "max_timeout_seconds": self.settings.max_test_timeout_seconds}
