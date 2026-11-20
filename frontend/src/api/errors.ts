export type ApiErrorKind = "network" | "http" | "malformed" | "aborted" | "unsupported";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly details: unknown[];

  constructor(kind: ApiErrorKind, message: string, options: { status?: number | null; code?: string | null; details?: unknown[] } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.details = options.details ?? [];
  }

  /** A retry with the same idempotency key cannot create a second effect. */
  get retryable(): boolean {
    if (this.kind === "network" || this.kind === "malformed") return true;
    if (this.kind !== "http" || this.status === null) return false;
    return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

export function isAbort(error: unknown): boolean {
  return (error instanceof ApiError && error.kind === "aborted")
    || (error instanceof DOMException && error.name === "AbortError");
}

// User-facing text for backend error codes. Messages name the next action.
const CODE_TEXT: Record<string, string> = {
  NOT_FOUND: "Объект не найден на сервере.",
  SOURCE_NOT_FOUND: "Источник модели не найден в этой сессии.",
  INVALID_CHECK: "Выберите существующие свойства и допустимые лимиты.",
  IDEMPOTENCY_CONFLICT: "Этот запрос уже отправлен с другим содержимым. Отправьте его заново.",
  SESSION_BUSY: "В этой сессии агент ещё работает. Дождитесь завершения или остановите его.",
  INPUT_LIMIT: "Текст пустой или длиннее допустимого лимита сервера.",
  QUEUE_FULL: "Очередь сервера заполнена. Повторите через несколько секунд.",
  INVALID_CURSOR: "Сервер не знает позицию потока событий; события загружаются заново.",
  CHECK_PENDING: "Проверка ещё не завершена.",
  ARTIFACT_NOT_FOUND: "Файлы прогона недоступны или повреждены.",
  STORAGE_UNAVAILABLE: "Хранилище сервера временно недоступно. Повторите позже.",
  SHUTTING_DOWN: "Сервер останавливается. Повторите после перезапуска.",
  COMPONENT_UNAVAILABLE: "Эта функция сервера не подключена.",
  DEPENDENCY_UNAVAILABLE: "Сервер не готов: недоступны SQLite или Java/TLC.",
  INVALID_REQUEST: "Сервер отклонил запрос как некорректный.",
  MODEL_INVALID: "Сервер отклонил модель как некорректную.",
  // Run error codes (Run.error_code / SSE error event)
  CANCELLED: "Остановлено пользователем.",
  SERVER_RESTARTED: "Сервер перезапустился во время выполнения. Результата нет; запустите заново.",
  RUN_TIMEOUT: "Агент не уложился в лимит времени.",
  AGENT_FAILED: "Агент завершился с ошибкой.",
  CHECK_FAILED: "Проверка завершилась сбоем сервера. Результата нет.",
  PENDING_MESSAGE: "Предыдущее сообщение не обработано. Повторите его, прежде чем писать новое.",
  CONTEXT_LIMIT: "Контекст диалога слишком велик для одного запуска агента.",
  PROVIDER_TIMEOUT: "LLM-провайдер не ответил вовремя.",
  PROVIDER_RATE_LIMIT: "LLM-провайдер ограничил запросы: проверьте квоту.",
  PROVIDER_UNAVAILABLE: "LLM-провайдер недоступен.",
  PROVIDER_AUTH: "LLM-провайдер не принял ключ.",
  PROVIDER_NOT_FOUND: "Модель или адрес LLM-провайдера не найдены.",
  PROVIDER_ERROR: "LLM-провайдер вернул ошибку.",
  TURN_LIMIT: "Агент превысил лимит шагов.",
  INVALID_CHECKER_RESULT: "Результат проверки не совпал с моделью.",
  DEMO_NOT_RECORDED: "Для этих лимитов нет записанного результата: демо-режим не запускает TLC.",
};

export function describeCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return CODE_TEXT[code] ?? null;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "network") return "Нет связи с сервером. Проверьте, что API запущен, и повторите.";
    if (error.kind === "malformed") return `Сервер вернул ответ в неожиданном формате: ${error.message}`;
    if (error.kind === "unsupported") return error.message;
    const known = describeCode(error.code);
    const status = error.status ? `HTTP ${error.status}` : "HTTP";
    return known ? known : `${status}${error.code ? ` · ${error.code}` : ""}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
