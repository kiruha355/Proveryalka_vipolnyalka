import type {
  Assignment,
  BehavioralModel,
  Expression,
  ModelVersion,
  Transition,
  Variable,
} from "../contracts/model";
import { IDENTIFIER_PATTERN } from "../contracts/model";
import {
  expressionsEqual,
  expressionVariables,
  formatExpression,
} from "../dsl/expression-text";
import { sha256Hex } from "../util/sha256";
import { canonicalJson } from "../util/canonical-json";

/**
 * Черновик правки версии. Исходная версия не изменяется: каждое действие
 * возвращает новый spec, а сохранение создаёт новую версию с parent_id.
 */

export type DraftBase = Pick<
  ModelVersion,
  "id" | "model_id" | "number" | "spec_hash" | "spec"
>;

export type DraftAction =
  | { type: "set_guard"; transitionId: string; guard: Expression }
  | { type: "set_effects"; transitionId: string; effects: Assignment[] }
  | {
      type: "set_transition_meta";
      transitionId: string;
      name?: string;
      requirementIds?: string[];
    }
  | { type: "add_transition"; transition: Transition }
  | { type: "remove_transition"; transitionId: string }
  | { type: "add_enum_value"; variableId: string; value: string }
  | { type: "remove_enum_value"; variableId: string; value: string };

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

function replaceTransition(
  spec: BehavioralModel,
  id: string,
  update: (transition: Transition) => Transition,
): BehavioralModel {
  const index = spec.transitions.findIndex(
    (transition) => transition.id === id,
  );
  if (index < 0) throw new DraftError(`Перехода ${id} нет в модели`);
  const transitions = spec.transitions.slice();
  transitions[index] = update(transitions[index]!);
  return { ...spec, transitions };
}

function replaceVariable(
  spec: BehavioralModel,
  id: string,
  update: (variable: Variable) => Variable,
): BehavioralModel {
  const index = spec.variables.findIndex((variable) => variable.id === id);
  if (index < 0) throw new DraftError(`Переменной ${id} нет в модели`);
  const variables = spec.variables.slice();
  variables[index] = update(variables[index]!);
  return { ...spec, variables };
}

/** Места, где enum-значение встречается литералом рядом с переменной: guards, effects, свойства, initial. */
export function enumValueUsages(
  spec: BehavioralModel,
  variableId: string,
  value: string,
): string[] {
  const usages: string[] = [];
  const variable = spec.variables.find((item) => item.id === variableId);
  if (variable?.initial_value === value)
    usages.push(`variables.${variableId}.initial_value`);
  const mentions = (expression: Expression): boolean => {
    if (expression.kind === "unary") return mentions(expression.operand);
    if (expression.kind !== "binary") return false;
    const pair = (a: Expression, b: Expression) =>
      a.kind === "variable" &&
      a.name === variableId &&
      b.kind === "literal" &&
      b.value === value;
    return (
      pair(expression.left, expression.right) ||
      pair(expression.right, expression.left) ||
      mentions(expression.left) ||
      mentions(expression.right)
    );
  };
  for (const transition of spec.transitions) {
    if (mentions(transition.guard))
      usages.push(`transitions.${transition.id}.guard`);
    transition.effects.forEach((effect, index) => {
      if (
        effect.variable === variableId &&
        effect.value.kind === "literal" &&
        effect.value.value === value
      ) {
        usages.push(`transitions.${transition.id}.effects[${index}]`);
      } else if (mentions(effect.value)) {
        usages.push(`transitions.${transition.id}.effects[${index}]`);
      }
    });
  }
  for (const property of spec.properties) {
    if (mentions(property.predicate))
      usages.push(`properties.${property.id}.predicate`);
  }
  return usages;
}

export function applyDraftAction(
  spec: BehavioralModel,
  action: DraftAction,
): BehavioralModel {
  switch (action.type) {
    case "set_guard":
      return replaceTransition(spec, action.transitionId, (transition) => ({
        ...transition,
        guard: action.guard,
      }));
    case "set_effects":
      return replaceTransition(spec, action.transitionId, (transition) => ({
        ...transition,
        effects: action.effects.map((effect) => ({
          variable: effect.variable,
          value: effect.value,
        })),
      }));
    case "set_transition_meta":
      return replaceTransition(spec, action.transitionId, (transition) => ({
        ...transition,
        ...(action.name !== undefined ? { name: action.name } : {}),
        ...(action.requirementIds !== undefined
          ? { requirement_ids: [...action.requirementIds] }
          : {}),
      }));
    case "add_transition": {
      if (!IDENTIFIER_PATTERN.test(action.transition.id)) {
        throw new DraftError(
          `ID перехода должен начинаться с латинской буквы и содержать только A–Z, a–z, 0–9, _: ${action.transition.id}`,
        );
      }
      if (
        spec.transitions.some(
          (transition) => transition.id === action.transition.id,
        )
      ) {
        throw new DraftError(`Переход ${action.transition.id} уже есть`);
      }
      return { ...spec, transitions: [...spec.transitions, action.transition] };
    }
    case "remove_transition": {
      if (
        !spec.transitions.some(
          (transition) => transition.id === action.transitionId,
        )
      ) {
        throw new DraftError(`Перехода ${action.transitionId} нет в модели`);
      }
      return {
        ...spec,
        transitions: spec.transitions.filter(
          (transition) => transition.id !== action.transitionId,
        ),
      };
    }
    case "add_enum_value":
      return replaceVariable(spec, action.variableId, (variable) => {
        if (variable.domain.kind !== "enum")
          throw new DraftError(`${variable.id} не enum`);
        const value = action.value;
        if (!value.trim())
          throw new DraftError("Значение не должно быть пустым");
        if (variable.domain.values.includes(value))
          throw new DraftError(`Значение ${value} уже есть`);
        return {
          ...variable,
          domain: { kind: "enum", values: [...variable.domain.values, value] },
        };
      });
    case "remove_enum_value": {
      const usages = enumValueUsages(spec, action.variableId, action.value);
      if (usages.length > 0) {
        throw new DraftError(
          `Значение ${action.value} используется: ${usages.join(", ")}`,
        );
      }
      return replaceVariable(spec, action.variableId, (variable) => {
        if (variable.domain.kind !== "enum")
          throw new DraftError(`${variable.id} не enum`);
        if (variable.domain.values.length <= 1)
          throw new DraftError("В enum должно остаться хотя бы одно значение");
        return {
          ...variable,
          domain: {
            kind: "enum",
            values: variable.domain.values.filter(
              (item) => item !== action.value,
            ),
          },
        };
      });
    }
  }
}

export type ModelChange =
  | { kind: "transition_added"; id: string }
  | { kind: "transition_removed"; id: string }
  | { kind: "guard_changed"; id: string; before: string; after: string }
  | { kind: "effects_changed"; id: string; before: string; after: string }
  | { kind: "transition_renamed"; id: string; before: string; after: string }
  | {
      kind: "transition_requirements_changed";
      id: string;
      before: string[];
      after: string[];
    }
  | {
      kind: "enum_values_changed";
      id: string;
      added: string[];
      removed: string[];
    }
  | { kind: "other"; path: string };

export function formatEffects(effects: Assignment[]): string {
  if (effects.length === 0) return "без изменений";
  return effects
    .map((effect) => `${effect.variable} := ${formatExpression(effect.value)}`)
    .join("; ");
}

function effectsEqual(a: Assignment[], b: Assignment[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (effect, index) =>
        effect.variable === b[index]!.variable &&
        expressionsEqual(effect.value, b[index]!.value),
    )
  );
}

/**
 * Все отличия черновика от исходной версии. Изменения вне переходов и enum
 * сводятся к записи «other» с путём раздела, чтобы ни одна правка не осталась
 * незамеченной в сводке перед созданием версии.
 */
export function diffModels(
  before: BehavioralModel,
  after: BehavioralModel,
): ModelChange[] {
  const changes: ModelChange[] = [];
  const beforeTransitions = new Map(
    before.transitions.map((transition) => [transition.id, transition]),
  );
  const afterTransitions = new Map(
    after.transitions.map((transition) => [transition.id, transition]),
  );
  for (const transition of before.transitions) {
    if (!afterTransitions.has(transition.id))
      changes.push({ kind: "transition_removed", id: transition.id });
  }
  for (const transition of after.transitions) {
    const previous = beforeTransitions.get(transition.id);
    if (!previous) {
      changes.push({ kind: "transition_added", id: transition.id });
      continue;
    }
    if (previous.name !== transition.name) {
      changes.push({
        kind: "transition_renamed",
        id: transition.id,
        before: previous.name,
        after: transition.name,
      });
    }
    if (
      canonicalJson(previous.requirement_ids) !==
      canonicalJson(transition.requirement_ids)
    ) {
      changes.push({
        kind: "transition_requirements_changed",
        id: transition.id,
        before: previous.requirement_ids,
        after: transition.requirement_ids,
      });
    }
    if (!expressionsEqual(previous.guard, transition.guard)) {
      changes.push({
        kind: "guard_changed",
        id: transition.id,
        before: formatExpression(previous.guard),
        after: formatExpression(transition.guard),
      });
    }
    if (!effectsEqual(previous.effects, transition.effects)) {
      changes.push({
        kind: "effects_changed",
        id: transition.id,
        before: formatEffects(previous.effects),
        after: formatEffects(transition.effects),
      });
    }
  }
  const order = (items: Transition[]) =>
    items
      .map((item) => item.id)
      .filter((id) => beforeTransitions.has(id) && afterTransitions.has(id));
  if (
    canonicalJson(order(before.transitions)) !==
    canonicalJson(order(after.transitions))
  ) {
    changes.push({ kind: "other", path: "transitions (порядок)" });
  }

  const beforeVariables = new Map(
    before.variables.map((variable) => [variable.id, variable]),
  );
  const variableShape = (variable: Variable) =>
    canonicalJson({
      ...variable,
      domain:
        variable.domain.kind === "enum" ? { kind: "enum" } : variable.domain,
    });
  if (
    canonicalJson(before.variables.map((variable) => variable.id)) !==
    canonicalJson(after.variables.map((variable) => variable.id))
  ) {
    changes.push({ kind: "other", path: "variables" });
  } else {
    for (const variable of after.variables) {
      const previous = beforeVariables.get(variable.id)!;
      if (previous.domain.kind === "enum" && variable.domain.kind === "enum") {
        const added = variable.domain.values.filter(
          (value) =>
            !(previous.domain as { values: string[] }).values.includes(value),
        );
        const removed = previous.domain.values.filter(
          (value) =>
            !(variable.domain as { values: string[] }).values.includes(value),
        );
        if (added.length > 0 || removed.length > 0)
          changes.push({
            kind: "enum_values_changed",
            id: variable.id,
            added,
            removed,
          });
        else if (
          canonicalJson(previous.domain.values) !==
          canonicalJson(variable.domain.values)
        ) {
          changes.push({
            kind: "other",
            path: `variables.${variable.id}.domain (порядок)`,
          });
        }
      }
      if (variableShape(previous) !== variableShape(variable))
        changes.push({ kind: "other", path: `variables.${variable.id}` });
    }
  }
  for (const key of [
    "schema_version",
    "name",
    "sources",
    "requirements",
    "properties",
  ] as const) {
    if (canonicalJson(before[key]) !== canonicalJson(after[key]))
      changes.push({ kind: "other", path: key });
  }
  return changes;
}

/** Ключ идемпотентности: тот же черновик от той же версии повторно не создаст вторую версию. */
export function draftIdempotencyKey(
  parentVersionId: string,
  spec: BehavioralModel,
): string {
  const digest = sha256Hex(new TextEncoder().encode(canonicalJson(spec)));
  const key = `graph-edit-${parentVersionId}-${digest}`;
  return key.length <= 128
    ? key
    : `graph-edit-${sha256Hex(new TextEncoder().encode(key))}`;
}

export type VersionCreateBody = { spec: BehavioralModel; parent_id: string };

export function versionCreateBody(
  base: DraftBase,
  spec: BehavioralModel,
): VersionCreateBody {
  return { spec, parent_id: base.id };
}

/** Новый переход по умолчанию из узла проекции: guard фиксирует значения узла. */
export function transitionTemplate(
  spec: BehavioralModel,
  fromValues: Record<string, string | number | boolean>,
  requirementId: string,
): Transition {
  const used = new Set(spec.transitions.map((transition) => transition.id));
  let index = spec.transitions.length + 1;
  while (used.has(`Transition${index}`)) index += 1;
  const conditions: Expression[] = Object.entries(fromValues).map(
    ([name, value]) => ({
      kind: "binary",
      op: "eq",
      left: { kind: "variable", name },
      right: { kind: "literal", value },
    }),
  );
  const guard: Expression =
    conditions.length === 0
      ? { kind: "literal", value: true }
      : conditions.reduce((left, right) => ({
          kind: "binary",
          op: "and",
          left,
          right,
        }));
  return {
    id: `Transition${index}`,
    name: `Переход ${index}`,
    requirement_ids: [requirementId],
    guard,
    effects: [],
  };
}

/** Переменные, на которые ссылается переход (guard и правые части эффектов). */
export function transitionReads(transition: Transition): string[] {
  const names = expressionVariables(transition.guard);
  for (const effect of transition.effects)
    expressionVariables(effect.value, names);
  return [...names];
}
