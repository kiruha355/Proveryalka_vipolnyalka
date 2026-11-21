"""Additive router. Mount on the existing app; owns no backend/process lifecycle."""
from fastapi import APIRouter, Header, Query

from ..contracts import ErrorResponse, Run
from ..sources.repositories.dto import (
    RepositoryContext, RepositoryImport, RepositoryPlan, RepositoryRefresh, RepositoryScope, RepositorySelection, RepositorySnapshot,
)


def create_repository_router(service, backend):
    from ..services import ServiceError
    from ..sources.repositories.dto import RepositorySelectionRequest
    from .repository_browser import create_repository_browser_router

    router = APIRouter(prefix="/api/sessions/{session_id}/repositories", tags=["repositories"])
    errors = {status: {"model": ErrorResponse} for status in (403, 404, 409, 413, 422, 429, 502, 503, 504)}

    @router.post("", response_model=RepositorySnapshot, status_code=201, responses=errors)
    def import_snapshot(session_id: str, body: RepositoryImport,
                        idempotency_key: str = Header(min_length=1, max_length=128)):
        return service.import_snapshot(session_id, body.model_dump(), idempotency_key)

    @router.get("", response_model=list[RepositorySnapshot], responses=errors)
    def list_snapshots(session_id: str, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
        return service.repositories.list(session_id, limit, offset)

    @router.get("/{snapshot_id}", response_model=RepositorySnapshot, responses=errors)
    def get_snapshot(session_id: str, snapshot_id: str):
        return service.repositories.get(session_id, snapshot_id)

    @router.post("/{snapshot_id}/selection", response_model=RepositoryPlan, responses=errors)
    def plan(session_id: str, snapshot_id: str, body: RepositoryScope):
        state, _ = backend.dialogue_items(session_id) if body.extend else (None, None)
        return service.plan(session_id, snapshot_id, body.query, [source.id for source in state.sources] if state else ())

    @router.post("/{snapshot_id}/refresh", response_model=RepositorySnapshot, status_code=201, responses=errors)
    def refresh(session_id: str, snapshot_id: str, body: RepositoryRefresh,
                idempotency_key: str = Header(min_length=1, max_length=128)):
        return service.refresh(session_id, snapshot_id, body.model_dump(), idempotency_key)

    def resolve_selection(session_id, snapshot_id, body):
        plan = getattr(service, "plan", None)
        if body.files and not getattr(body, "auto_select", False):
            explicit = body.model_dump(exclude={"auto_select"}, exclude_none=True)
            if "query" not in explicit or plan is not None:
                return explicit
        plan = getattr(service, "plan", None)
        if plan is None:
            raise ServiceError(503, "COMPONENT_UNAVAILABLE", "Repository selection service is unavailable")
        snapshot = service.repositories.get(session_id, snapshot_id)
        if body.manifest_sha256 != snapshot["manifest_sha256"]:
            raise ServiceError(409, "REPOSITORY_MANIFEST_MISMATCH", "Snapshot manifest hash differs; reload the index")
        return plan(session_id, snapshot_id, body.query or "")["selection"]

    @router.post("/{snapshot_id}/context", response_model=RepositoryContext, status_code=201, responses=errors)
    def context(session_id: str, snapshot_id: str, body: RepositorySelection | RepositorySelectionRequest,
                idempotency_key: str = Header(min_length=1, max_length=128)):
        return service.materialize(session_id, snapshot_id, resolve_selection(session_id, snapshot_id, body), idempotency_key)

    @router.post("/{snapshot_id}/analysis", response_model=Run, status_code=202, responses=errors)
    def analyze(session_id: str, snapshot_id: str, body: RepositorySelection | RepositorySelectionRequest,
                idempotency_key: str = Header(min_length=1, max_length=128)):
        return service.analyze(session_id, snapshot_id, resolve_selection(session_id, snapshot_id, body), idempotency_key, backend)

    router.include_router(create_repository_browser_router(service, errors))
    return router
