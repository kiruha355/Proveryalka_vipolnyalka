import { checkArchivePath } from "./safe-path";
import { ApiError, readJson } from "../api/http";
import type {
  CodegenStatus,
  Generation,
  TestRun,
  VersionRef,
} from "./contract";

/**
 * Клиент генерации проекта и песочницы тестов по
 * codegen-integration-contract.md (маршруты /api/codegen/*, /api/generations/*,
 * /api/test-runs/*). Компоненты #49 работают только через этот интерфейс.
 */

export type CodegenAvailability =
  | { available: true; status: CodegenStatus }
  | { available: false; reason: string };

export type ArchiveDownload = {
  bytes: Uint8Array;
  fileName: string | null;
  codeHash: string | null;
};

export interface CodegenProvider {
  /** Подпись источника, если это не живой сервер (например, «Запись прогона генератора»). */
  readonly label: string | null;
  status(signal?: AbortSignal): Promise<CodegenAvailability>;
  listGenerations(
    version: Pick<VersionRef, "model_id" | "number">,
    signal?: AbortSignal,
  ): Promise<Generation[]>;
  getGeneration(
    generationId: string,
    signal?: AbortSignal,
  ): Promise<Generation>;
  readFile(
    generationId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sha256Header: string | null }>;
  downloadArchive(
    generationId: string,
    signal?: AbortSignal,
  ): Promise<ArchiveDownload>;
  createGeneration(
    version: Pick<VersionRef, "model_id" | "number">,
    options: { allowUnverified: boolean },
    key: string,
    signal?: AbortSignal,
  ): Promise<Generation>;
  listTestRuns(generationId: string, signal?: AbortSignal): Promise<TestRun[]>;
  getTestRun(testRunId: string, signal?: AbortSignal): Promise<TestRun>;
  startTestRun(
    generationId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<TestRun>;
  cancelTestRun(testRunId: string, signal?: AbortSignal): Promise<TestRun>;
  getTestLog(testRunId: string, signal?: AbortSignal): Promise<string>;
}

/** Кодирует каждый сегмент пути отдельно, сохраняя «/». */
export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Имя файла из Content-Disposition (только для подписи сохранения). */
export function dispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  const plain =
    /filename="([^"]+)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header);
  const raw = star?.[1] ?? plain?.[1];
  if (!raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw.trim());
  } catch {
    name = raw.trim();
  }
  // Только последний сегмент и без управляющих символов: имя не должно задавать путь.
  const last = name.split(/[\\/]/).pop() ?? "";
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean && clean !== "." && clean !== ".." ? clean : null;
}

export type CodegenHttpOptions = {
  /** Префикс сервера; пусто — тот же origin (proxy dev-server ядра). */
  baseUrl?: string;
  fetch?: typeof fetch;
  label?: string | null;
};

export function createCodegenProvider(
  options: CodegenHttpOptions = {},
): CodegenProvider {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch =
    options.fetch ??
    ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const get = (path: string, signal?: AbortSignal) =>
    doFetch(`${base}${path}`, {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    });
  const post = (
    path: string,
    body: unknown,
    key: string | null,
    signal?: AbortSignal,
  ) =>
    doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: signal ?? null,
    });
  const version = (ref: Pick<VersionRef, "model_id" | "number">) =>
    `/api/models/${encodeURIComponent(ref.model_id)}/versions/${encodeURIComponent(String(ref.number))}/generations`;
  const generation = (id: string) =>
    `/api/generations/${encodeURIComponent(id)}`;
  const testRun = (id: string) => `/api/test-runs/${encodeURIComponent(id)}`;

  return {
    label: options.label ?? null,
    async status(signal) {
      let response: Response;
      try {
        response = await get("/api/codegen/status", signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return { available: false, reason: "Нет связи с сервером генерации" };
      }
      if (response.status === 404) {
        return {
          available: false,
          reason:
            "На сервере не подключён модуль генерации (нет /api/codegen/status)",
        };
      }
      return {
        available: true,
        status: await readJson<CodegenStatus>(response),
      };
    },
    async listGenerations(ref, signal) {
      return readJson<Generation[]>(await get(version(ref), signal));
    },
    async getGeneration(id, signal) {
      return readJson<Generation>(await get(generation(id), signal));
    },
    async readFile(id, path, signal) {
      const checked = checkArchivePath(path);
      if (!checked.ok) throw new Error(checked.reason);
      const response = await doFetch(
        `${base}${generation(id)}/files/${encodePathSegments(path)}`,
        { signal: signal ?? null },
      );
      if (!response.ok) await readJson(response);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        sha256Header: response.headers.get("X-Content-SHA256"),
      };
    },
    async downloadArchive(id, signal) {
      const response = await doFetch(`${base}${generation(id)}/archive`, {
        signal: signal ?? null,
      });
      if (!response.ok) await readJson(response);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        fileName: dispositionFileName(
          response.headers.get("Content-Disposition"),
        ),
        codeHash: response.headers.get("X-Code-Hash"),
      };
    },
    async createGeneration(ref, { allowUnverified }, key, signal) {
      return readJson<Generation>(
        await post(
          version(ref),
          allowUnverified ? { allow_unverified: true } : {},
          key,
          signal,
        ),
      );
    },
    async listTestRuns(id, signal) {
      return readJson<TestRun[]>(
        await get(`${generation(id)}/test-runs`, signal),
      );
    },
    async getTestRun(id, signal) {
      return readJson<TestRun>(await get(testRun(id), signal));
    },
    async startTestRun(id, key, signal) {
      return readJson<TestRun>(
        await post(`${generation(id)}/test-runs`, {}, key, signal),
      );
    },
    async cancelTestRun(id, signal) {
      return readJson<TestRun>(
        await post(`${testRun(id)}/cancel`, undefined, null, signal),
      );
    },
    async getTestLog(id, signal) {
      const response = await doFetch(`${base}${testRun(id)}/log`, {
        signal: signal ?? null,
      });
      if (!response.ok) await readJson(response);
      return response.text();
    },
  };
}

/** Детали ответа 409 VERIFICATION_REQUIRED: статусы свойств, из-за которых нужна явная отметка. */
export function verificationDetails(error: unknown): Array<{
  property_id: string;
  status: string | null;
  check_run_id: string | null;
}> | null {
  if (!(error instanceof ApiError) || error.code !== "VERIFICATION_REQUIRED")
    return null;
  return error.details.map((detail) => ({
    property_id: String(detail.property_id ?? ""),
    status: typeof detail.status === "string" ? detail.status : null,
    check_run_id:
      typeof detail.check_run_id === "string" ? detail.check_run_id : null,
  }));
}

/** Новый ключ идемпотентности на каждое осознанное действие (контракт генератора). */
export function newActionKey(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}
