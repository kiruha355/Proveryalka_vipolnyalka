"""Read-only public projection of persisted analyst turns, not SDK tool traffic."""
import json

from ..agent.clarification import DialogueState
from ..services import ServiceError


def dialogue_entries(rows, render_turn):
    entries = []
    pending = None
    last_user = None
    for row in rows:
        data = row["message_data"]
        role, content = data.get("role"), data.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        payload = None
        if content.startswith('{"'):
            try:
                candidate = json.loads(content)
                if isinstance(candidate, dict):
                    payload = candidate
            except ValueError:
                pass
        base = {"id": row["id"], "sequence": row["sequence"], "created_at": row["created_at"]}
        if role == "user":
            # Legacy verify_and_explain records an internal request as a user item.
            if payload is not None and set(payload) == {"verification_request"}:
                continue
            last_user = {**base, "kind": "user", "text": content, "status": "processed"}
            entries.append(last_user)
            continue
        if payload is None:
            entries.append({**base, "kind": "assistant", "text": content})
        elif "analyst_pending" in payload:
            turn = payload["analyst_pending"]
            source = turn.get("source", {})
            # A retry resumes the same pending turn and writes no second user item.
            if last_user is not None and last_user["text"] == source.get("text"):
                pending = last_user
                pending.update(source_id=source.get("id"), question_id=turn.get("question_id"), status="pending")
        elif "analyst_pending_cancelled" in payload:
            if pending is not None:
                pending["status"] = "discarded"
            pending = None
        elif "analyst_dialogue" in payload:
            try:
                state = DialogueState.model_validate(payload["analyst_dialogue"])
            except ValueError as error:
                raise ServiceError(409, "DIALOGUE_FORMAT", "Saved dialogue cannot be projected") from error
            if pending is not None:
                pending["status"] = "processed"
                pending = None
            entries.append({**base, "kind": "assistant", "text": state.reply or render_turn(state),
                            "questions": [q.model_dump(mode="json") for q in state.pending_questions]})
        # Other wrappers (verification, provider/tool data) have no chat entry.
    return entries
