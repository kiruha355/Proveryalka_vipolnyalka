import type { ApiCapabilities, MessageBody, ProveryalkaApi } from "./api";
import { ApiError } from "./errors";
import type {
  BehavioralModel, CheckLimits, CheckRequest, CheckRun, Model, ModelVersion, ReadyInfo, Run, RunEvent, Session,
  SessionDetail, VerificationResult,
} from "./types";
import { DEFAULT_LIMITS, isTerminal } from "./types";
import orderBug from "../fixtures/order_bug.json";
import orderFixed from "../fixtures/order_fixed.json";
import grid from "../fixtures/grid.json";
import counterOverflow from "../fixtures/counter_overflow.json";
import recorded from "../fixtures/recorded-reports.json";

// Demo adapter: backend test fixtures plus checker reports recorded from real
// SANY/TLC runs (src/fixtures/recorded-reports.json, "_meta"). It never calls
// an LLM or TLC; the agent is unavailable here by design.

interface Recording {
  fixture: string;
  spec_hash: string;
  report: { results: VerificationResult[] };
}

const RECORDS = recorded as unknown as Record<string, Recording> & { _meta: Record<string, string> };
export const DEMO_RECORDING_META = RECORDS._meta;

interface DemoCheck {
  run: Run;
  results: VerificationResult[];
  pending: VerificationResult[];
  events: RunEvent[];
}

interface DemoVersionSeed {
  versionId: string;
  number: number;
  parentId: string | null;
  spec: BehavioralModel;
  records: string[];
}

interface DemoModelSeed {
  id: string;
  name: string;
  versions: DemoVersionSeed[];
}

interface DemoSessionSeed {
  id: string;
  title: string;
  createdAt: string;
  models: DemoModelSeed[];
}

const SEEDS: DemoSessionSeed[] = [
  {
    id: "demo_s_order",
    title: "Заявка: отмена и исполнение",
    createdAt: "2026-10-31T09:00:00+00:00",
    models: [{
      id: "demo_m_order",
      name: "Заявка",
      versions: [
        { versionId: "demo_order_v1", number: 1, parentId: null, spec: orderBug as unknown as BehavioralModel, records: ["order_bug"] },
        { versionId: "demo_order_v2", number: 2, parentId: "demo_order_v1", spec: orderFixed as unknown as BehavioralModel, records: ["order_fixed"] },
      ],
    }],
  },
  {
    id: "demo_s_limits",
    title: "Незавершённые и ошибочные проверки",
    createdAt: "2026-10-31T08:00:00+00:00",
    models: [
      { id: "demo_m_grid", name: "Сетка", versions: [{ versionId: "demo_grid_v1", number: 1, parentId: null, spec: grid as unknown as BehavioralModel, records: ["grid_state_limit", "grid_timeout"] }] },
      { id: "demo_m_counter", name: "Счётчик", versions: [{ versionId: "demo_counter_v1", number: 1, parentId: null, spec: counterOverflow as unknown as BehavioralModel, records: ["counter_overflow"] }] },
      { id: "demo_m_engine", name: "Заявка без Java", versions: [{ versionId: "demo_engine_v1", number: 1, parentId: null, spec: orderBug as unknown as BehavioralModel, records: ["engine_unavailable"] }] },
    ],
  },
];

function sameLimits(a: CheckLimits, b: CheckLimits): boolean {
  return a.timeout_seconds === b.timeout_seconds && a.max_states === b.max_states && (a.max_depth ?? null) === (b.max_depth ?? null);
}

export interface DemoApiOptions {
  /** Milliseconds between demo run state changes. */
  stepMs?: number;
}

export class DemoApi implements ProveryalkaApi {
  readonly id = "demo";
  private readonly stepMs: number;
  private sessions = new Map<string, SessionDetail>();
  private models = new Map<string, Model>();
  private versions = new Map<string, ModelVersion>();
  private recordings = new Map<string, string[]>();
  private checks = new Map<string, DemoCheck>();
  private sequence = 0;

  constructor(options: DemoApiOptions = {}) {
    this.stepMs = options.stepMs ?? 600;
    for (const seed of SEEDS) this.seed(seed);
  }

  private seed(seed: DemoSessionSeed) {
    const firstSpec = seed.models[0]?.versions[0]?.spec;
    this.sessions.set(seed.id, {
      id: seed.id, title: seed.title, mode: "analyzer", created_at: seed.createdAt,
      messages: [], requirements: [],
      sources: (firstSpec?.sources ?? []).map((s) => ({ ...s, session_id: seed.id })),
    });
    for (const model of seed.models) {
      this.models.set(model.id, { id: model.id, session_id: seed.id, name: model.name });
      for (const v of model.versions) {
        const record = RECORDS[v.records[0] ?? ""];
        this.versions.set(v.versionId, {
          id: v.versionId, model_id: model.id, session_id: seed.id, number: v.number, parent_id: v.parentId,
          spec: v.spec, spec_hash: record?.spec_hash ?? "", approved: false,
        });
        this.recordings.set(v.versionId, v.records);
        // Recorded runs are visible from the start so the scenario can be read without clicking.
        v.records.forEach((name, i) => {
          const results = RECORDS[name]?.report.results ?? [];
          const runId = `demo_chk_${v.versionId}_${i + 1}`;
          this.checks.set(runId, {
            run: { run_id: runId, session_id: seed.id, version_id: v.versionId, state: "completed", error_code: null },
            results, pending: [],
            events: [
              this.event(runId, seed.id, 1, "check_started", { check_run_id: runId, version_id: v.versionId }),
              this.event(runId, seed.id, 2, "check_finished", { check_run_id: runId, version_id: v.versionId }),
              this.event(runId, seed.id, 3, "run_finished", { state: "completed" }),
            ],
          });
        });
      }
    }
  }

  private event(runId: string, sessionId: string, id: number, type: RunEvent["type"], data: Record<string, unknown>): RunEvent {
    return { event_id: id, run_id: runId, session_id: sessionId, type, data };
  }

  async capabilities(): Promise<ApiCapabilities> {
    return { adapter: "demo", agent: false, questionId: false, customLimits: false, artifacts: false, checkDiscovery: true, documents: false };
  }

  async ready(): Promise<ReadyInfo> {
    return { status: "demo" };
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()]
      .map(({ id, title, mode, created_at }) => ({ id, title, mode, created_at }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async createSession(body: { title: string }): Promise<Session> {
    const id = `demo_s_${++this.sequence}`;
    const session: SessionDetail = {
      id, title: body.title, mode: "analyzer", created_at: new Date().toISOString(), messages: [], sources: [], requirements: [],
    };
    this.sessions.set(id, session);
    const { messages: _m, sources: _s, requirements: _r, ...plain } = session;
    return plain;
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ApiError("http", "Session not found", { status: 404, code: "NOT_FOUND" });
    return structuredClone(session);
  }

  async sendMessage(_sessionId: string, _body: MessageBody): Promise<Run> {
    throw new ApiError("unsupported", "В демо-режиме агент не вызывается. Подключите API сервера.");
  }

  async getRun(runId: string): Promise<Run> {
    return { ...this.check(runId).run };
  }

  async cancelRun(runId: string): Promise<Run> {
    const check = this.check(runId);
    if (check.run.state === "queued" || check.run.state === "running") {
      check.run = { ...check.run, state: "cancelled", error_code: "CANCELLED" };
      this.push(check, "error", { code: "CANCELLED", message: "Run stopped; saved history is available" });
      this.push(check, "run_finished", { state: "cancelled" });
    }
    return { ...check.run };
  }

  async *streamEvents(runId: string, after: number, signal: AbortSignal): AsyncIterable<RunEvent> {
    const check = this.check(runId);
    let cursor = after;
    while (!signal.aborted) {
      const fresh = check.events.filter((e) => e.event_id > cursor);
      for (const event of fresh) {
        cursor = event.event_id;
        yield structuredClone(event);
      }
      if (isTerminal(check.run.state) && check.events.some((e) => e.type === "run_finished" && e.event_id <= cursor)) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(20, this.stepMs / 4)));
    }
    throw new ApiError("aborted", "Запрос отменён");
  }

  async listModels(sessionId: string): Promise<Model[]> {
    await this.getSession(sessionId);
    return [...this.models.values()].filter((m) => m.session_id === sessionId);
  }

  async listVersions(modelId: string): Promise<ModelVersion[]> {
    if (!this.models.has(modelId)) throw new ApiError("http", "Model not found", { status: 404, code: "NOT_FOUND" });
    return [...this.versions.values()].filter((v) => v.model_id === modelId).sort((a, b) => a.number - b.number).map((v) => structuredClone(v));
  }

  async approveVersion(modelId: string, number: number): Promise<ModelVersion> {
    const version = [...this.versions.values()].find((v) => v.model_id === modelId && v.number === number);
    if (!version) throw new ApiError("http", "Version not found in model", { status: 404, code: "NOT_FOUND" });
    version.approved = true;
    return structuredClone(version);
  }

  async createCheck(modelId: string, number: number, body: CheckRequest): Promise<Run> {
    const version = [...this.versions.values()].find((v) => v.model_id === modelId && v.number === number);
    if (!version) throw new ApiError("http", "Version not found in model", { status: 404, code: "NOT_FOUND" });
    const ids = body.property_ids ?? version.spec.properties.map((p) => p.id);
    const limits = { ...DEFAULT_LIMITS, ...(body.limits ?? {}) };
    const record = (this.recordings.get(version.id) ?? [])
      .map((name) => RECORDS[name])
      .find((r) => r && r.report.results[0] && sameLimits(r.report.results[0].limits, limits));
    const runId = `demo_chk_${++this.sequence}`;
    const results = record ? record.report.results.filter((r) => ids.includes(r.property_id)) : [];
    const check: DemoCheck = {
      run: { run_id: runId, session_id: version.session_id, version_id: version.id, state: "queued", error_code: null },
      results: [], pending: results, events: [],
    };
    this.checks.set(runId, check);
    setTimeout(() => {
      if (check.run.state !== "queued") return;
      check.run = { ...check.run, state: "running" };
      this.push(check, "check_started", { check_run_id: runId, version_id: version.id });
      setTimeout(() => {
        if (check.run.state !== "running") return;
        if (!record) {
          // No recording for these limits: fail instead of inventing a result.
          check.run = { ...check.run, state: "failed", error_code: "DEMO_NOT_RECORDED" };
          this.push(check, "error", { code: "DEMO_NOT_RECORDED", message: "No recorded checker output for these limits" });
        } else {
          check.results = check.pending;
          check.run = { ...check.run, state: "completed" };
          this.push(check, "check_finished", { check_run_id: runId, version_id: version.id });
        }
        this.push(check, "run_finished", { state: check.run.state });
      }, this.stepMs);
    }, this.stepMs / 2);
    return { ...check.run };
  }

  async getCheck(runId: string): Promise<CheckRun> {
    const check = this.check(runId);
    return structuredClone({ run: check.run, results: check.results });
  }

  async listArtifacts(): Promise<never> {
    throw new ApiError("unsupported", "Файлы прогона доступны только для проверок на сервере.");
  }

  artifactUrl(): string {
    return "";
  }

  async listCheckRuns(versionId: string): Promise<string[]> {
    return [...this.checks.values()].filter((c) => c.run.version_id === versionId).map((c) => c.run.run_id);
  }

  private check(runId: string): DemoCheck {
    const check = this.checks.get(runId);
    if (!check) throw new ApiError("http", "Run not found", { status: 404, code: "NOT_FOUND" });
    return check;
  }

  private push(check: DemoCheck, type: RunEvent["type"], data: Record<string, unknown>) {
    check.events.push(this.event(check.run.run_id, check.run.session_id, check.events.length + 1, type, data));
  }
}
