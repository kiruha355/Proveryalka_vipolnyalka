import type {ModelVersion, VerificationResult} from "../api/types";

/** Factual context of the selected immutable report, not the server's latest report. */
export function discussionPrompt(version: ModelVersion, checkId: string, result: VerificationResult, intent: "cause" | "correction"): string {
  const property = version.spec.properties.find(p => p.id === result.property_id);
  const sequence = result.trace.map(step => `${step.number}. ${step.transition_id ? version.spec.transitions.find(t => t.id === step.transition_id)?.name ?? step.transition_id : "Начальное состояние"}: ${JSON.stringify(step.state)}`).join("\n");
  return [intent === "cause" ? "Объясни причину найденного контрпримера." : "Обсудим варианты исправления этого нарушения. Пока не меняй требования и модель: сначала предложи варианты и уточни мой выбор.",
    `Вопрос относится к выбранной сохранённой проверке ${checkId}, версия ${version.number} (${version.id}), spec_hash ${result.spec_hash}. Она может отличаться от последнего отчёта в текущем серверном диалоге.`,
    `Правило: ${property?.name ?? result.property_id} (${result.property_id}). Статус: ${result.status}.`,
    sequence ? `Сохранённая трасса:\n${sequence}` : "",].filter(Boolean).join("\n\n");
}
