import json

from ..contracts import Source
from ..behavior import BehavioralModel
from ..services import ServiceError
from ..storage.session import StoredSession


async def run_analyst(store, session_id, body):
    from ..agent.dialogue import attach_source, load_dialogue, load_pending, resume_pending, start_dialogue, reply_dialogue
    session = StoredSession(store, session_id)
    run_id = body.get("run_id")
    pending = await load_pending(session)
    if body.get("retry_pending"):
        if pending is None:
            raise ServiceError(409, "NO_PENDING", "There is no unfinished message to retry")
        return await resume_pending(session)
    if pending is not None:
        # Explicit retry only; never silently discard the user's new text.
        if body.get("source_id") is not None or pending.source.text != body.get("text"):
            raise ServiceError(409, "PENDING_MESSAGE", "Retry or discard the unfinished message before sending a new one")
        return await resume_pending(session)
    base = None
    if body.get("base_version_id"):
        version = store.session_version(session_id, body["base_version_id"])
        base = (version["id"], BehavioralModel.model_validate(version["spec"]))
    if body.get("source_id") is not None:
        source = Source.model_validate(store.get_source(session_id, body["source_id"]))
        if body.get("text") is None:
            return await attach_source(session, source, run_id=run_id, base=base)
        impact = None
        if body.get("impact_review_id"):
            with store.transaction() as db:
                row = db.execute("SELECT record_json FROM version_reviews WHERE id=? AND session_id=?",
                                 (body["impact_review_id"], session_id)).fetchone()
            if row is None:
                raise ServiceError(404, "NOT_FOUND", "Предложение не найдено")
            impact = json.loads(row[0])
        return await reply_dialogue(session, body["text"], body.get("question_id"), run_id=run_id,
                                    base=base, attachment=source, impact=impact)
    previous = await load_dialogue(session)
    if previous is None and base is None:
        source = store.create_source(session_id, {"text": body["text"]}, body["source_key"])
        return await start_dialogue(Source.model_validate(source), session, run_id=run_id)
    return await reply_dialogue(session, body["text"], body.get("question_id"), run_id=run_id, base=base)
