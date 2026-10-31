import { ApiError } from "./errors";
import type {
  ArtifactEntry, CheckRun, Model, ModelVersion, Run, RunEvent, Session, SessionDetail,
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
  isObject(v) && typeof v.event_id === "number" && v.event_id >= 1 && isString(v.run_id) && isString(v.type) && isObject(v.data);

export function expect<T>(value: unknown, guard: Guard<T>, what: string): T {
  if (!guard(value)) throw new ApiError("malformed", what);
  return value;
}

export function expectList<T>(value: unknown, guard: Guard<T>, what: string): T[] {
  if (!Array.isArray(value) || !value.every(guard)) throw new ApiError("malformed", what);
  return value;
}
