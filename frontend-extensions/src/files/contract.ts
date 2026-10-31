/**
 * DTO генерации проекта и запусков тестов из
 * reports/project-review-20261031/codegen-integration-contract.md
 * (PR #64, ветка t3/codegen-sandbox, коммит dbbf757, src/proveryalka/codegen/dto.py).
 */

export type VerificationState =
  | "holds"
  | "violated"
  | "inconclusive"
  | "not_checked";

export type GeneratedElement = {
  kind: "transition" | "variable" | "requirement";
  id: string;
  name: string;
  requirement_ids: string[];
  /** Строки 1-based, включительно. */
  start_line: number;
  end_line: number;
};

export type GeneratedFileRole =
  | "source"
  | "test"
  | "test_data"
  | "config"
  | "doc"
  | "model"
  | "manifest";

export type GeneratedFileEntry = {
  path: string;
  size: number;
  sha256: string;
  role: GeneratedFileRole;
  media_type: string;
  /** Назначение файла, детерминированный текст генератора. */
  explanation: string;
  requirement_ids: string[];
  elements: GeneratedElement[];
};

export type PropertyVerification = {
  property_id: string;
  status: string | null;
  check_run_id: string | null;
};

export type Generation = {
  generation_id: string;
  session_id: string;
  model_id: string;
  version_id: string;
  version_number: number;
  spec_hash: string;
  /** SHA-256 канонического списка {path,size,sha256} всех файлов. */
  code_hash: string;
  status: "completed";
  target: string;
  generator: { name: string; version: string };
  technical_conditions: Record<string, string>;
  /** ASCII-slug, корневая папка в ZIP. */
  project_name: string;
  verification: {
    state: VerificationState;
    acknowledged: boolean;
    properties: PropertyVerification[];
  };
  coverage: {
    reachable_states: number;
    exhaustive: boolean;
    boundary_states: number;
    conformance_cases: number;
    invalid_state_cases: number;
    trace_replays: number;
  };
  file_count: number;
  total_bytes: number;
  created_at: string;
  files: GeneratedFileEntry[];
};

export type TestRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timeout"
  | "engine_unavailable"
  | "cancelled"
  | "error";

export type TestCase = {
  name: string;
  classname: string;
  outcome: "passed" | "failed" | "error" | "skipped";
  duration_seconds: number | null;
  message: string | null;
};

export type SandboxInfo = {
  engine: string;
  image: string;
  network: string;
  read_only_root: boolean;
  user: string;
  capabilities: string[];
  no_new_privileges: boolean;
  memory_mb: number;
  swap_mb: number;
  cpus: number;
  pids_limit: number;
  tmpfs_mb: number;
  project_mount: string;
  engine_version?: string | null;
  image_id?: string | null;
  container_exit_code?: number | null;
  oom_killed?: boolean | null;
};

export type TestCounts = {
  total: number | null;
  passed: number | null;
  failed: number | null;
  errors: number | null;
  skipped: number | null;
};

export type TestRun = {
  test_run_id: string;
  generation_id: string;
  session_id: string;
  version_id: string;
  spec_hash: string;
  code_hash: string;
  status: TestRunStatus;
  error_code: string | null;
  message: string | null;
  cancel_requested: boolean;
  timeout_seconds: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  exit_code: number | null;
  counts: TestCounts;
  cases: TestCase[];
  sandbox: SandboxInfo | null;
  log_available: boolean;
  log_truncated: boolean | null;
};

export type CodegenStatus = {
  target: string;
  generator: { name: string; version: string };
  technical_conditions: Record<string, string>;
  limits: Record<string, number>;
  sandbox_status: "ready" | "engine_unavailable";
  sandbox_reason: string | null;
  sandbox: SandboxInfo;
  default_timeout_seconds: number;
  max_timeout_seconds: number;
};

export const TERMINAL_TEST_STATUSES: readonly TestRunStatus[] = [
  "passed",
  "failed",
  "timeout",
  "engine_unavailable",
  "cancelled",
  "error",
];

export function isTerminalTestRun(run: Pick<TestRun, "status">): boolean {
  return TERMINAL_TEST_STATUSES.includes(run.status);
}

/** Строки, выделенные в просмотре файла. */
export type LineRange = { start: number; end: number };

/** Ссылка из файла на элемент модели — то, что хост умеет выбрать. */
export type ModelElementRef = { kind: GeneratedElement["kind"]; id: string };

/** Версия модели, для которой показываются проекты. */
export type VersionRef = {
  id: string;
  model_id: string;
  number: number;
  spec_hash: string;
  approved: boolean;
};
