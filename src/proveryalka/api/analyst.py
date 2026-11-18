from ..contracts import Source
from ..storage.session import StoredSession


async def run_analyst(store, session_id, body):
    from ..agent.dialogue import load_dialogue, load_pending, resume_pending, start_dialogue, reply_dialogue
    session = StoredSession(store, session_id)
    pending = await load_pending(session)
    if pending is not None:
        # Explicit retry only; never silently discard the user's new text.
        if pending.source.text != body["text"]:
            from ..services import ServiceError
            raise ServiceError(409, "PENDING_MESSAGE", "Retry the unfinished message before sending a new one")
        return await resume_pending(session)
    previous = await load_dialogue(session)
    if previous is None:
        source = store.create_source(session_id, {"text": body["text"]}, body["source_key"])
        return await start_dialogue(Source.model_validate(source), session)
    return await reply_dialogue(session, body["text"], body.get("question_id"))
