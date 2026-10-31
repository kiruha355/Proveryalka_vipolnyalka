"""HTTP-маршруты генерации кода и запуска тестов: отдельный APIRouter со своим lifespan.

Подключение: app.include_router(create_codegen_router(store)); FastAPI объединяет lifespan роутера
с lifespan приложения (сначала инициализация хранилища, затем исполнитель тестов).
"""
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse, Response

from ..codegen.dto import CodegenStatus, GeneratedFileEntry, Generation, GenerationCreate, TestRun, TestRunCreate
from ..codegen.service import CodegenService
from ..contracts import ErrorResponse
from ..services import ServiceError


TEXT = {"text/x-python", "text/markdown", "text/plain", "application/json"}


def error_response(error):
    return JSONResponse(status_code=error.status, content={"error": {
        "code": error.code, "message": error.message, "details": getattr(error, "details", []),
    }})


def create_codegen_router(store, settings=None, sandbox=None):
    service = CodegenService(store, settings, sandbox)

    @asynccontextmanager
    async def lifespan(app):
        await service.start()
        try:
            yield
        finally:
            await service.close()

    router = APIRouter(tags=["codegen"], lifespan=lifespan)
    router.codegen = service
    errors = {code: {"model": ErrorResponse} for code in (404, 409, 422, 429, 503)}

    def call(function, *args):
        try:
            return function(*args)
        except ServiceError as error:
            return error_response(error)

    @router.get("/api/codegen/status", response_model=CodegenStatus)
    async def codegen_status():
        return await service.status()

    @router.post("/api/models/{model_id}/versions/{number}/generations", response_model=Generation, status_code=201, responses=errors)
    def create_generation(model_id: str, number: int, body: Optional[GenerationCreate] = None,
                          idempotency_key: str = Header(min_length=1, max_length=128)):
        return call(service.generate, model_id, number, (body or GenerationCreate()).model_dump(), idempotency_key)

    @router.get("/api/models/{model_id}/versions/{number}/generations", response_model=list[Generation], responses=errors)
    def list_version_generations(model_id: str, number: int):
        return call(service.list_for_version, model_id, number)

    @router.get("/api/sessions/{session_id}/generations", response_model=list[Generation], responses=errors)
    def list_session_generations(session_id: str):
        return call(service.list_for_session, session_id)

    @router.get("/api/generations/{generation_id}", response_model=Generation, responses=errors)
    def get_generation(generation_id: str):
        return call(service.get_generation, generation_id)

    @router.get("/api/generations/{generation_id}/files", response_model=list[GeneratedFileEntry], responses=errors)
    def list_files(generation_id: str):
        return call(service.files, generation_id)

    @router.get("/api/generations/{generation_id}/files/{path:path}", response_class=Response, responses=errors)
    def get_file(generation_id: str, path: str):
        try:
            entry, content = service.file(generation_id, path)
        except ServiceError as error:
            return error_response(error)
        media = entry["media_type"] + ("; charset=utf-8" if entry["media_type"] in TEXT else "")
        return Response(content, media_type=media, headers={
            "X-Content-Type-Options": "nosniff", "ETag": f'"{entry["sha256"]}"', "X-Content-SHA256": entry["sha256"],
        })

    @router.get("/api/generations/{generation_id}/archive", response_class=Response, responses=errors)
    def get_archive(generation_id: str):
        try:
            record, data = service.archive(generation_id)
        except ServiceError as error:
            return error_response(error)
        name = quote(f"{record['project_name']}-{generation_id}.zip")
        return Response(data, media_type="application/zip", headers={
            "Content-Disposition": f"attachment; filename=\"{name}\"", "X-Content-Type-Options": "nosniff",
            "X-Code-Hash": record["code_hash"],
        })

    @router.post("/api/generations/{generation_id}/test-runs", response_model=TestRun, status_code=202, responses=errors)
    def create_test_run(generation_id: str, body: Optional[TestRunCreate] = None,
                        idempotency_key: str = Header(min_length=1, max_length=128)):
        return call(service.create_test_run, generation_id, (body or TestRunCreate()).model_dump(), idempotency_key)

    @router.get("/api/generations/{generation_id}/test-runs", response_model=list[TestRun], responses=errors)
    def list_test_runs(generation_id: str):
        return call(service.list_test_runs, generation_id)

    @router.get("/api/test-runs/{test_run_id}", response_model=TestRun, responses=errors)
    def get_test_run(test_run_id: str):
        return call(service.get_test_run, test_run_id)

    @router.post("/api/test-runs/{test_run_id}/cancel", response_model=TestRun, status_code=202, responses=errors)
    def cancel_test_run(test_run_id: str):
        return call(service.cancel_test_run, test_run_id)

    @router.get("/api/test-runs/{test_run_id}/log", response_class=Response, responses=errors)
    def get_test_run_log(test_run_id: str):
        try:
            log = service.test_run_log(test_run_id)
        except ServiceError as error:
            return error_response(error)
        return Response(log.encode("utf-8"), media_type="text/plain; charset=utf-8", headers={"X-Content-Type-Options": "nosniff"})

    return router
