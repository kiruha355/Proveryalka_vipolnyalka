"""Bounded public operation history; excludes provider payloads and private reasoning."""
import json

from ..contracts import AgentRunTrace, AgentRunTracePage
from .history import dialogue_entries

PHASES = frozenset({"queued", "started", "context_ready", "model_request", "model_response",
                    "validation", "retry", "saving", "file_context_ready", "answer_ready"})
FACTS = frozenset({"phase", "purpose", "attempt", "outcome", "source_id", "sources_count",
                   "input_entry_id", "reply_entry_id", "path", "version_id", "number", "changed"})


def _public_event(event):
    kind, data = event.get("type"), event.get("data", {})
    safe = None
    if kind == "activity" and data.get("phase") in PHASES:
        safe = {key: value for key, value in data.items() if key in FACTS and isinstance(value, (str, int, bool))}
    elif kind == "message_delta":
        safe = {"characters": len(data.get("text", "")) if isinstance(data.get("text"), str) else 0}
    elif kind == "clarification_requested":
        safe = {"id": data.get("id"), "kind": data.get("kind")}
    elif kind == "model_proposed":
        safe = {key: data[key] for key in ("model_id", "version_id", "number", "changed") if key in data}
    elif kind == "dialogue_updated":
        safe = {key: data[key] for key in ("status", "round", "version_id") if key in data}
    elif kind == "run_finished":
        safe = {"state": data.get("state")}
    elif kind == "error":
        safe = {"code": data.get("code")}
    # Arbitrary legacy tool/provider payloads have no public trace projection.
    if safe is None:
        return None
    return {"event_id": event["event_id"], "run_id": event["run_id"], "session_id": event["session_id"],
            "type": kind, "created_at": event.get("created_at"), "data": safe}


def _history_links(rows):
    links, file_runs = {}, {}
    last_user, pending_run = None, None
    for row in rows:
        data = row["message_data"]
        content = data.get("content")
        if not isinstance(content, str):
            continue
        try:
            payload = json.loads(content) if content.startswith('{"') else {}
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        if data.get("role") == "user":
            if set(payload) != {"verification_request"}:
                last_user = row["id"]
        elif data.get("role") == "assistant":
            if "analyst_pending" in payload:
                turn = payload["analyst_pending"]
                pending_run = turn.get("run_id")
                if pending_run:
                    links.setdefault(pending_run, {}).update(input_entry_id=last_user, source_id=turn.get("source", {}).get("id"))
            elif "analyst_pending_cancelled" in payload:
                pending_run = None
            elif "analyst_dialogue" in payload:
                if pending_run:
                    links.setdefault(pending_run, {})["reply_entry_id"] = row["id"]
                pending_run = None
            elif "file_discussion" in payload:
                item = payload["file_discussion"]
                turn = item["turn_id"]
                if item["kind"] in ("user", "retry"):
                    file_runs[turn] = item["run_id"]
                    links.setdefault(item["run_id"], {})["input_entry_id"] = turn
                elif item["kind"] == "assistant" and turn in file_runs:
                    links.setdefault(file_runs[turn], {})["reply_entry_id"] = row["id"]
    return links


def agent_runs(store, session_id, render_turn, before=None, limit=50):
    """Newest-first cursor page. Missing historical timestamps stay unknown."""
    rows = store.history_rows(session_id)
    entries = dialogue_entries(rows, render_turn)
    links = _history_links(rows)
    source_entries = {entry["source_id"]: entry["id"] for entry in entries if entry.get("source_id") and entry["kind"] == "user"}
    with store.transaction() as connection:
        store._session(connection, session_id)
        records = connection.execute(
            "SELECT rowid AS cursor_id,* FROM runs WHERE session_id=? AND kind='agent' "
            "AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?", (session_id, before, before, limit + 1),
        ).fetchall()
        has_more = len(records) > limit
        traces = []
        for row in records[:limit]:
            stored = connection.execute("SELECT event_json FROM run_events WHERE run_id=? ORDER BY event_id LIMIT 201", (row["run_id"],)).fetchall()
            raw = [json.loads(event[0]) for event in stored[:200]]
            events = [value for event in raw if (value := _public_event(event)) is not None]
            tail = connection.execute("SELECT event_json FROM run_events WHERE run_id=? ORDER BY event_id DESC LIMIT 1", (row["run_id"],)).fetchone()
            last = json.loads(tail[0]) if tail else {}
            link = dict(links.get(row["run_id"], {}))
            for event in events:
                if event["type"] == "activity":
                    data = event["data"]
                    for key in ("source_id", "input_entry_id", "reply_entry_id"):
                        if key in data:
                            link[key] = data[key]
            if link.get("source_id") in source_entries:
                link["input_entry_id"] = source_entries[link["source_id"]]
            if row["state"] != "completed":
                link.pop("reply_entry_id", None)
            def timestamp(phase):
                return next((event.get("created_at") for event in events if event["type"] == "activity" and event["data"].get("phase") == phase), None)
            traces.append(AgentRunTrace(
                run={key: row[key] for key in ("run_id", "session_id", "state", "version_id", "error_code")},
                **link, created_at=timestamp("queued"), started_at=timestamp("started"),
                finished_at=last.get("created_at") if last.get("type") == "run_finished" else None,
                events=events, events_truncated=len(stored) > 200,
            ))
        cursor = records[limit - 1]["cursor_id"] if has_more else None
    return AgentRunTracePage(runs=traces, next_cursor=cursor).model_dump(mode="json")
