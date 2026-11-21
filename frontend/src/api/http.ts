import type { ApiCapabilities, MessageBody, ProveryalkaApi } from "./api";
import { ApiError, requiresSignIn } from "./errors";
import {
  expect, expectList, isAgentRunTracePage, isDialogueView, isDocumentUpload, isArtifactEntry, isCheckRun, isModel, isModelVersion, isRun, isRunEvent, isSession, isSessionDetail,
} from "./guards";
import { readSse } from "./sse";
import type { CheckRequest, ReadyInfo, RunEvent } from "./types";

type FetchLike = typeof fetch;

interface RequestOptions {
  body?: unknown;
  key?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const segment = encodeURIComponent;

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  csrf_token: string;
}

function authSession(value: unknown): AuthSession {
  const result = value as Partial<AuthSession> | null;
  if (!result?.user || typeof result.user.id !== "string" || !result.user.id
    || typeof result.user.email !== "string" || typeof result.csrf_token !== "string" || !result.csrf_token) {
    throw new ApiError("malformed", "Сервер вернул неполные данные о входе");
  }
  return { user: result.user, csrf_token: result.csrf_token };
}

interface AccountTransport {
  ownerId: string;
  csrfToken: string;
  onAuthError(error: ApiError): void;
}

export class HttpApi implements ProveryalkaApi {
  readonly id: string;
  readonly ownerId?: string;
  private readonly base: string;
  private readonly fetcher: FetchLike;
  private readonly onAuthError?: AccountTransport["onAuthError"];
  private csrfToken: string | null;
  private authEpoch = 0;
  private capabilitiesPromise: Promise<ApiCapabilities> | null = null;

  constructor(baseUrl = "", fetcher?: FetchLike, account?: AccountTransport) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
    this.id = `http:${this.base || "same-origin"}`;
    this.ownerId = account?.ownerId;
    this.csrfToken = account?.csrfToken ?? null;
    this.onAuthError = account?.onAuthError;
  }

  suspendAccount() {
    this.csrfToken = null;
    this.authEpoch++;
  }

  resumeAccount(session: AuthSession) {
    if (this.ownerId !== session.user.id) throw new Error("Workspace account mismatch");
    this.csrfToken = session.csrf_token;
  }

  /** Also used by optional file extensions, so downloads share account state. */
  readonly fetchWithSession: FetchLike = async (input, init) => {
    const epoch = this.authEpoch;
    const signal = init?.signal;
    const signedOut = () => new ApiError("http", "Требуется вход", { status: 401, code: "AUTH_REQUIRED" });
    if (this.ownerId && !this.csrfToken) {
      throw signedOut();
    }
    const method = init?.method ?? "GET";
    let headers = init?.headers;
    if (this.csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
      headers = new Headers(headers);
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    const response = await this.fetcher(input, { ...init, headers, credentials: "include" });
    const checkLifetime = () => {
      if (signal?.aborted) throw new ApiError("aborted", "Запрос отменён");
      if (epoch !== this.authEpoch) throw signedOut();
    };
    checkLifetime();
    if (this.onAuthError && (response.status === 401 || response.status === 403)) {
      const error = await errorFrom(response.clone());
      checkLifetime();
      if (requiresSignIn(error)) {
        this.suspendAccount();
        this.onAuthError(error);
      }
    }
    return response;
  };

  async me(signal?: AbortSignal): Promise<AuthSession> {
    return authSession(await this.request("GET", "/api/auth/me", { signal }));
  }

  async login(email: string, password: string) {
    return authSession(await this.request("POST", "/api/auth/login", { body: { email, password } }));
  }

  async register(email: string, password: string) {
    await this.request("POST", "/api/auth/register", { body: { email, password } });
  }

  async requestPasswordReset(email: string) {
    await this.request("POST", "/api/auth/password/reset-request", { body: { email } });
  }

  async resetPassword(token: string, password: string) {
    await this.request("POST", "/api/auth/password/reset", { body: { token, password } });
  }

  async changePassword(current: string, next: string) {
    await this.request("POST", "/api/auth/password", { body: { current_password: current, new_password: next } });
  }

  async logout(all: boolean) {
    await this.request(all ? "DELETE" : "POST", all ? "/api/auth/sessions" : "/api/auth/logout");
  }

  // Read-only capability discovery is shared across consumers. Do not bind its
  // cached promise to a StrictMode mount signal that can be aborted on remount.
  capabilities(_signal?: AbortSignal): Promise<ApiCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.request("GET", "/openapi.json")
        .then((doc) => detectCapabilities(doc))
        .catch((error: unknown) => {
          this.capabilitiesPromise = null;
          throw error;
        });
    }
    return this.capabilitiesPromise;
  }

  async ready(signal?: AbortSignal): Promise<ReadyInfo> {
    const value = await this.request("GET", "/ready", { signal });
    if (typeof value !== "object" || value === null) throw new ApiError("malformed", "Ответ /ready не является объектом");
    return value as ReadyInfo;
  }

  async listSessions(signal?: AbortSignal) {
    return expectList(await this.request("GET", "/api/sessions?limit=200", { signal }), isSession, "Список сессий");
  }

  async createSession(body: { title: string }, key: string, signal?: AbortSignal) {
    return expect(await this.request("POST", "/api/sessions", { body: { title: body.title, mode: "analyzer" }, key, signal }), isSession, "Сессия");
  }

  async getSession(sessionId: string, signal?: AbortSignal) {
    return expect(await this.request("GET", `/api/sessions/${segment(sessionId)}`, { signal }), isSessionDetail, "Сессия с историей");
  }

  async sendMessage(sessionId: string, body: MessageBody, key: string, signal?: AbortSignal) {
    const payload: MessageBody = { ...body };
    return expect(await this.request("POST", `/api/sessions/${segment(sessionId)}/messages`, { body: payload, key, signal }), isRun, "Запуск агента");
  }

  async getDialogue(sessionId: string, signal?: AbortSignal) {
    return expect(await this.request("GET", `/api/sessions/${segment(sessionId)}/dialogue`, { signal }), isDialogueView, "Диалог");
  }
  async retryPending(sessionId: string, key: string, signal?: AbortSignal) {
    return expect(await this.request("POST", `/api/sessions/${segment(sessionId)}/pending/retry`, {key, signal}), isRun, "Повтор анализа");
  }
  async discardPending(sessionId: string, signal?: AbortSignal) {
    return expect(await this.request("POST", `/api/sessions/${segment(sessionId)}/pending/discard`, {signal}), isDialogueView, "Диалог");
  }
  async retryExplanation(runId: string, key: string, signal?: AbortSignal) {
    return expect(await this.request("POST", `/api/checks/${segment(runId)}/explanation`, {key, signal}), isRun, "Объяснение");
  }
  async uploadDocument(sessionId: string, file: File, key: string, signal?: AbortSignal) {
    const body = new FormData(); body.append("file", file);
    const response = await this.send("POST", `/api/sessions/${segment(sessionId)}/documents`, {body, key, signal});
    if (!response.ok) throw await errorFrom(response);
    const data = expect(await response.json(), isDocumentUpload, "Загруженный документ");
    return {id: data.source.id, session_id: sessionId, filename: data.document.filename,
      media_type: data.document.media_type, size: data.document.size_bytes, status: "extracted" as const,
      text: data.source.text, error: null};
  }

  async getRun(runId: string, signal?: AbortSignal) {
    return expect(await this.request("GET", `/api/runs/${segment(runId)}`, { signal }), isRun, "Запуск");
  }

  async listAgentRuns(sessionId: string, before?: number | null, signal?: AbortSignal) {
    const query = new URLSearchParams({limit: "50"});
    if (before !== undefined && before !== null) query.set("before", String(before));
    return expect(await this.request("GET", `/api/sessions/${segment(sessionId)}/agent-runs?${query}`, {signal}), isAgentRunTracePage, "Ход работы агента");
  }

  async cancelRun(runId: string, signal?: AbortSignal) {
    return expect(await this.request("POST", `/api/runs/${segment(runId)}/cancel`, { signal }), isRun, "Запуск");
  }

  async *streamEvents(runId: string, after: number, signal: AbortSignal): AsyncIterable<RunEvent> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (after > 0) headers["Last-Event-ID"] = String(after);
    const response = await this.send("GET", `/api/runs/${segment(runId)}/events`, { signal, headers });
    if (!response.ok) throw await errorFrom(response);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream") || !response.body) {
      throw new ApiError("malformed", "Поток событий вернул не text/event-stream");
    }
    for await (const message of readSse(response.body, signal)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        throw new ApiError("malformed", "Событие запуска содержит некорректный JSON");
      }
      yield expect(parsed, isRunEvent, "Событие запуска");
    }
  }

  async listModels(sessionId: string, signal?: AbortSignal) {
    return expectList(await this.request("GET", `/api/sessions/${segment(sessionId)}/models`, { signal }), isModel, "Список моделей");
  }

  async listVersions(modelId: string, signal?: AbortSignal) {
    return expectList(await this.request("GET", `/api/models/${segment(modelId)}/versions`, { signal }), isModelVersion, "Список версий");
  }

  async createVersion(modelId: string, body: {spec: import("./types").BehavioralModel; parent_id?: string | null}, key: string, signal?: AbortSignal) {
    return expect(await this.request("POST", `/api/models/${segment(modelId)}/versions`, {body, key, signal}), isModelVersion, "Новая версия модели");
  }

  async approveVersion(modelId: string, number: number, signal?: AbortSignal) {
    return expect(await this.request("POST", `/api/models/${segment(modelId)}/versions/${number}/approve`, { signal }), isModelVersion, "Версия");
  }

  async createCheck(modelId: string, number: number, body: CheckRequest, key: string, signal?: AbortSignal) {
    const payload: Record<string, unknown> = { property_ids: body.property_ids };
    if (body.explain !== undefined) payload.explain = body.explain;
    if (body.limits) payload.limits = body.limits;
    return expect(await this.request("POST", `/api/models/${segment(modelId)}/versions/${number}/checks`, { body: payload, key, signal }), isRun, "Запуск проверки");
  }

  async getCheck(runId: string, signal?: AbortSignal) {
    return expect(await this.request("GET", `/api/checks/${segment(runId)}`, { signal }), isCheckRun, "Результат проверки");
  }

  async listArtifacts(runId: string, signal?: AbortSignal) {
    return expectList(await this.request("GET", `/api/checks/${segment(runId)}/artifacts`, { signal }), isArtifactEntry, "Список файлов прогона");
  }

  artifactUrl(runId: string, name: string): string {
    // Encode each path segment but keep the separators the server expects.
    const path = name.split("/").map(segment).join("/");
    return `${this.base}/api/checks/${segment(runId)}/artifacts/${path}`;
  }

  async downloadArtifact(runId: string, name: string, signal?: AbortSignal) {
    const response = await this.send("GET", this.artifactUrl(runId, name).slice(this.base.length), { signal });
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  private async send(method: string, path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (options.key) headers["Idempotency-Key"] = options.key;
    try {
      const send = path.startsWith("/api/") ? this.fetchWithSession : this.fetcher;
      return await send(`${this.base}${path}`, {
        method,
        headers,
        credentials: "include",
        body: options.body === undefined ? undefined : options.body instanceof FormData ? options.body : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new ApiError("aborted", "Запрос отменён");
      if (error instanceof ApiError) throw error;
      throw new ApiError("network", error instanceof Error ? error.message : "Сетевая ошибка");
    }
  }

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.send(method, path, options);
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return;
    try {
      return await response.json();
    } catch {
      if (options.signal?.aborted) throw new ApiError("aborted", "Запрос отменён");
      throw new ApiError("malformed", `Ответ ${method} ${path} не является JSON`, { status: response.status });
    }
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A proxy error page or empty body: keep the status only.
  }
  const envelope = typeof body === "object" && body !== null ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error : undefined;
  if (envelope && typeof envelope.code === "string") {
    return new ApiError("http", typeof envelope.message === "string" ? envelope.message : response.statusText, {
      status: response.status,
      code: envelope.code,
      details: Array.isArray(envelope.details) ? envelope.details : [],
    });
  }
  // Vite's proxy answers 502/504 when the backend is down: that is a lost connection.
  if (response.status === 502 || response.status === 504) {
    return new ApiError("network", `Сервер API недоступен (HTTP ${response.status})`, { status: response.status });
  }
  return new ApiError("http", response.statusText || "Ошибка сервера", { status: response.status });
}

export function detectCapabilities(doc: unknown): ApiCapabilities {
  const paths = (doc as { paths?: Record<string, unknown> })?.paths ?? {};
  const schemas = (doc as { components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } })?.components?.schemas ?? {};
  if (typeof paths !== "object" || !("/api/sessions" in paths)) {
    throw new ApiError("malformed", "OpenAPI сервера не содержит маршрутов Проверялки");
  }
  return {
    adapter: "http",
    agent: "/api/sessions/{session_id}/messages" in paths,
    questionId: Boolean(schemas.MessageCreate?.properties && "question_id" in schemas.MessageCreate.properties),
    fileDialogue: Boolean(schemas.MessageCreate?.properties && "file_context" in schemas.MessageCreate.properties),
    customLimits: true,
    artifacts: "/api/checks/{run_id}/artifacts" in paths,
    checkDiscovery: false,
    documents: "/api/sessions/{session_id}/documents" in paths,
    dialogue: "/api/sessions/{session_id}/dialogue" in paths,
    explanations: "/api/checks/{run_id}/explanation" in paths,
    agentTrace: "/api/sessions/{session_id}/agent-runs" in paths,
  };
}
