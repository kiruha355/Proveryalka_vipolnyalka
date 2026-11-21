import type { BehavioralModel, ModelVersion } from "../contracts/model";

type GraphEdits = { spec: BehavioralModel; revision: number };

export type TransitionForm = {
  transitionId: string;
  revision: number;
  name: string;
  requirementIds: string[];
  guardText: string;
  rows: { key: number; variable: string; text: string }[];
  nextKey: number;
};

const drafts = new Map<string, GraphEdits>();
const transitionForms = new Map<string, TransitionForm>();

export function loadGraphDraft(key: string | null, base: ModelVersion | null) {
  const edits = key ? drafts.get(key) : undefined;
  return base && edits ? { base, ...edits } : null;
}

export function saveGraphDraft(key: string | null, { spec, revision }: GraphEdits) {
  if (key) drafts.set(key, { spec, revision });
}

export function deleteGraphDraft(key: string | null) {
  if (key) {
    drafts.delete(key);
    transitionForms.delete(key);
  }
}

export function clearGraphDrafts() {
  drafts.clear();
  transitionForms.clear();
}

export function loadTransitionForm(key: string | null, revision: number | undefined) {
  const form = key ? transitionForms.get(key) : undefined;
  return form?.revision === revision ? form : undefined;
}

export function saveTransitionForm(key: string | null, form: TransitionForm | null) {
  if (!key) return;
  if (form) transitionForms.set(key, form);
  else transitionForms.delete(key);
}
