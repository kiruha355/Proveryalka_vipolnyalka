from ..contracts import Source
from ..services import ServiceError
from ..storage.session import StoredSession


async def run_analyst(store, session_id, body):
    from ..agent.dialogue import load_dialogue, load_pending, resume_pending, start_dialogue, reply_dialogue
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
    previous = await load_dialogue(session)
    if previous is None:
        if body.get("source_id") is not None:
            source = store.get_source(session_id, body["source_id"])
        else:
            source = store.create_source(session_id, {"text": body["text"]}, body["source_key"])
        return await start_dialogue(Source.model_validate(source), session, run_id=run_id)
    if body.get("source_id") is not None:
        raise ServiceError(409, "DIALOGUE_STARTED", "A stored source can only start a new dialogue")
    return await reply_dialogue(session, body["text"], body.get("question_id"), run_id=run_id)
