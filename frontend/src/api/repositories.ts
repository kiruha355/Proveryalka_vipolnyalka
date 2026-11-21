import { ApiError } from "./errors";
import { expect, expectList, isRun, isObject } from "./guards";
import type { Run, Source, SourceRef } from "./types";

export interface RepositoryFile {
  path: string;
  sha256: string;
  size_bytes: number;
  lines: number;
}

export interface RepositorySnapshot {
  id: string;
  session_id: string;
  remote_url: string;
  commit_sha: string;
  manifest_sha256: string;
  parent_snapshot_id: string | null;
  created_at: string;
  files: RepositoryFile[];
  excluded: Record<string, number>;
}

export interface RepositoryRefresh {
  ref: string;
  credential_ref?: string;
}

export interface RepositoryImport extends RepositoryRefresh {
  remote_url: string;
}

export interface RepositoryRange {
  path: string;
  sha256: string;
  start_line: number;
  end_line: number;
}

export interface RepositorySelection {
  manifest_sha256: string;
  files?: RepositoryRange[];
  auto_select?: boolean;
  query?: string;
}

export interface RepositoryPlan {
  selection: RepositorySelection & { files: RepositoryRange[] };
  indexed_file_count: number;
  selected_line_count: number;
  coverage: "complete" | "partial";
}

export interface RepositoryContextSummary {
  source_id: string;
  size_bytes: number;
  ranges: RepositoryRange[];
}

interface RepositoryContext {
  snapshot_id: string;
  commit_sha: string;
  excerpts: (RepositoryRange & { text: string })[];
  source: Source;
}

export interface RepositoryProvenance extends RepositoryRange {
  kind: "repository";
  snapshot_id: string;
  commit_sha: string;
}

export interface RepositoryContent {
  commit_sha: string;
  path: string;
  sha256: string;
  start_line: number;
  total_lines: number;
  lines: string[];
}

export interface GitConnection {
  id: string;
  remote_url: string;
  expires_at: number;
  state: "active" | "expired" | "revoked";
  last_checked_at: number | null;
  last_error: string | null;
}

export interface GitConnectionInput {
  remote_url: string;
  token: string;
  expires_at: number;
}

export interface RepositoryApi {
  list(session: string, signal?: AbortSignal): Promise<RepositorySnapshot[]>;
  get(session: string, snapshot: string, signal?: AbortSignal): Promise<RepositorySnapshot>;
  import(session: string, body: RepositoryImport, key: string, signal?: AbortSignal): Promise<RepositorySnapshot>;
  refresh(session: string, snapshot: string, body: RepositoryRefresh, key: string, signal?: AbortSignal): Promise<RepositorySnapshot>;
  plan(session: string, snapshot: string, body: { query?: string; extend?: boolean }, signal?: AbortSignal): Promise<RepositoryPlan>;
  context(session: string, snapshot: string, body: RepositorySelection, key: string, signal?: AbortSignal): Promise<RepositoryContext>;
  latestContext(session: string, snapshot: string, signal?: AbortSignal): Promise<RepositoryContextSummary | null>;
  analyze(session: string, snapshot: string, body: RepositorySelection, key: string, signal?: AbortSignal): Promise<Run>;
  provenance(session: string, ref: SourceRef, signal?: AbortSignal): Promise<RepositoryProvenance | null>;
  content(session: string, snapshot: string, path: string, start: number, end?: number, signal?: AbortSignal): Promise<RepositoryContent>;
}

export interface GitConnectionsApi {
  list(signal?: AbortSignal): Promise<GitConnection[]>;
  create(body: GitConnectionInput, signal?: AbortSignal): Promise<GitConnection>;
  check(id: string, signal?: AbortSignal): Promise<{ accessible: boolean; connection: GitConnection }>;
  revoke(id: string, signal?: AbortSignal): Promise<void>;
}

type Request = (method: string, path: string, options?: { body?: unknown; key?: string; signal?: AbortSignal }) => Promise<unknown>;

const string = (value: unknown): value is string => typeof value === "string";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isFile = (v: unknown): v is RepositoryFile =>
  isObject(v) && string(v.path) && string(v.sha256) && integer(v.size_bytes) && integer(v.lines);
const isSnapshot = (v: unknown): v is RepositorySnapshot =>
  isObject(v) && string(v.id) && string(v.session_id) && string(v.remote_url) && string(v.commit_sha) && string(v.manifest_sha256)
  && (v.parent_snapshot_id === null || string(v.parent_snapshot_id)) && string(v.created_at)
  && Array.isArray(v.files) && v.files.every(isFile) && isObject(v.excluded) && Object.values(v.excluded).every(integer);
const isRange = (v: unknown): v is RepositoryRange =>
  isObject(v) && string(v.path) && string(v.sha256) && integer(v.start_line) && v.start_line > 0 && integer(v.end_line) && v.end_line >= v.start_line;
const isPlan = (v: unknown): v is RepositoryPlan =>
  isObject(v) && isObject(v.selection) && string(v.selection.manifest_sha256)
  && Array.isArray(v.selection.files) && v.selection.files.every(isRange)
  && integer(v.indexed_file_count) && integer(v.selected_line_count) && (v.coverage === "complete" || v.coverage === "partial");
const isSummary = (v: unknown): v is RepositoryContextSummary =>
  isObject(v) && string(v.source_id) && integer(v.size_bytes) && Array.isArray(v.ranges) && v.ranges.every(isRange);
const isContext = (v: unknown): v is RepositoryContext =>
  isObject(v) && string(v.snapshot_id) && string(v.commit_sha)
  && Array.isArray(v.excerpts) && v.excerpts.every(e => isObject(e) && isRange(e) && string(e.text))
  && isObject(v.source) && string(v.source.id) && string(v.source.text);
const isProvenance = (v: unknown): v is RepositoryProvenance =>
  isObject(v) && isRange(v) && v.kind === "repository" && string(v.snapshot_id) && string(v.commit_sha);
const isContent = (v: unknown): v is RepositoryContent =>
  isObject(v) && string(v.commit_sha) && string(v.path) && string(v.sha256) && integer(v.start_line) && v.start_line > 0
  && integer(v.total_lines) && Array.isArray(v.lines) && v.lines.every(string);
const isConnection = (v: unknown): v is GitConnection =>
  isObject(v) && string(v.id) && string(v.remote_url) && typeof v.expires_at === "number"
  && (v.state === "active" || v.state === "revoked" || v.state === "expired")
  && (v.last_checked_at === null || typeof v.last_checked_at === "number") && (v.last_error === null || string(v.last_error));

const segment = encodeURIComponent;
const collection = (session: string) => `/api/sessions/${segment(session)}/repositories`;
const snapshotPath = (session: string, snapshot: string) => `${collection(session)}/${segment(snapshot)}`;

export function repositoryHttp(request: Request): RepositoryApi {
  return {
    async list(session, signal) {
      const snapshots: RepositorySnapshot[] = [];
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const data = expectList(await request("GET", `${collection(session)}?limit=${limit}&offset=${offset}`, { signal }), isSnapshot, "Снимки репозиториев");
        snapshots.push(...data);
        if (data.length < limit) return snapshots;
      }
    },
    async get(session, snapshot, signal) {
      return expect(await request("GET", snapshotPath(session, snapshot), { signal }), isSnapshot, "Снимок репозитория");
    },
    async import(session, body, key, signal) {
      return expect(await request("POST", collection(session), { body, key, signal }), isSnapshot, "Снимок репозитория");
    },
    async refresh(session, snapshot, body, key, signal) {
      return expect(await request("POST", `${snapshotPath(session, snapshot)}/refresh`, { body, key, signal }), isSnapshot, "Обновлённый снимок");
    },
    async plan(session, snapshot, body, signal) {
      return expect(await request("POST", `${snapshotPath(session, snapshot)}/selection`, { body, signal }), isPlan, "Автоотбор файлов");
    },
    async context(session, snapshot, body, key, signal) {
      return expect(await request("POST", `${snapshotPath(session, snapshot)}/context`, { body, key, signal }), isContext, "Контекст снимка");
    },
    async latestContext(session, snapshot, signal) {
      const value = await request("GET", `${snapshotPath(session, snapshot)}/context`, { signal });
      return value === null ? null : expect(value, isSummary, "Диапазоны контекста");
    },
    async analyze(session, snapshot, body, key, signal) {
      return expect(await request("POST", `${snapshotPath(session, snapshot)}/analysis`, { body, key, signal }), isRun, "Запуск анализа");
    },
    async provenance(session, ref, signal) {
      const query = new URLSearchParams({ start: String(ref.start), end: String(ref.end) });
      const value = await request("GET", `/api/sessions/${segment(session)}/sources/${segment(ref.source_id)}/provenance?${query}`, { signal });
      if (value === null || (isObject(value) && value.kind === "image")) return null;
      return expect(value, isProvenance, "Цитата из репозитория");
    },
    async content(session, snapshot, path, start, end, signal) {
      const query = new URLSearchParams({ path, start_line: String(start) });
      if (end !== undefined) query.set("end_line", String(end));
      return expect(await request("GET", `${snapshotPath(session, snapshot)}/files/content?${query}`, { signal }), isContent, "Файл снимка");
    },
  };
}

export function gitConnectionsHttp(request: Request, remove: (path: string, signal?: AbortSignal) => Promise<void>): GitConnectionsApi {
  return {
    async list(signal) {
      return expectList(await request("GET", "/api/connections", { signal }), isConnection, "Приватные подключения");
    },
    async create(body, signal) {
      try {
        return expect(await request("POST", "/api/connections", { body, signal }), isConnection, "Приватное подключение");
      } catch (error) {
        // Token entry must not echo a rejected request or a server/proxy response.
        if (error instanceof ApiError) {
          throw new ApiError(error.kind, "Проверьте адрес, токен и срок действия.", { status: error.status, code: error.code });
        }
        throw error;
      }
    },
    async check(id, signal) {
      const value = await request("POST", `/api/connections/${segment(id)}/check`, { signal });
      if (!isObject(value) || typeof value.accessible !== "boolean" || !isConnection(value.connection)) {
        throw new ApiError("malformed", "Результат проверки подключения");
      }
      return { accessible: value.accessible, connection: value.connection };
    },
    revoke(id, signal) {
      return remove(`/api/connections/${segment(id)}`, signal);
    },
  };
}
