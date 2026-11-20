import asyncio
import json
from time import monotonic

from agents import ModelBehaviorError
from fastapi import APIRouter, Header
from pydantic import Field, model_validator
from starlette.concurrency import run_in_threadpool

from ..agent.analysis import reference
from ..agent.errors import AgentError
from ..agent.review import review_model
from ..behavior import BehavioralModel
from ..contracts import Contract, ErrorResponse, Run, Source
from ..services import ServiceError
from ..storage.sqlite import encode, identifier, now


class ReviewRequest(Contract):
    snapshot_id: str | None = Field(default=None, max_length=200)
    feature: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def paired_input(self):
        if self.feature is not None and (not self.feature.strip() or not self.snapshot_id):
            raise ValueError("Для анализа новой функции нужен снимок репозитория и описание функции")
        return self


class VersionReviews:
    def __init__(self, store, repositories, backend):
        self.store = store
        self.repositories = repositories
        self.backend = backend
        self.running = backend.review_sessions

    def records(self, session_id, version_id):
        self.store.session_version(session_id, version_id)
        with self.store.transaction() as db:
            return [json.loads(row[0]) for row in db.execute(
                "SELECT record_json FROM version_reviews WHERE session_id=? AND version_id=? ORDER BY created_at DESC,id",
                (session_id, version_id),
            )]

    async def create(self, session_id, version_id, body, key):
        version = await run_in_threadpool(self.store.session_version, session_id, version_id)
        scope = f"review:{session_id}:{version_id}"
        request = body.model_dump()
        saved = await run_in_threadpool(self.store.idempotent_response, scope, key, request)
        if saved is not None:
            return saved
        if session_id in self.running or len(self.running) >= self.backend.settings.agent_parallel:
            raise ServiceError(429, "REVIEW_BUSY", "Дождитесь завершения текущего ревью")
        self.running.add(session_id)
        started = monotonic()
        try:
            saved = await run_in_threadpool(self.store.idempotent_response, scope, key, request)
            if saved is not None:
                return saved
            record = await asyncio.wait_for(self.generate(session_id, version, body, key),
                                            self.backend.settings.agent_timeout_seconds)
            record["elapsed_ms"] = round((monotonic() - started) * 1000)
            return await run_in_threadpool(self.save, scope, key, request, record)
        except TimeoutError as error:
            raise ServiceError(504, "RUN_TIMEOUT", "Ревью не завершилось за отведённое время") from error
        except AgentError as error:
            raise ServiceError(503, error.code, str(error)) from error
        except (ModelBehaviorError, ValueError) as error:
            raise ServiceError(422, "MODEL_OUTPUT_INVALID", "Ревью вернуло недостоверную ссылку или неверный формат") from error
        finally:
            self.running.remove(session_id)

    async def generate(self, session_id, version, body, key):
        model = BehavioralModel.model_validate(version["spec"])
        sources = {source.id: source for source in model.sources}
        context = None
        if body.snapshot_id:
            plan = await run_in_threadpool(self.repositories.plan, session_id, body.snapshot_id, (body.feature or model.name)[:500])
            context = await run_in_threadpool(self.repositories.materialize, session_id, body.snapshot_id, plan["selection"], key)
            source = Source.model_validate(context["source"])
            sources[source.id] = source
        mode = "impact" if body.feature else "review"
        async with self.backend.semaphores["agent"]:
            draft = await review_model({
                "mode": mode, "feature": body.feature, "model": model.model_dump(mode="json"),
                "repository_sources": [context["source"]] if context else [],
            })
        ids = {item.id for section in (model.requirements, model.variables, model.transitions, model.properties) for item in section}
        findings = []
        for item in draft.findings:
            if item.source_id not in sources or (item.element_id is not None and item.element_id not in ids):
                raise ValueError("Unknown source or model element")
            ref = reference(sources[item.source_id], item.quote)
            location = None
            if await run_in_threadpool(self.repositories.repositories.has_context, session_id, item.source_id):
                location = await run_in_threadpool(self.repositories.locate_reference, session_id, ref.source_id, ref.start, ref.end)
            if mode == "impact" and item.kind == "impact" and location is None:
                raise ValueError("An implementation change needs a repository location")
            findings.append({**item.model_dump(), "source_ref": ref.model_dump(), "location": location})
        return {
            "id": identifier("review"), "session_id": session_id, "version_id": version["id"],
            "spec_hash": version["spec_hash"], "created_at": now(), "mode": mode, "feature": body.feature,
            "source_id": context["source"]["id"] if context else None, "summary": draft.summary,
            "findings": findings, "model_calls": 1,
        }

    def save(self, scope, key, request, record):
        with self.store.transaction(write=True) as db:
            self.store._session(db, record["session_id"])

            def action():
                db.execute("INSERT INTO version_reviews VALUES (?,?,?,?,?)",
                           (record["id"], record["session_id"], record["version_id"], record["created_at"], encode(record)))
                return record

            return self.store._idempotent(db, scope, key, request, action)

    def apply(self, session_id, version_id, review_id):
        with self.store.transaction() as db:
            row = db.execute("SELECT record_json FROM version_reviews WHERE id=? AND session_id=? AND version_id=?",
                             (review_id, session_id, version_id)).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Предложение не найдено")
        review = json.loads(row[0])
        if review["mode"] != "impact":
            raise ServiceError(422, "INVALID_REQUEST", "Применять можно только предложение новой функции")
        return self.backend.call("send_message", session_id=session_id, body={
            "text": review["feature"], "source_id": review["source_id"], "base_version_id": version_id,
            "impact_review_id": review_id,
        }, key=f"impact:{review_id}")


def create_reviews_router(store, repositories, backend):
    service = VersionReviews(store, repositories, backend)
    router = APIRouter(prefix="/api/sessions/{session_id}/versions/{version_id}/reviews", tags=["reviews"])
    errors = {code: {"model": ErrorResponse} for code in (404, 409, 422, 429, 503, 504)}

    @router.get("", responses=errors)
    def records(session_id: str, version_id: str):
        return service.records(session_id, version_id)

    @router.post("", status_code=201, responses=errors)
    async def create(session_id: str, version_id: str, body: ReviewRequest,
                     idempotency_key: str = Header(min_length=1, max_length=128)):
        return await service.create(session_id, version_id, body, idempotency_key)

    @router.post("/{review_id}/apply", status_code=202, response_model=Run, responses=errors)
    def apply(session_id: str, version_id: str, review_id: str):
        return service.apply(session_id, version_id, review_id)

    return router
