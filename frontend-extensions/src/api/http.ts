import type {
  ApiErrorBody,
  ApiErrorDetail,
  BehavioralModel,
  ModelVersion,
} from "../contracts/model";

/**
 * Узкий клиент только для маршрутов, подтверждённых в backend 62c12b8
 * (reports/project-review-20261031/frontend-contract.md):
 *   GET  /api/models/{model_id}/versions
 *   GET  /api/models/{model_id}/versions/{number}
 *   POST /api/models/{model_id}/versions   {spec, parent_id} + Idempotency-Key
 * Основной клиент может передать свою реализацию ModelVersionsPort.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  constructor(
    status: number,
    code: string,
    message: string,
    details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ModelVersionsPort {
  listVersions(modelId: string, signal?: AbortSignal): Promise<ModelVersion[]>;
  createVersion(
    modelId: string,
    body: { spec: BehavioralModel; parent_id: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ModelVersion>;
}

export type HttpOptions = {
  /** Префикс адреса сервера; пусто — тот же origin (через proxy dev-server). */
  baseUrl?: string;
  fetch?: typeof fetch;
};

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ApiErrorBody).error?.code === "string"
  );
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new ApiError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.details ?? [],
      );
    }
    throw new ApiError(
      response.status,
      "HTTP_ERROR",
      `Сервер ответил ${response.status}`,
    );
  }
  if (body === undefined)
    throw new ApiError(
      response.status,
      "INVALID_RESPONSE",
      "Сервер вернул не JSON",
    );
  return body as T;
}

export function createHttpModelVersionsPort(
  options: HttpOptions = {},
): ModelVersionsPort {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch =
    options.fetch ??
    ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const url = (modelId: string) =>
    `${base}/api/models/${encodeURIComponent(modelId)}/versions`;
  return {
    async listVersions(modelId, signal) {
      const response = await doFetch(url(modelId), {
        headers: { Accept: "application/json" },
        signal: signal ?? null,
      });
      return readJson<ModelVersion[]>(response);
    },
    async createVersion(modelId, body, idempotencyKey, signal) {
      if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
        throw new ApiError(
          0,
          "INVALID_IDEMPOTENCY_KEY",
          "Ключ идемпотентности должен быть длиной 1–128",
        );
      }
      const response = await doFetch(url(modelId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
      return readJson<ModelVersion>(response);
    },
  };
}

/** Человекочитаемое описание ошибки сервера для формы правки. */
export function describeApiError(error: unknown): {
  title: string;
  details: string[];
} {
  if (error instanceof ApiError) {
    const details = error.details.map((detail) => {
      const path = Array.isArray(detail.path) ? detail.path.join(".") : "";
      return [path, detail.message].filter(Boolean).join(": ");
    });
    if (error.code === "INVALID_REQUEST")
      return { title: "Сервер отклонил модель", details };
    if (error.code === "IDEMPOTENCY_CONFLICT") {
      return {
        title:
          "Этот ключ уже использован для другой модели. Обновите список версий и повторите.",
        details,
      };
    }
    if (error.code === "NOT_FOUND")
      return { title: "Модель или исходная версия не найдена", details };
    if (
      error.code === "STORAGE_UNAVAILABLE" ||
      error.code === "SHUTTING_DOWN"
    ) {
      return {
        title: "Сервер временно недоступен, версия не создана",
        details,
      };
    }
    return { title: `${error.message} (${error.code})`, details };
  }
  if (error instanceof DOMException && error.name === "AbortError")
    return { title: "Запрос отменён", details: [] };
  return {
    title: "Нет связи с сервером, версия не создана",
    details: [String(error)],
  };
}
