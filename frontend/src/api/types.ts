// Public HTTP DTOs and BehavioralModel 1.0. See api/README.md in the backend.

export type SessionMode = "analyzer" | "debugger" | "overview" | "codegen";

export interface Session {
  id: string;
  title: string;
  mode: SessionMode;
  created_at: string;
}

export interface Source {
  id: string;
  session_id: string;
  kind: "text";
  text: string;
}

export interface Message {
  id: string;
  session_id: string;
  sequence: number;
  message_data: Record<string, unknown>;
  created_at: string;
}

export interface SessionRequirement {
  id: string;
  session_id: string;
  source_id: string;
  code: string;
  text: string;
}

export interface SessionDetail extends Session {
  messages: Message[];
  sources: Source[];
  requirements: SessionRequirement[];
  documents?: DocumentInfo[];
}

export type RunState = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export interface Run {
  run_id: string;
  session_id: string;
  state: RunState;
  version_id: string | null;
  error_code: string | null;
}

export const TERMINAL_RUN_STATES: readonly RunState[] = ["cancelled", "completed", "failed"];

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

// ---- BehavioralModel 1.0 ----

export type Value = boolean | number | string;

export type Expression =
  | { kind: "literal"; value: Value }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "not" | "neg"; operand: Expression }
  | { kind: "binary"; op: BinaryOp; left: Expression; right: Expression };

export type BinaryOp =
  | "and" | "or" | "implies"
  | "eq" | "ne" | "lt" | "le" | "gt" | "ge"
  | "add" | "sub" | "mul";

export type Domain =
  | { kind: "boolean" }
  | { kind: "integer"; minimum: number; maximum: number }
  | { kind: "enum"; values: string[] };

export interface SourceRef {
  source_id: string;
  quote: string;
  start: number;
  end: number;
}

export interface ExtractedRequirement {
  id: string;
  text: string;
  source_refs: SourceRef[];
}

interface LinkedElement {
  id: string;
  name: string;
  requirement_ids: string[];
}

export interface Variable extends LinkedElement {
  domain: Domain;
  initial_value: Value;
}

export interface Assignment {
  variable: string;
  value: Expression;
}

export interface Transition extends LinkedElement {
  guard: Expression;
  effects: Assignment[];
}

export type PropertyKind = "invariant" | "forbidden_state" | "reachable" | "deadlock_free";

export interface Property extends LinkedElement {
  kind: PropertyKind;
  predicate: Expression;
  explanation: string;
  origin?: "requirement" | "proposal";
  approved_by?: SourceRef | null;
}

export interface BehavioralModel {
  schema_version: "1.0";
  name: string;
  sources: Source[];
  requirements: ExtractedRequirement[];
  variables: Variable[];
  transitions: Transition[];
  properties: Property[];
}

export interface Model {
  id: string;
  session_id: string;
  name: string;
}

export interface ModelVersion {
  id: string;
  model_id: string;
  session_id: string;
  number: number;
  parent_id: string | null;
  spec: BehavioralModel;
  spec_hash: string;
  approved: boolean;
}

// ---- Verification ----

export type VerificationStatus =
  | "PROPERTY_HOLDS"
  | "PROPERTY_VIOLATED"
  | "MODEL_INVALID"
  | "TIMEOUT"
  | "STATE_LIMIT_REACHED"
  | "ENGINE_ERROR";

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "PROPERTY_HOLDS", "PROPERTY_VIOLATED", "MODEL_INVALID", "TIMEOUT", "STATE_LIMIT_REACHED", "ENGINE_ERROR",
];

export interface CheckLimits {
  timeout_seconds: number;
  max_states: number;
  max_depth: number | null;
}

export const DEFAULT_LIMITS: CheckLimits = { timeout_seconds: 30, max_states: 100_000, max_depth: null };

export interface TraceStep {
  number: number;
  transition_id: string | null;
  state: Record<string, Value>;
}

export interface CheckStatistics {
  states_generated: number | null;
  distinct_states: number | null;
  depth: number | null;
  elapsed_seconds: number | null;
}

export interface VerificationResult {
  schema_version: "1.0";
  spec_hash: string;
  version_id: string | null;
  mode: "engine" | "test";
  executed: boolean;
  engine: { name: string; version: string } | null;
  limits: CheckLimits;
  property_id: string;
  status: VerificationStatus;
  conclusive: boolean;
  message: string;
  trace: TraceStep[];
  statistics: CheckStatistics;
  related_requirements: string[];
}

export interface CheckRun {
  run: Run;
  results: VerificationResult[];
  explanation?: ExplanationView;
}

export interface ArtifactEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface CheckRequest {
  property_ids?: string[] | null;
  explain?: boolean;
  limits?: Partial<CheckLimits>;
}

// ---- Run events (SSE) ----

export type RunEventType =
  | "message_delta" | "tool_call" | "clarification_requested" | "model_proposed"
  | "dialogue_updated" | "explanation_queued" | "explanation_started" | "explanation_ready"
  | "check_started" | "check_finished" | "file_written" | "run_finished" | "error";

export interface RunEvent {
  event_id: number;
  run_id: string;
  session_id: string;
  type: RunEventType;
  data: Record<string, unknown>;
}

// ---- Analyst dialogue (stored in SessionDetail.messages) ----

export type QuestionKind = "missing" | "conflict" | "assumption";
export type QuestionStatus = "open" | "answered" | "confirmed" | "rejected";

export interface Question {
  id: string;
  text: string;
  reason: string;
  kind: QuestionKind;
  assumption: string | null;
  status: QuestionStatus;
  answer_source_id: string | null;
}

export interface Fact {
  text: string;
  quote: string;
}

export interface Assumption extends Fact {
  reason: string;
}

export interface Contradiction {
  description: string;
  quotes: string[];
}

export interface ModelIssue {
  path: string;
  message: string;
}

export interface AnalysisProperty {
  id: string;
  name: string;
  requirement_ids: string[];
  kind: PropertyKind;
  predicate: Expression | null;
  quote: string;
  explanation: string;
  origin: "requirement" | "proposal";
  assumption: string | null;
}

export interface Analysis {
  subject: string | null;
  source: Source;
  requirements: ExtractedRequirement[];
  entities: Fact[];
  participants: Fact[];
  initial_state: Fact[];
  properties: AnalysisProperty[];
  assumptions: Assumption[];
  contradictions: Contradiction[];
  missing_information: string[];
  behavior: BehavioralModel | null;
  model_issues: ModelIssue[];
}

export interface AppliedCorrection {
  requirement_id: string;
  reason: string;
  quote: string;
  answer_source_id: string;
}

export type DialogueStatus = "needs_clarification" | "model_incomplete" | "ready" | "limit_reached";

export interface DialogueState {
  schema_version: "2.0";
  sources: Source[];
  analysis: Analysis;
  questions: Question[];
  answers: { source_id: string; question_id: string | null }[];
  corrections: AppliedCorrection[];
  property_approvals: Record<string, SourceRef>;
  round: number;
  max_rounds: number;
  status: DialogueStatus;
}

export interface TraceComment {
  number: number;
  explanation: string;
}

export interface PropertyExplanation {
  property_id: string;
  explanation: string;
  steps: TraceComment[];
  hypotheses: string[];
}

export interface VerificationNarrative {
  summary: string;
  properties: PropertyExplanation[];
  question: string | null;
}

export interface VerificationOutcome {
  report: { results: VerificationResult[] };
  explanation: VerificationNarrative | null;
  check_id?: string | null;
}

// Uploaded TXT/MD/DOCX document. Planned backend contract (see
// reports/project-review-20261031/frontend-module-contract.md); used only when
// capabilities().documents is true.
export interface DocumentSource {
  id: string;
  session_id: string;
  filename: string;
  media_type: string;
  size: number;
  status: "extracted" | "failed";
  /** Extracted plain text; null when extraction failed. */
  text: string | null;
  error: { code: string; message: string } | null;
}

export interface ReadyInfo {
  status: string;
  checker?: string;
  agent_configured?: boolean;
}

export interface DocumentInfo {
  source_id: string; filename: string; format: "txt" | "md" | "docx";
  media_type: string; size_bytes: number; sha256: string; characters: number;
}
export interface DocumentUpload { source: Source; document: DocumentInfo }
export interface DialogueEntry {
  id: string; sequence: number; created_at: string; kind: "user" | "assistant"; text: string;
  source_id?: string | null; question_id?: string | null; status?: "processed" | "pending" | "discarded" | null;
  questions?: Question[];
}
export interface DialogueView {
  entries?: DialogueEntry[];
  session_id: string; status: DialogueStatus | "not_started";
  round: number | null; max_rounds: number | null; reply: string | null;
  requirements: (ExtractedRequirement & {code: string})[];
  questions: Question[]; open_question_ids: string[]; corrections: AppliedCorrection[];
  analysis: Analysis | null;
  model: {model_id: string; version_id: string; number: number; spec_hash: string} | null;
  pending: {source_id: string; text: string; question_id: string | null; run_id: string | null; run_state: RunState | null} | null;
}
export interface ExplanationView {
  state: "not_requested" | "queued" | "running" | "ready" | "failed" | "cancelled";
  run_id: string | null; error_code: string | null; narrative: VerificationNarrative | null;
}
