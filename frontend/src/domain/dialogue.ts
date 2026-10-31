import type { DialogueState, Message, VerificationOutcome } from "../api/types";

// SessionDetail.messages is the analyst's stored SDK history. Assistant items
// carry JSON wrappers (agent/dialogue.py, agent/verification.py); they are
// parsed here and never shown to the reader as raw JSON.

export type HistoryEntry =
  | { kind: "user"; key: string; text: string; createdAt: string; sequence: number; status: "processed" | "pending" | "discarded" }
  | { kind: "analysis"; key: string; state: DialogueState; createdAt: string; sequence: number; isLatest: boolean }
  | { kind: "verification"; key: string; outcome: VerificationOutcome; createdAt: string; sequence: number }
  | { kind: "assistant_text"; key: string; text: string; createdAt: string; sequence: number }
  | { kind: "corrupt"; key: string; wrapper: string; createdAt: string; sequence: number };

export interface PendingTurn {
  text: string;
  questionId: string | null;
}

export interface ParsedHistory {
  entries: HistoryEntry[];
  /** Latest analyst_dialogue snapshot: requirements, questions, model. */
  dialogue: DialogueState | null;
  /** A user turn the analyst accepted but did not finish (failed or cancelled run). */
  pending: PendingTurn | null;
  verifications: VerificationOutcome[];
}

const WRAPPERS = ["analyst_dialogue", "analyst_pending", "analyst_pending_cancelled", "analyst_verification"] as const;

function wrapperOf(content: string): string | null {
  const match = /^\{"([a-z_]+)":/.exec(content);
  return match ? (match[1] ?? null) : null;
}

export function parseHistory(messages: Message[]): ParsedHistory {
  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence);
  const entries: HistoryEntry[] = [];
  let dialogue: DialogueState | null = null;
  let pending: PendingTurn | null = null;
  let pendingEntry: Extract<HistoryEntry, { kind: "user" }> | null = null;
  const verifications: VerificationOutcome[] = [];

  for (const message of sorted) {
    const data = message.message_data as { role?: unknown; content?: unknown };
    const base = { key: message.id, createdAt: message.created_at, sequence: message.sequence };
    if (typeof data.content !== "string") continue;
    const content = data.content;
    const wrapper = content.startsWith("{\"") ? wrapperOf(content) : null;

    if (data.role === "user") {
      // verify_and_explain stores its request as a user item; it is not something the person typed.
      if (wrapper === "verification_request") continue;
      const entry = { kind: "user" as const, ...base, text: content, status: "processed" as const };
      entries.push(entry);
      continue;
    }
    if (data.role !== "assistant") continue;

    if (wrapper === null) {
      entries.push({ kind: "assistant_text", ...base, text: content });
      continue;
    }
    if (!(WRAPPERS as readonly string[]).includes(wrapper)) continue;

    let payload: unknown;
    try {
      payload = (JSON.parse(content) as Record<string, unknown>)[wrapper];
    } catch {
      entries.push({ kind: "corrupt", ...base, wrapper });
      continue;
    }

    if (wrapper === "analyst_pending") {
      const turn = payload as { source?: { text?: unknown }; question_id?: unknown };
      const text = typeof turn?.source?.text === "string" ? turn.source.text : "";
      pending = { text, questionId: typeof turn?.question_id === "string" ? turn.question_id : null };
      // The user item stored right before the pending marker is that turn.
      const last = entries[entries.length - 1];
      pendingEntry = last && last.kind === "user" && last.text === text ? last : null;
      if (pendingEntry) entries[entries.length - 1] = pendingEntry = { ...pendingEntry, status: "pending" };
    } else if (wrapper === "analyst_pending_cancelled") {
      if (pendingEntry) replaceEntry(entries, pendingEntry, { ...pendingEntry, status: "discarded" });
      pending = null;
      pendingEntry = null;
    } else if (wrapper === "analyst_dialogue") {
      const state = payload as DialogueState;
      if (!state || state.schema_version !== "2.0" || !state.analysis) {
        entries.push({ kind: "corrupt", ...base, wrapper });
        continue;
      }
      if (pendingEntry) replaceEntry(entries, pendingEntry, { ...pendingEntry, status: "processed" });
      pending = null;
      pendingEntry = null;
      dialogue = state;
      entries.push({ kind: "analysis", ...base, state, isLatest: false });
    } else if (wrapper === "analyst_verification") {
      const outcome = payload as VerificationOutcome;
      if (!outcome?.report || !Array.isArray(outcome.report.results)) {
        entries.push({ kind: "corrupt", ...base, wrapper });
        continue;
      }
      verifications.push(outcome);
      entries.push({ kind: "verification", ...base, outcome });
    }
  }

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind === "analysis") {
      entries[i] = { ...entry, isLatest: true };
      break;
    }
  }
  return { entries, dialogue, pending, verifications };
}

function replaceEntry(entries: HistoryEntry[], target: HistoryEntry, next: HistoryEntry) {
  const index = entries.indexOf(target);
  if (index !== -1) entries[index] = next;
}

export const DIALOGUE_STATUS: Record<DialogueState["status"], string> = {
  ready: "Модель готова к проверке",
  needs_clarification: "Нужны уточнения",
  model_incomplete: "Модель неполная",
  limit_reached: "Лимит уточнений исчерпан",
};
