import type { BehavioralModel, ModelVersion } from "../contracts/model";

export type TransitionEditorFields = {
  name: string;
  requirementIds: string[];
  guardText: string;
  rows: { key: number; variable: string; text: string }[];
  nextKey: number;
};

export type TransitionEdit = { transitionId: string; fields?: TransitionEditorFields };

type GraphEdits = { spec: BehavioralModel; revision: number; editor?: TransitionEdit };

const drafts = new Map<string, GraphEdits>();

export function loadGraphDraft(key: string | null, base: ModelVersion | null) {
  const edits = key ? drafts.get(key) : undefined;
  return base && edits ? { base, ...edits } : null;
}

export function saveGraphDraft(key: string | null, { spec, revision }: GraphEdits) {
  if (key) drafts.set(key, { spec, revision });
}

export function saveGraphEditor(key: string | null, editor?: TransitionEdit) {
  const draft = key ? drafts.get(key) : undefined;
  if (key && draft) drafts.set(key, { ...draft, editor });
}

export function deleteGraphDraft(key: string | null) {
  if (key) drafts.delete(key);
}

export function clearGraphDrafts() {
  drafts.clear();
}
