import type { ApiCapabilities, CheckVersion, MessageBody, ProveryalkaApi } from "./api";
import { ApiError } from "./errors";
import {
  expect, expectList, isAgentRunTracePage, isDialogueView, isDocumentUpload, isArtifactEntry, isCheckRun, isModel, isModelVersion, isRun, isRunEvent, isSession, isSessionDetail,
} from "./guards";
import { readSse } from "./sse";
import { isImageAnalysis, isImageAnalysisRecord, isImageProvenance, isImageSource, type ImageRegion } from "./images";
import type { CheckRequest, ReadyInfo, RunEvent, SourceRef } from "./types";

type FetchLike = typeof fetch;

interface RequestOptions {
  body?: unknown;
  key?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const segment = encodeURIComponent;
const imagesPath = (sessionId: string) => `/api/sessions/${segment(sessionId)}/images`;
const imagePath = (sessionId: string, sourceId: string) => `${imagesPath(sessionId)}/${segment(sourceId)}`;

export class HttpApi implements ProveryalkaApi {
  readonly id: string;
  private readonly base: string;
  private readonly fetcher: FetchLike;
  private capabilitiesPromise: Promise<ApiCapabilities> | null = null;

  constructor(baseUrl = "", fetcher?: FetchLike) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
    this.id = `http:${this.base || "same-origin"}`;
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
    if (typeof value !== "object" || value === null) {
      throw new ApiError("malformed", "Ответ /ready не подтверждает готовность сервера");
    }
    const info = value as ReadyInfo;
    if (info.status !== "ready"
      || (info.checker !== undefined && typeof info.checker !== "string")
      || (info.llm_provider != null && typeof info.llm_provider !== "string")
      || (info.agent_configured !== undefined && typeof info.agent_configured !== "boolean")) {
      throw new ApiError("malformed", "Ответ /ready не подтверждает готовность сервера");
    }
    return info;
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

  async uploadImage(sessionId: string, file: File, key: string, signal?: AbortSignal) {
    const body = new FormData();
    body.append("file", file);
    return expect(await this.request("POST", imagesPath(sessionId), { body, key, signal }), isImageSource, "Загруженное изображение");
  }

  async listImages(sessionId: string, signal?: AbortSignal) {
    return expectList(await this.request("GET", imagesPath(sessionId), { signal }), isImageSource, "Изображения");
  }

  getImageContentUrl(sessionId: string, sourceId: string) {
    return `${this.base}${imagePath(sessionId, sourceId)}/content`;
  }

  async analyzeImage(sessionId: string, sourceId: string, region: ImageRegion | null, key: string, signal?: AbortSignal) {
    return expect(await this.request("POST", `${imagePath(sessionId, sourceId)}/analysis`, { body: { region }, key, signal }),
      isImageAnalysis, "Разбор изображения");
  }

  async listImageAnalyses(sessionId: string, sourceId: string, signal?: AbortSignal) {
    return expectList(await this.request("GET", `${imagePath(sessionId, sourceId)}/analyses`, { signal }),
      isImageAnalysisRecord, "Сохранённые разборы изображения");
  }

  async useImageAnalysisInDialogue(sessionId: string, sourceId: string, analysisId: string, key: string, signal?: AbortSignal) {
    const source = await this.request("POST", `${imagePath(sessionId, sourceId)}/analyses/${segment(analysisId)}/source`, { signal });
    if (typeof source !== "object" || source === null || !("id" in source) || typeof source.id !== "string") {
      throw new ApiError("malformed", "Текстовый источник разбора");
    }
    return this.sendMessage(sessionId, { source_id: source.id }, key, signal);
  }

  async getImageProvenance(sessionId: string, ref: Pick<SourceRef, "source_id" | "start" | "end">, signal?: AbortSignal) {
    const params = new URLSearchParams({ start: String(ref.start), end: String(ref.end) });
    const value = await this.request("GET", `/api/sessions/${segment(sessionId)}/sources/${segment(ref.source_id)}/provenance?${params}`, { signal });
    if (value === null || (typeof value === "object" && value !== null && "kind" in value && value.kind === "repository")) return null;
    return expect(value, isImageProvenance, "Ссылка на область изображения");
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

  async listCheckRuns(version: CheckVersion, signal?: AbortSignal) {
    const runs = expectList(
      await this.request("GET", `/api/models/${segment(version.model_id)}/versions/${version.number}/checks`, { signal }),
      isRun,
      "Список проверок версии",
    );
    return runs.map((r) => r.run_id);
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

  private async send(method: string, path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (options.key) headers["Idempotency-Key"] = options.key;
    try {
      return await this.fetcher(`${this.base}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : options.body instanceof FormData ? options.body : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new ApiError("aborted", "Запрос отменён");
      throw new ApiError("network", error instanceof Error ? error.message : "Сетевая ошибка");
    }
  }

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.send(method, path, options);
    if (!response.ok) throw await errorFrom(response);
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
  const checksPath = paths["/api/models/{model_id}/versions/{number}/checks"];
  return {
    adapter: "http",
    agent: "/api/sessions/{session_id}/messages" in paths,
    questionId: Boolean(schemas.MessageCreate?.properties && "question_id" in schemas.MessageCreate.properties),
    fileDialogue: Boolean(schemas.MessageCreate?.properties && "file_context" in schemas.MessageCreate.properties),
    customLimits: true,
    artifacts: "/api/checks/{run_id}/artifacts" in paths,
    checkDiscovery: typeof checksPath === "object" && checksPath !== null && "get" in checksPath,
    documents: "/api/sessions/{session_id}/documents" in paths,
    dialogue: "/api/sessions/{session_id}/dialogue" in paths,
    explanations: "/api/checks/{run_id}/explanation" in paths,
    agentTrace: "/api/sessions/{session_id}/agent-runs" in paths,
    images: "/api/sessions/{session_id}/images/{source_id}/analyses/{analysis_id}/source" in paths &&
      "/api/sessions/{session_id}/sources/{source_id}/provenance" in paths,
  };
}
