import type { ExtractedRequirement, Source, SourceRef } from "../api/types";

export interface RequirementIndex {
  byId: Map<string, ExtractedRequirement>;
  /** Short reader-facing label; ids like R1 are kept, opaque ids get R{n} by position. */
  label(id: string): string;
  sources: Map<string, Source>;
}

const SHORT = /^R\d+$/;

export function indexRequirements(requirements: ExtractedRequirement[], sources: Source[]): RequirementIndex {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const labels = new Map<string, string>();
  requirements.forEach((r, i) => labels.set(r.id, SHORT.test(r.id) ? r.id : `R${i + 1}`));
  return {
    byId,
    label: (id) => labels.get(id) ?? id,
    sources: new Map(sources.map((s) => [s.id, s])),
  };
}

export interface Highlight {
  start: number;
  end: number;
  requirementIds: string[];
}

/** Non-overlapping spans of a source text annotated with the requirements quoting them. */
export function highlightSpans(source: Source, requirements: ExtractedRequirement[]): Highlight[] {
  const marks: { at: number; id: string; open: boolean }[] = [];
  for (const requirement of requirements) {
    for (const ref of requirement.source_refs) {
      if (ref.source_id !== source.id || !refMatches(source, ref)) continue;
      marks.push({ at: ref.start, id: requirement.id, open: true }, { at: ref.end, id: requirement.id, open: false });
    }
  }
  const points = [...new Set([0, source.text.length, ...marks.map((m) => m.at)])].sort((a, b) => a - b);
  const spans: Highlight[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    const ids = requirements
      .filter((r) => r.source_refs.some((ref) => ref.source_id === source.id && refMatches(source, ref) && ref.start <= start && ref.end >= end))
      .map((r) => r.id);
    spans.push({ start, end, requirementIds: ids });
  }
  return spans;
}

/** The server validates quotes; a mismatch here means the source changed and offsets are untrustworthy. */
export function refMatches(source: Source, ref: SourceRef): boolean {
  return source.text.slice(ref.start, ref.end) === ref.quote;
}
