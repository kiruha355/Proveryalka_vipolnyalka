import type { BehavioralModel } from "../api/types";

import { formatExpression } from "./expression";

export interface ElementChange {
  section: "variables" | "transitions" | "properties" | "requirements";
  id: string;
  name: string;
  change: "added" | "removed" | "changed";
  /** Top-level fields that differ, for "changed". */
  fields: string[];
  /** For transitions: effect lines added and removed, e.g. "approved := false". */
  effects?: { added: string[]; removed: string[] };
}

// Quote offsets move whenever earlier source text changes; only the wording matters for a reader.
function comparable(section: ElementChange["section"], element: Record<string, unknown>): Record<string, unknown> {
  if (section !== "requirements") return element;
  const refs = (element.source_refs as { quote: string }[] | undefined) ?? [];
  return { ...element, source_refs: refs.map((r) => r.quote) };
}

function effectLines(element: Record<string, unknown>): string[] {
  const effects = (element.effects as { variable: string; value: Parameters<typeof formatExpression>[0] }[] | undefined) ?? [];
  return effects.map((e) => `${e.variable} := ${formatExpression(e.value)}`);
}

const SECTIONS = ["requirements", "variables", "transitions", "properties"] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Element-level comparison of two immutable versions, keyed by element id. */
export function diffModels(before: BehavioralModel, after: BehavioralModel): ElementChange[] {
  const changes: ElementChange[] = [];
  for (const section of SECTIONS) {
    const old = new Map<string, Record<string, unknown>>(
      (before[section] as unknown as Record<string, unknown>[]).map((e) => [String(e.id), e]),
    );
    const now = new Map<string, Record<string, unknown>>(
      (after[section] as unknown as Record<string, unknown>[]).map((e) => [String(e.id), e]),
    );
    for (const [id, element] of now) {
      const name = String(element.name ?? element.text ?? id);
      const previous = old.get(id);
      if (!previous) {
        changes.push({ section, id, name, change: "added", fields: [] });
        continue;
      }
      const a = comparable(section, previous);
      const b = comparable(section, element);
      const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !sameJson(a[k], b[k]));
      if (!fields.length) continue;
      const change: ElementChange = { section, id, name, change: "changed", fields };
      if (section === "transitions" && fields.includes("effects")) {
        const before = effectLines(previous);
        const after = effectLines(element);
        change.effects = { added: after.filter((l) => !before.includes(l)), removed: before.filter((l) => !after.includes(l)) };
      }
      changes.push(change);
    }
    for (const [id, element] of old) {
      if (!now.has(id)) changes.push({ section, id, name: String(element.name ?? element.text ?? id), change: "removed", fields: [] });
    }
  }
  return changes;
}
