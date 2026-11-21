import type { BehavioralModel, ModelVersion } from "../contracts/model";

type GraphEdits = { spec: BehavioralModel; revision: number };

const drafts = new Map<string, GraphEdits>();

export function loadGraphDraft(key: string | null, base: ModelVersion | null) {
  const edits = key ? drafts.get(key) : undefined;
  return base && edits ? { base, ...edits } : null;
}

export function saveGraphDraft(key: string | null, { spec, revision }: GraphEdits) {
  if (key) drafts.set(key, { spec, revision });
}

export function deleteGraphDraft(key: string | null) {
  if (key) drafts.delete(key);
}

export function clearGraphDrafts() {
  drafts.clear();
}
