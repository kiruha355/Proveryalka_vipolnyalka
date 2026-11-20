import type { BehavioralModel, Property, Transition, Value, VerificationResult } from "../api/types";
import { tryEvaluate, variablesOf } from "./expression";
import type { TraceRole } from "./status";

export interface Change {
  variable: string;
  before: Value | undefined;
  after: Value | undefined;
}

export interface StepView {
  number: number;
  transitionId: string | null;
  /** Undefined when the trace names a transition missing from the model. */
  transition: Transition | null | undefined;
  state: Record<string, Value>;
  changes: Change[];
  requirementIds: string[];
  /** Property predicate evaluated locally in this state; undefined if not computable. */
  predicate: boolean | undefined;
}

export function buildSteps(result: VerificationResult, model: BehavioralModel, property?: Property): StepView[] {
  const transitions = new Map(model.transitions.map((t) => [t.id, t]));
  const order = model.variables.map((v) => v.id);
  return result.trace.map((step, index) => {
    const previous = index > 0 ? result.trace[index - 1]?.state : undefined;
    const keys = [...new Set([...order, ...Object.keys(step.state)])];
    const changes: Change[] = previous
      ? keys.filter((k) => previous[k] !== step.state[k]).map((k) => ({ variable: k, before: previous[k], after: step.state[k] }))
      : [];
    const transition = step.transition_id === null ? null : transitions.get(step.transition_id);
    const value = property ? tryEvaluate(property.predicate, step.state) : undefined;
    return {
      number: step.number,
      transitionId: step.transition_id,
      transition,
      state: step.state,
      changes,
      requirementIds: transition ? transition.requirement_ids : [],
      predicate: typeof value === "boolean" ? value : undefined,
    };
  });
}

/**
 * Index of the step the reader should look at: the first violating state of
 * a counterexample, the target of a reachability witness, or the deadlock.
 */
export function focusIndex(steps: StepView[], property: Property | undefined, role: TraceRole): number | null {
  if (steps.length === 0 || role === "none" || role === "unreachable") return null;
  const last = steps.length - 1;
  if (!property) return last;
  let index = -1;
  if (property.kind === "invariant") index = steps.findIndex((s) => s.predicate === false);
  else if (property.kind === "forbidden_state" || property.kind === "reachable") index = steps.findIndex((s) => s.predicate === true);
  else return last; // deadlock_free: the final state has no enabled transition
  return index === -1 ? last : index;
}

export interface GuardFact {
  variable: string;
  value: Value | undefined;
  /** Step where the variable got this value (0 = initial state). */
  setAt: number;
  /** Steps after setAt whose transitions left the variable unchanged. */
  keptBy: StepView[];
}

/**
 * Why the transition into steps[index] was enabled: for every variable read
 * by its guard, where the value it had came from. Pure data, no wording.
 */
export function guardFacts(steps: StepView[], index: number): GuardFact[] {
  const step = steps[index];
  if (!step?.transition || index === 0) return [];
  const before = steps[index - 1];
  if (!before) return [];
  return [...variablesOf(step.transition.guard)].map((variable) => {
    const value = before.state[variable];
    let setAt = index - 1;
    while (setAt > 0 && steps[setAt - 1]?.state[variable] === value) setAt -= 1;
    return { variable, value, setAt, keptBy: steps.slice(setAt + 1, index) };
  });
}

/** Requirement ids touched by the trace's transitions and the property, in first-seen order. */
export function traceRequirements(steps: StepView[], property: Property | undefined): string[] {
  const ids: string[] = [];
  for (const step of steps) for (const id of step.requirementIds) if (!ids.includes(id)) ids.push(id);
  for (const id of property?.requirement_ids ?? []) if (!ids.includes(id)) ids.push(id);
  return ids;
}
