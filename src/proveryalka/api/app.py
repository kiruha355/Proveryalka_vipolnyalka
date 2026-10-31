from contextlib import asynccontextmanager
from typing import Optional, Type

from fastapi import FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, StrictStr, create_model
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException

from ..config import Settings
from ..behavior import BehavioralModel
from ..verification import VerificationResult
from ..contracts import (
    CheckCreate, Contract, DialogueView, DocumentUpload, ErrorResponse, Event, ExplanationView,
    MessageCreate, Run, Session, SessionCreate, SessionDetail, Source, TextSourceCreate,
)
from ..services import Backend, ServiceError
from ..storage.sqlite import SQLiteStore
from .backend import ApplicationBackend


def create_app(
    settings: Optional[Settings] = None,
    backend: Optional[Backend] = None,
    behavioral_model: Type[BaseModel] = BehavioralModel,
    verification_result: Type[BaseModel] = VerificationResult,
    checker=None,
    analyst=None,
    explainer=None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = SQLiteStore(settings.database_path) if backend is None else None
    adapter = backend if backend is not None else ApplicationBackend(store, settings, checker, analyst, explainer)

    @asynccontextmanager
    async def lifespan(app):
        if store is not None:
            store.initialize()
            await adapter.start()
        try:
            yield
        finally:
            if store is not None:
                await adapter.close()

    app = FastAPI(title="Проверялка API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.backend = adapter
    Spec = behavioral_model
    Result = verification_result
    VersionCreate = create_model("VersionCreate", __base__=Contract, spec=(Spec, ...), parent_id=(Optional[str], None))
    Version = create_model(
        "ModelVersion", __base__=Contract, id=(str, ...), model_id=(str, ...),
        session_id=(str, ...), number=(int, ...), parent_id=(Optional[str], None),
        spec=(Spec, ...), spec_hash=(str, ...), approved=(bool, False),
    )
    ModelCreate = create_model("ModelCreate", __base__=Contract, name=(StrictStr, Field(min_length=1, max_length=200)))
    Model = create_model("Model", __base__=ModelCreate, id=(str, ...), session_id=(str, ...))
    from ..verification.contracts import CheckLimits
    CheckRequest = create_model("CheckRequest", __base__=CheckCreate, limits=(CheckLimits, Field(default_factory=CheckLimits)))
    Check = create_model(
        "CheckRun", __base__=Contract, run=(Run, ...),
        results=(list[Result], ...),
        explanation=(ExplanationView, Field(default_factory=lambda: ExplanationView(state="not_requested"))),
    )
    errors = {code: {"model": ErrorResponse} for code in (404, 409, 422, 429, 503)}
    errors[422]["description"] = "Unprocessable Entity"
    document_errors = {**errors, **{code: {"model": ErrorResponse} for code in (411, 413, 415)}}

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse(status_code=error.status, content={"error": {
            "code": error.code, "message": error.message, "details": [],
        }})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Do not echo user input (which can contain secrets) in error details.
        details = [{"path": list(e["loc"]), "type": e["type"], "message": e["msg"]}
                   for e in error.errors()]
        return JSONResponse(status_code=422, content={"error": {
            "code": "INVALID_REQUEST", "message": "Request validation failed", "details": details,
        }})

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse(status_code=error.status_code, headers=error.headers, content={"error": {
            "code": "HTTP_ERROR", "message": str(error.detail), "details": [],
        }})

    @app.get("/health", tags=["system"])
    def health():
        return {"status": "ok"}

    @app.get("/ready", tags=["system"], responses=errors)
    async def ready():
        if store is None:
            raise ServiceError(503, "COMPONENT_UNAVAILABLE", "Readiness requires application backend")
        try:
            store.list_sessions(limit=1)
            await adapter.checker.engine()
        except Exception as error:
            raise ServiceError(503, "DEPENDENCY_UNAVAILABLE", "SQLite or Java/TLC is unavailable; run python -m proveryalka.runtime") from error
        from ..agent.llm_config import provider_configured, provider_name
        try:
            provider, configured = provider_name(), provider_configured()
        except ValueError:
            provider, configured = None, False
        return {"status":"ready", "checker":"TLC", "llm_provider":provider, "agent_configured":configured}

    @app.post("/api/sessions", response_model=Session, status_code=201, responses=errors)
    def create_session(body: SessionCreate, idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_session", body=body.model_dump(), key=idempotency_key)

    @app.get("/api/sessions", response_model=list[Session], responses=errors)
    def list_sessions(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
        return adapter.call("list_sessions", limit=limit, offset=offset)

    @app.get("/api/sessions/{session_id}", response_model=SessionDetail, responses=errors)
    def get_session(session_id: str):
        return adapter.call("get_session", session_id=session_id)

    @app.post("/api/sessions/{session_id}/sources", response_model=Source, status_code=201, responses=errors)
    def create_source(session_id: str, body: TextSourceCreate,
                      idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_source", session_id=session_id, body=body.model_dump(), key=idempotency_key)

    document_body = {"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
        "type": "object", "required": ["file"],
        "properties": {"file": {"type": "string", "format": "binary", "description": ".txt, .md (UTF-8) или .docx"}},
    }}}}}

    @app.post("/api/sessions/{session_id}/documents", response_model=DocumentUpload, status_code=201,
              responses=document_errors, openapi_extra=document_body)
    async def upload_document(session_id: str, request: Request,
                              idempotency_key: str = Header(min_length=1, max_length=128)):
        # Размер проверяется до разбора multipart, чтобы большой файл не попадал во временное хранилище.
        length = request.headers.get("content-length", "")
        if not length.isdigit():
            raise ServiceError(411, "LENGTH_REQUIRED", "Content-Length is required for document upload")
        if int(length) > settings.max_document_bytes + 64 * 1024:
            raise ServiceError(413, "DOCUMENT_TOO_LARGE", f"Document exceeds {settings.max_document_bytes} bytes")
        form = await request.form(max_files=1, max_fields=1)
        try:
            upload = form.get("file")
            if not isinstance(upload, UploadFile):
                raise ServiceError(422, "INVALID_REQUEST", "Multipart field 'file' is required")
            data = await upload.read(settings.max_document_bytes + 1)
            filename = upload.filename
        finally:
            await form.close()
        return await run_in_threadpool(adapter.call, "create_document", session_id=session_id,
                                       filename=filename, data=data, key=idempotency_key)

    @app.post("/api/sessions/{session_id}/messages", response_model=Run, status_code=202, responses=errors)
    def send_message(session_id: str, body: MessageCreate,
                     idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("send_message", session_id=session_id, body=body.model_dump(exclude_none=True), key=idempotency_key)

    @app.get("/api/sessions/{session_id}/dialogue", response_model=DialogueView, responses=errors)
    def get_dialogue(session_id: str):
        return adapter.call("get_dialogue", session_id=session_id)

    @app.post("/api/sessions/{session_id}/pending/retry", response_model=Run, status_code=202, responses=errors)
    def retry_pending(session_id: str, idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("retry_pending", session_id=session_id, key=idempotency_key)

    @app.post("/api/sessions/{session_id}/pending/discard", response_model=DialogueView, responses=errors)
    def discard_pending(session_id: str):
        return adapter.call("discard_pending", session_id=session_id)

    @app.get("/api/runs/{run_id}", response_model=Run, responses=errors)
    def get_run(run_id: str):
        return adapter.call("get_run", run_id=run_id)

    @app.post("/api/runs/{run_id}/cancel", response_model=Run, status_code=202, responses=errors)
    def cancel_run(run_id: str):
        return adapter.call("cancel_run", run_id=run_id)

    @app.get("/api/runs/{run_id}/events", responses={
        **errors, 200: {"content": {"text/event-stream": {}}, "description": "Replayable SSE stream"},
    }, response_class=Response)
    def events(run_id: str, last_event_id: Optional[int] = Header(None, ge=0)):
        return adapter.call("events", run_id=run_id, after=last_event_id or 0)

    @app.post("/api/sessions/{session_id}/models", response_model=Model, status_code=201, responses=errors)
    def create_model_record(session_id: str, body: ModelCreate,
                            idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_model", session_id=session_id, body=body.model_dump(), key=idempotency_key)

    @app.get("/api/sessions/{session_id}/models", response_model=list[Model], responses=errors)
    def list_models(session_id: str):
        return adapter.call("list_models", session_id=session_id)

    @app.get("/api/models/{model_id}/versions", response_model=list[Version], responses=errors)
    def list_versions(model_id: str):
        return adapter.call("list_versions", model_id=model_id)

    @app.get("/api/models/{model_id}/versions/{number}", response_model=Version, responses=errors)
    def get_version(model_id: str, number: int):
        return adapter.call("get_version", model_id=model_id, number=number)

    @app.post("/api/models/{model_id}/versions", response_model=Version, status_code=201, responses=errors)
    def create_version(model_id: str, body: VersionCreate,
                       idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_version", model_id=model_id, body=body.model_dump(), key=idempotency_key)

    @app.post("/api/models/{model_id}/versions/{number}/approve", response_model=Version, responses=errors)
    def approve_version(model_id: str, number: int):
        return adapter.call("approve_version", model_id=model_id, number=number)

    @app.post("/api/models/{model_id}/versions/{number}/checks", response_model=Run, status_code=202, responses=errors)
    def create_check(model_id: str, number: int, body: CheckRequest,
                     idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_check", model_id=model_id, number=number, body=body.model_dump(), key=idempotency_key)

    @app.get("/api/checks/{run_id}", response_model=Check, responses=errors)
    def get_check(run_id: str):
        return adapter.call("get_check", run_id=run_id)

    @app.post("/api/checks/{run_id}/explanation", response_model=Run, status_code=202, responses=errors)
    def create_explanation(run_id: str, idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_explanation", check_run_id=run_id, key=idempotency_key)

    @app.get("/api/checks/{run_id}/artifacts", responses=errors)
    def list_artifacts(run_id: str):
        return adapter.call("list_artifacts", run_id=run_id)

    @app.get("/api/checks/{run_id}/artifacts/{name:path}", response_class=Response, responses=errors)
    def get_artifact(run_id: str, name: str):
        return adapter.call("get_artifact", run_id=run_id, name=name)

    original_openapi = app.openapi

    def openapi():
        schema = original_openapi()
        schema["components"]["schemas"]["Event"] = Event.model_json_schema()
        schema["info"]["description"] = (
            "Analyst dialogue, versioned models, TLC checks and explanations of saved reports. "
            "BehavioralModel 1.0 and VerificationResult 1.0 use shared contracts. "
            "TLC runs only on an explicit check request; explanations never re-run TLC."
        )
        return schema

    app.openapi = openapi
    return app


app = create_app()
