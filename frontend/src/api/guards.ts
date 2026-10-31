import { ApiError } from "./errors";
import type {
  AgentRunTracePage, ArtifactEntry, CheckRun, DialogueView, DocumentUpload, Model, ModelVersion, Run, RunEvent, Session, SessionDetail,
} from "./types";

// Shallow structural checks: a response missing fields the UI depends on is
// reported as malformed instead of rendering as empty data.

type Guard<T> = (value: unknown) => value is T;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const RUN_STATES = new Set(["queued", "running", "cancelling", "cancelled", "completed", "failed"]);

export const isSession: Guard<Session> = (v): v is Session =>
  isObject(v) && isString(v.id) && isString(v.title) && isString(v.mode) && isString(v.created_at);

export const isSessionDetail: Guard<SessionDetail> = (v): v is SessionDetail =>
  isObject(v) && isSession(v) && Array.isArray(v.messages) && Array.isArray(v.sources) && Array.isArray(v.requirements);

export const isRun: Guard<Run> = (v): v is Run =>
  isObject(v) && isString(v.run_id) && isString(v.session_id) && isString(v.state) && RUN_STATES.has(v.state);

export const isModel: Guard<Model> = (v): v is Model => isObject(v) && isString(v.id) && isString(v.session_id) && isString(v.name);

export const isModelVersion: Guard<ModelVersion> = (v): v is ModelVersion =>
  isObject(v) && isString(v.id) && isString(v.model_id) && typeof v.number === "number"
  && isObject(v.spec) && Array.isArray((v.spec as Record<string, unknown>).variables)
  && Array.isArray((v.spec as Record<string, unknown>).transitions)
  && Array.isArray((v.spec as Record<string, unknown>).properties)
  && isString(v.spec_hash) && typeof v.approved === "boolean";

export const isCheckRun: Guard<CheckRun> = (v): v is CheckRun =>
  isObject(v) && isRun(v.run) && Array.isArray(v.results)
  && v.results.every((r) => isObject(r) && isString(r.property_id) && isString(r.status) && Array.isArray(r.trace) && isObject(r.statistics));

export const isArtifactEntry: Guard<ArtifactEntry> = (v): v is ArtifactEntry =>
  isObject(v) && isString(v.name) && typeof v.size === "number" && isString(v.sha256);

export const isRunEvent: Guard<RunEvent> = (v): v is RunEvent =>
  isObject(v) && Number.isInteger(v.event_id) && Number(v.event_id) >= 1 && isString(v.run_id) && isString(v.type) && isObject(v.data)
  && (v.created_at === undefined || v.created_at === null || isString(v.created_at));

export const isAgentRunTracePage: Guard<AgentRunTracePage> = (v): v is AgentRunTracePage =>
  isObject(v) && (v.next_cursor === null || (Number.isInteger(v.next_cursor) && Number(v.next_cursor) >= 1))
  && Array.isArray(v.runs) && v.runs.every(item => {
    if (!isObject(item) || !isRun(item.run)) return false;
    const run = item.run;
    return [item.input_entry_id, item.reply_entry_id, item.source_id, item.created_at, item.started_at, item.finished_at].every(value => value === null || isString(value))
      && typeof item.events_truncated === "boolean" && Array.isArray(item.events)
      && item.events.every(event => isRunEvent(event) && event.run_id === run.run_id && event.session_id === run.session_id);
  });

export function expect<T>(value: unknown, guard: Guard<T>, what: string): T {
  if (!guard(value)) throw new ApiError("malformed", what);
  return value;
}

export function expectList<T>(value: unknown, guard: Guard<T>, what: string): T[] {
  if (!Array.isArray(value) || !value.every(guard)) throw new ApiError("malformed", what);
  return value;
}

export const isDialogueView: Guard<DialogueView> = (v): v is DialogueView =>
  isObject(v) && isString(v.session_id) && ["not_started", "needs_clarification", "model_incomplete", "ready", "limit_reached"].includes(String(v.status))
  && Array.isArray(v.questions) && Array.isArray(v.requirements) && Array.isArray(v.open_question_ids) && Array.isArray(v.corrections)
  && (v.analysis === null || (isObject(v.analysis) && Array.isArray(v.analysis.assumptions) && Array.isArray(v.analysis.model_issues)))
  && (v.entries === undefined || (Array.isArray(v.entries) && v.entries.every(e => isObject(e) && isString(e.id) && isString(e.text)
    && typeof e.sequence === "number" && isString(e.created_at) && ["user", "assistant"].includes(String(e.kind)))))
  && (v.pending === null || (isObject(v.pending) && isString(v.pending.text) && isString(v.pending.source_id)));
export const isDocumentUpload: Guard<DocumentUpload> = (v): v is DocumentUpload =>
  isObject(v) && isObject(v.source) && isString(v.source.id) && isString(v.source.text) && v.source.text.trim().length > 0
  && isObject(v.document) && v.document.source_id === v.source.id && isString(v.document.filename)
  && typeof v.document.size_bytes === "number" && typeof v.document.characters === "number";
