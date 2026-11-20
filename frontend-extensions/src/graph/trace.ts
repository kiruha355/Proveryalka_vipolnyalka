import type {
  BehavioralModel,
  ModelVersion,
  Property,
  TraceStep,
  Value,
  VerificationResult,
} from "../contracts/model";
import { domainContains, evaluate, EvaluationError } from "../dsl/evaluate";
import type { State } from "../dsl/evaluate";
import { edgeFor, nodeForState } from "./projection";
import type { StateProjection } from "./projection";

/**
 * Наложение трассы TLC на граф.
 *
 * Трасса показывается на версии, только если отчёт относится к ней
 * (version_id и spec_hash). Каждый шаг заново проверяется по DSL этой версии:
 * guard перехода истинен в предыдущем состоянии, эффекты дают следующее
 * состояние, остальные переменные не меняются. Расхождение показывается на
 * шаге, где оно найдено; такой шаг не рисуется на графе как подтверждённый.
 */

export type ReportBinding =
  | { applies: true }
  | { applies: false; reason: "other_version" | "other_spec"; message: string };

export function bindReportToVersion(
  result: Pick<VerificationResult, "version_id" | "spec_hash">,
  version: Pick<ModelVersion, "id" | "number" | "spec_hash">,
  versionNumberById?: (id: string) => number | undefined,
): ReportBinding {
  if (result.version_id !== null && result.version_id !== version.id) {
    const number = versionNumberById?.(result.version_id);
    return {
      applies: false,
      reason: "other_version",
      message:
        number !== undefined
          ? `Отчёт относится к версии ${number}`
          : "Отчёт относится к другой версии",
    };
  }
  if (result.spec_hash !== version.spec_hash) {
    return {
      applies: false,
      reason: "other_spec",
      message: "Хеш спецификации отчёта не совпадает с версией",
    };
  }
  return { applies: true };
}

export type StepReplay =
  | { ok: true }
  | {
      ok: false;
      code:
        | "initial_mismatch"
        | "unknown_transition"
        | "guard_false"
        | "effect_mismatch"
        | "frame_violation"
        | "missing_variable"
        | "unknown_variable"
        | "out_of_domain"
        | "bad_numbering";
      message: string;
    };

export type AnalyzedStep = {
  index: number;
  number: number;
  transitionId: string | null;
  transitionName: string | null;
  state: State;
  /** Переменные, изменившиеся относительно предыдущего шага: id → [было, стало]. */
  changed: Record<string, [Value, Value]>;
  replay: StepReplay;
  /** Значение предиката свойства в этом состоянии; null — не вычислено. */
  predicate: boolean | null;
  /** Переходы, guard которых истинен в этом состоянии (по DSL версии). */
  enabled: string[];
  nodeId: string | null;
  edgeId: string | null;
};

export type TraceRole = "counterexample" | "witness" | "deadlock" | "none";

export type TraceAnalysis = {
  propertyId: string;
  property: Property | null;
  status: VerificationResult["status"];
  role: TraceRole;
  steps: AnalyzedStep[];
  /** Индекс шага, где свойство нарушено (или достигнута цель reachable). */
  focusIndex: number | null;
  consistent: boolean;
  firstMismatch: number | null;
};

function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  return a !== undefined && b !== undefined && typeof a === typeof b && a === b;
}

function readState(
  model: BehavioralModel,
  step: TraceStep,
): { state: State; problem: StepReplay | null } {
  const state: State = {};
  for (const variable of model.variables) {
    const value = step.state[variable.id];
    if (value === undefined) {
      return {
        state,
        problem: {
          ok: false,
          code: "missing_variable",
          message: `В шаге нет переменной ${variable.id}`,
        },
      };
    }
    state[variable.id] = value;
  }
  const extra = Object.keys(step.state).filter(
    (key) => !model.variables.some((variable) => variable.id === key),
  );
  if (extra.length > 0) {
    return {
      state,
      problem: {
        ok: false,
        code: "unknown_variable",
        message: `В шаге есть переменные вне модели: ${extra.join(", ")}`,
      },
    };
  }
  for (const variable of model.variables) {
    if (!domainContains(variable.domain, state[variable.id]!)) {
      return {
        state,
        problem: {
          ok: false,
          code: "out_of_domain",
          message: `${variable.id} = ${JSON.stringify(state[variable.id])} вне области`,
        },
      };
    }
  }
  return { state, problem: null };
}

function enabledTransitions(model: BehavioralModel, state: State): string[] {
  return model.transitions
    .filter((transition) => {
      try {
        return evaluate(transition.guard, state) === true;
      } catch {
        return false;
      }
    })
    .map((transition) => transition.id);
}

function replayStep(
  model: BehavioralModel,
  previous: State,
  current: State,
  transitionId: string | null,
): StepReplay {
  if (transitionId === null) {
    return {
      ok: false,
      code: "unknown_transition",
      message: "У шага после начального нет перехода",
    };
  }
  const transition = model.transitions.find((item) => item.id === transitionId);
  if (!transition) {
    return {
      ok: false,
      code: "unknown_transition",
      message: `Перехода ${transitionId} нет в этой версии`,
    };
  }
  try {
    if (evaluate(transition.guard, previous) !== true) {
      return {
        ok: false,
        code: "guard_false",
        message: `Условие ${transition.id} ложно в предыдущем состоянии`,
      };
    }
    const assigned = new Set<string>();
    for (const effect of transition.effects) {
      assigned.add(effect.variable);
      const expected = evaluate(effect.value, previous);
      if (!sameValue(expected, current[effect.variable])) {
        return {
          ok: false,
          code: "effect_mismatch",
          message: `${effect.variable}: по модели ${JSON.stringify(expected)}, в трассе ${JSON.stringify(current[effect.variable])}`,
        };
      }
    }
    for (const variable of model.variables) {
      if (
        !assigned.has(variable.id) &&
        !sameValue(previous[variable.id], current[variable.id])
      ) {
        return {
          ok: false,
          code: "frame_violation",
          message: `${variable.id} изменилась, хотя ${transition.id} её не присваивает`,
        };
      }
    }
  } catch (error) {
    const message =
      error instanceof EvaluationError ? error.message : String(error);
    return { ok: false, code: "guard_false", message };
  }
  return { ok: true };
}

function roleFor(
  property: Property | null,
  result: VerificationResult,
): TraceRole {
  if (result.trace.length === 0 || !property) return "none";
  if (property.kind === "reachable")
    return result.status === "PROPERTY_HOLDS" ? "witness" : "none";
  if (result.status !== "PROPERTY_VIOLATED") return "none";
  return property.kind === "deadlock_free" ? "deadlock" : "counterexample";
}

export function analyzeTrace(
  model: BehavioralModel,
  result: VerificationResult,
  projection: StateProjection | null,
): TraceAnalysis {
  const property =
    model.properties.find((item) => item.id === result.property_id) ?? null;
  const role = roleFor(property, result);
  const transitionsById = new Map(
    model.transitions.map((transition) => [transition.id, transition]),
  );
  const steps: AnalyzedStep[] = [];
  let previous: State | null = null;
  let firstMismatch: number | null = null;

  result.trace.forEach((step, index) => {
    const { state, problem } = readState(model, step);
    let replay: StepReplay = problem ?? { ok: true };
    if (replay.ok && step.number !== index) {
      replay = {
        ok: false,
        code: "bad_numbering",
        message: `Номер шага ${step.number}, ожидался ${index}`,
      };
    }
    if (replay.ok && index === 0) {
      const mismatch = model.variables.find(
        (variable) => !sameValue(variable.initial_value, state[variable.id]),
      );
      if (step.transition_id !== null) {
        replay = {
          ok: false,
          code: "initial_mismatch",
          message: "У начального шага не должно быть перехода",
        };
      } else if (mismatch) {
        replay = {
          ok: false,
          code: "initial_mismatch",
          message: `${mismatch.id}: начальное значение ${JSON.stringify(mismatch.initial_value)}, в трассе ${JSON.stringify(state[mismatch.id])}`,
        };
      }
    } else if (replay.ok && previous) {
      replay = replayStep(model, previous, state, step.transition_id);
    }
    if (!replay.ok && firstMismatch === null) firstMismatch = index;

    const changed: Record<string, [Value, Value]> = {};
    if (previous) {
      for (const variable of model.variables) {
        const before = previous[variable.id];
        const after = state[variable.id];
        if (
          before !== undefined &&
          after !== undefined &&
          !sameValue(before, after)
        )
          changed[variable.id] = [before, after];
      }
    }

    let predicate: boolean | null = null;
    if (property && problem === null) {
      try {
        const value = evaluate(property.predicate, state);
        predicate = typeof value === "boolean" ? value : null;
      } catch {
        predicate = null;
      }
    }

    const nodeId =
      projection && problem === null ? nodeForState(projection, state) : null;
    const previousNode = index > 0 ? (steps[index - 1]?.nodeId ?? null) : null;
    const edge =
      projection && replay.ok && step.transition_id && previousNode && nodeId
        ? edgeFor(projection, step.transition_id, previousNode, nodeId)
        : null;

    steps.push({
      index,
      number: step.number,
      transitionId: step.transition_id,
      transitionName: step.transition_id
        ? (transitionsById.get(step.transition_id)?.name ?? null)
        : null,
      state,
      changed,
      replay,
      predicate,
      enabled: problem === null ? enabledTransitions(model, state) : [],
      nodeId,
      edgeId: edge?.id ?? null,
    });
    previous = problem === null ? state : null;
  });

  return {
    propertyId: result.property_id,
    property,
    status: result.status,
    role,
    steps,
    focusIndex: focusIndexFor(property, role, steps),
    consistent: firstMismatch === null,
    firstMismatch,
  };
}

function focusIndexFor(
  property: Property | null,
  role: TraceRole,
  steps: AnalyzedStep[],
): number | null {
  if (!property || steps.length === 0 || role === "none") return null;
  if (role === "deadlock") return steps.length - 1;
  const hit = steps.findIndex((step) =>
    property.kind === "invariant"
      ? step.predicate === false
      : step.predicate === true,
  );
  return hit >= 0 ? hit : null;
}

/**
 * Результат для показа трассы: выбранное свойство, иначе первое нарушенное
 * с трассой, иначе первое с трассой-примером достижимости.
 */
export function pickTraceResult(
  results: VerificationResult[],
  propertyId?: string | null,
): VerificationResult | null {
  if (propertyId)
    return results.find((result) => result.property_id === propertyId) ?? null;
  return (
    results.find(
      (result) =>
        result.status === "PROPERTY_VIOLATED" && result.trace.length > 0,
    ) ??
    results.find((result) => result.trace.length > 0) ??
    null
  );
}
