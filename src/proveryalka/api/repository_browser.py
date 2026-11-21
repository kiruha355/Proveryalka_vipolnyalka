from fastapi import APIRouter, Query

from ..contracts import Contract
from ..services import ServiceError
from ..sources.repositories.dto import RepositoryRange
from ..sources.repositories.index import digest, file_lines


class RepositoryContent(Contract):
    commit_sha: str
    path: str
    sha256: str
    start_line: int
    total_lines: int
    lines: list[str]


class RepositoryContextSummary(Contract):
    source_id: str
    size_bytes: int
    ranges: list[RepositoryRange]


def create_repository_browser_router(service, errors):
    router = APIRouter()

    @router.get("/{snapshot_id}/files/content", response_model=RepositoryContent, responses=errors)
    def file_content(session_id: str, snapshot_id: str, path: str = Query(min_length=1, max_length=1000),
                     start_line: int = Query(1, ge=1), end_line: int | None = Query(None, ge=1)):
        snapshot, item, content = service.repositories.read_file(session_id, snapshot_id, path)
        if digest(content.encode()) != item["sha256"]:
            raise ServiceError(409, "REPOSITORY_FILE_HASH_MISMATCH", "Saved file differs from snapshot content")
        lines = file_lines(content)
        last = len(lines) if end_line is None else end_line
        empty = not lines and start_line == 1 and end_line is None
        if not empty and not 1 <= start_line <= last <= len(lines):
            raise ServiceError(422, "REPOSITORY_RANGE_INVALID", "Requested lines exceed file length")
        return {"commit_sha": snapshot["commit_sha"], "path": item["path"], "sha256": item["sha256"],
                "start_line": start_line, "total_lines": len(lines), "lines": lines[start_line - 1:last]}

    @router.get("/{snapshot_id}/context", response_model=RepositoryContextSummary | None, responses=errors)
    def latest_context(session_id: str, snapshot_id: str):
        return service.repositories.latest_context(session_id, snapshot_id)

    return router
