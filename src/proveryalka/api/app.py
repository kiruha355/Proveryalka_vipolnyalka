from contextlib import asynccontextmanager
from typing import Optional, Type

from fastapi import FastAPI, Header, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, create_model
from starlette.exceptions import HTTPException

from ..config import Settings
from ..behavior import BehavioralModel
from ..verification import VerificationResult
from ..contracts import (
    CheckCreate, Contract, ErrorResponse, Event, MessageCreate, Run, Session,
    SessionCreate, SessionDetail, Source, TextSourceCreate,
)
from ..services import Backend, ServiceError
from ..storage.sqlite import SQLiteBackend, SQLiteStore


def create_app(
    settings: Optional[Settings] = None,
    backend: Optional[Backend] = None,
    behavioral_model: Type[BaseModel] = BehavioralModel,
    verification_result: Type[BaseModel] = VerificationResult,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = SQLiteStore(settings.database_path) if backend is None else None
    adapter = backend if backend is not None else SQLiteBackend(store)

    @asynccontextmanager
    async def lifespan(app):
        if store is not None:
            store.initialize()
        yield

    app = FastAPI(title="Проверялка API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.backend = adapter
    Spec = behavioral_model
    Result = verification_result
    VersionCreate = create_model("VersionCreate", __base__=Contract, spec=(Spec, ...))
    Version = create_model(
        "ModelVersion", __base__=Contract, id=(str, ...), model_id=(str, ...),
        session_id=(str, ...), number=(int, ...), parent_id=(Optional[str], None),
        spec=(Spec, ...), spec_hash=(str, ...), approved=(bool, False),
    )
    Check = create_model(
        "CheckRun", __base__=Contract, run=(Run, ...),
        results=(list[Result], ...),
    )
    errors = {code: {"model": ErrorResponse} for code in (404, 409, 422, 503)}
    errors[422]["description"] = "Unprocessable Entity"

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

    @app.post("/api/sessions/{session_id}/messages", response_model=Run, status_code=202, responses=errors)
    def send_message(session_id: str, body: MessageCreate,
                     idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("send_message", session_id=session_id, body=body.model_dump(), key=idempotency_key)

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
    def create_check(model_id: str, number: int, body: CheckCreate,
                     idempotency_key: str = Header(min_length=1, max_length=128)):
        return adapter.call("create_check", model_id=model_id, number=number, body=body.model_dump(), key=idempotency_key)

    @app.get("/api/checks/{run_id}", response_model=Check, responses=errors)
    def get_check(run_id: str):
        return adapter.call("get_check", run_id=run_id)

    @app.get("/api/checks/{run_id}/artifacts/{name}", response_class=Response, responses=errors)
    def get_artifact(run_id: str, name: str):
        return adapter.call("get_artifact", run_id=run_id, name=name)

    original_openapi = app.openapi

    def openapi():
        schema = original_openapi()
        schema["components"]["schemas"]["Event"] = Event.model_json_schema()
        schema["info"]["description"] = (
            "API foundation. Unconnected operations return 503. "
            "BehavioralModel 1.0 and VerificationResult 1.0 use shared contracts. "
            "The checking engine is not connected by default."
        )
        return schema

    app.openapi = openapi
    return app


app = create_app()
