import type { PropertyKind, RunState, VerificationResult, VerificationStatus } from "../api/types";

export type StatusTone = "holds" | "violated" | "invalid" | "incomplete" | "error";

export interface StatusInfo {
  label: string;
  /** One line that tells what the status allows the reader to conclude. */
  meaning: string;
  tone: StatusTone;
  conclusive: boolean;
}

// Wording follows STATUS_TEXT in proveryalka.agent.verification.
export const STATUS: Record<VerificationStatus, StatusInfo> = {
  PROPERTY_HOLDS: {
    label: "Выполняется",
    meaning: "Свойство выполнено во всех состояниях этой конечной модели при заданных лимитах.",
    tone: "holds",
    conclusive: true,
  },
  PROPERTY_VIOLATED: {
    label: "Нарушено",
    meaning: "Движок нашёл допустимую последовательность, нарушающую свойство.",
    tone: "violated",
    conclusive: true,
  },
  MODEL_INVALID: {
    label: "Модель отклонена",
    meaning: "Проверяющее ядро не приняло модель. Вывода о свойстве нет; исправьте модель.",
    tone: "invalid",
    conclusive: false,
  },
  TIMEOUT: {
    label: "Время истекло",
    meaning: "Проверка не завершена: перебор остановлен по лимиту времени. Это не означает, что свойство выполняется.",
    tone: "incomplete",
    conclusive: false,
  },
  STATE_LIMIT_REACHED: {
    label: "Лимит состояний",
    meaning: "Проверка не завершена: перебор остановлен по лимиту состояний или глубины. Это не означает, что свойство выполняется.",
    tone: "incomplete",
    conclusive: false,
  },
  ENGINE_ERROR: {
    label: "Ошибка движка",
    meaning: "Проверка не выполнена или прервана сбоем. Вывода о свойстве нет.",
    tone: "error",
    conclusive: false,
  },
};

export const NEXT_STEP: Partial<Record<VerificationStatus, string>> = {
  MODEL_INVALID: "Исправьте модель по сообщению движка и запустите проверку заново.",
  TIMEOUT: "Увеличьте время проверки или уменьшите области значений модели.",
  STATE_LIMIT_REACHED: "Увеличьте лимит состояний или уменьшите области значений модели.",
  ENGINE_ERROR: "Проверьте Java/TLC на сервере (/ready) и запустите проверку заново.",
};

const KIND_MEANING: Partial<Record<PropertyKind, Partial<Record<VerificationStatus, string>>>> = {
  reachable: {
    PROPERTY_HOLDS: "Движок нашёл допустимый путь к целевому состоянию.",
    PROPERTY_VIOLATED: "Движок перебрал все достижимые состояния: цель недостижима.",
  },
  deadlock_free: {
    PROPERTY_HOLDS: "Во всех достижимых состояниях есть разрешённый переход или допустимая остановка.",
    PROPERTY_VIOLATED: "Найдено достижимое состояние без разрешённых переходов, где останавливаться нельзя.",
  },
};

/** Status meaning for a property kind: reachable and deadlock_free read differently from invariants. */
export function statusMeaning(status: string, kind: PropertyKind | undefined): string {
  return (kind && KIND_MEANING[kind]?.[status as VerificationStatus]) ?? statusInfo(status).meaning;
}

export function statusInfo(status: string): StatusInfo {
  return STATUS[status as VerificationStatus] ?? {
    label: status,
    meaning: "Неизвестный статус ответа сервера; результат не интерпретируется.",
    tone: "error",
    conclusive: false,
  };
}

export const PROPERTY_KIND: Record<PropertyKind, { label: string; meaning: string }> = {
  invariant: { label: "Инвариант", meaning: "Условие истинно во всех достижимых состояниях." },
  forbidden_state: { label: "Запрещённое состояние", meaning: "Состояние с этим условием недостижимо." },
  reachable: { label: "Достижимость", meaning: "Существует путь к состоянию с этим условием." },
  deadlock_free: { label: "Без тупиков", meaning: "Остановиться можно только в состояниях с этим условием." },
};

export type TraceRole = "counterexample" | "witness" | "unreachable" | "none";

/** What the result's trace proves, per the checker contract. */
export function traceRole(result: VerificationResult, kind: PropertyKind | undefined): TraceRole {
  if (result.status === "PROPERTY_VIOLATED") {
    if (result.trace.length > 0) return "counterexample";
    if (kind === "reachable") return "unreachable";
    return "none";
  }
  if (result.status === "PROPERTY_HOLDS" && result.trace.length > 0) return "witness";
  return "none";
}

export const RUN_STATE: Record<RunState, string> = {
  queued: "В очереди",
  running: "Выполняется",
  cancelling: "Останавливается",
  cancelled: "Остановлено",
  completed: "Завершено",
  failed: "Сбой",
};

export interface CheckSummary {
  tone: StatusTone | "pending" | "none";
  label: string;
}

/** One label for the workspace header; incomplete results are never shown as success. */
export function summarizeResults(results: VerificationResult[]): CheckSummary {
  if (results.length === 0) return { tone: "none", label: "Не проверялась" };
  const violated = results.filter((r) => r.status === "PROPERTY_VIOLATED").length;
  const holds = results.filter((r) => r.status === "PROPERTY_HOLDS").length;
  const rest = results.length - violated - holds;
  if (violated > 0) return { tone: "violated", label: violated === 1 ? "Найдено нарушение" : `Нарушений: ${violated}` };
  if (rest > 0) {
    const invalid = results.some((r) => r.status === "MODEL_INVALID");
    return { tone: invalid ? "invalid" : "incomplete", label: invalid ? "Модель отклонена" : "Проверка не завершена" };
  }
  return { tone: "holds", label: holds === 1 ? "Свойство выполняется" : `Выполняются все ${holds}` };
}
