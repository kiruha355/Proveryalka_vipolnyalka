/**
 * Типы BehavioralModel 1.0 и HTTP DTO, совпадающие с backend 62c12b8:
 * src/proveryalka/behavior/{contracts,expressions}.py, contracts.py,
 * verification/contracts.py, api/app.py. Сервер остаётся источником истины
 * (Pydantic, extra="forbid"); здесь нет полей, которых нет на сервере.
 */

export type Value = boolean | number | string;

export type LiteralExpression = { kind: "literal"; value: Value };
export type VariableExpression = { kind: "variable"; name: string };
export type UnaryOp = "not" | "neg";
export type UnaryExpression = {
  kind: "unary";
  op: UnaryOp;
  operand: Expression;
};
export type BinaryOp =
  | "and"
  | "or"
  | "implies"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "add"
  | "sub"
  | "mul";
export type BinaryExpression = {
  kind: "binary";
  op: BinaryOp;
  left: Expression;
  right: Expression;
};
export type Expression =
  | LiteralExpression
  | VariableExpression
  | UnaryExpression
  | BinaryExpression;

export type BooleanDomain = { kind: "boolean" };
export type IntegerDomain = {
  kind: "integer";
  minimum: number;
  maximum: number;
};
export type EnumDomain = { kind: "enum"; values: string[] };
export type Domain = BooleanDomain | IntegerDomain | EnumDomain;
export type ValueType = Domain["kind"];

export type Source = {
  id: string;
  session_id: string;
  kind: "text";
  text: string;
};
export type SourceRef = {
  source_id: string;
  quote: string;
  start: number;
  end: number;
};
export type ExtractedRequirement = {
  id: string;
  text: string;
  source_refs: SourceRef[];
};

export type LinkedElement = {
  id: string;
  name: string;
  requirement_ids: string[];
};
export type Variable = LinkedElement & { domain: Domain; initial_value: Value };
export type Assignment = { variable: string; value: Expression };
export type Transition = LinkedElement & {
  guard: Expression;
  effects: Assignment[];
};
export type PropertyKind =
  | "invariant"
  | "forbidden_state"
  | "reachable"
  | "deadlock_free";
export type Property = LinkedElement & {
  kind: PropertyKind;
  predicate: Expression;
  explanation: string;
  origin: "requirement" | "proposal";
  approved_by: SourceRef | null;
};

export type BehavioralModel = {
  schema_version: "1.0";
  name: string;
  sources: Source[];
  requirements: ExtractedRequirement[];
  variables: Variable[];
  transitions: Transition[];
  properties: Property[];
};

export type ModelVersion = {
  id: string;
  model_id: string;
  session_id: string;
  number: number;
  parent_id: string | null;
  spec: BehavioralModel;
  spec_hash: string;
  approved: boolean;
};

export type RunState =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";
export type Run = {
  run_id: string;
  session_id: string;
  version_id: string | null;
  state: RunState;
  error_code: string | null;
};

export type VerificationStatus =
  | "PROPERTY_HOLDS"
  | "PROPERTY_VIOLATED"
  | "MODEL_INVALID"
  | "TIMEOUT"
  | "STATE_LIMIT_REACHED"
  | "ENGINE_ERROR";

export type CheckLimits = {
  timeout_seconds: number;
  max_states: number;
  max_depth: number | null;
};
export type TraceStep = {
  number: number;
  transition_id: string | null;
  state: Record<string, Value>;
};
export type CheckStatistics = {
  states_generated: number | null;
  distinct_states: number | null;
  depth: number | null;
  elapsed_seconds: number | null;
};

export type VerificationResult = {
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
};

/** Ответ `GET /api/checks/{run_id}`. Пока отчёта нет, results = [] — это не «нарушений нет». */
export type CheckRun = { run: Run; results: VerificationResult[] };

export type ApiErrorDetail = {
  path?: Array<string | number>;
  type?: string;
  message?: string;
} & Record<string, unknown>;
export type ApiErrorBody = {
  error: { code: string; message: string; details: ApiErrorDetail[] };
};

/** Шаблон идентификатора элементов модели и имён переменных на сервере. */
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Ограничение глубины выражения в validation.py. */
export const MAX_EXPRESSION_DEPTH = 32;
