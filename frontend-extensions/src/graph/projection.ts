import type {
  BehavioralModel,
  Expression,
  Transition,
  Value,
  Variable,
} from "../contracts/model";
import {
  domainContains,
  domainSize,
  domainValues,
  simplify,
} from "../dsl/evaluate";
import { formatValue } from "../dsl/expression-text";

/**
 * Проекция BehavioralModel на граф.
 *
 * Состояние модели — вектор значений всех переменных. Граф показывает только
 * выбранные переменные проекции: узел — сочетание их значений, остальные
 * переменные в узле не фиксированы. Ребро A → B для перехода t строится, если
 * guard(t) не ложен при значениях A (неизвестные переменные — третье значение),
 * а эффекты t могут перевести проекцию в B.
 *
 * Свойства, на которые опирается интерфейс:
 *  - каждый реальный шаг модели s → s' по переходу t попадает в ребро
 *    proj(s) → proj(s') с тем же t (проекция не теряет переходов);
 *  - ребро не означает достижимость: условие на скрытые переменные указано
 *    в guardResidual, а достижимые состояния устанавливает только TLC.
 */

export const DEFAULT_MAX_PROJECTION_NODES = 48;
export const OUT_OF_DOMAIN_NODE_ID = "__out_of_domain__";

export type ProjectionNode = {
  id: string;
  /** Значения переменных проекции; у узла вне области пусто. */
  values: Record<string, Value>;
  label: string;
  initial: boolean;
  outOfDomain: boolean;
};

export type EdgeKind = "unconditional" | "conditional" | "computed" | "invalid";

export type ProjectionEdge = {
  id: string;
  transitionId: string;
  source: string;
  target: string;
  /** null — guard истинен при значениях узла-источника, иначе остаток условия на скрытые переменные. */
  guardResidual: Expression | null;
  /** Эффекты по переменным проекции, значение которых зависит от скрытых переменных. */
  effectResiduals: Record<string, Expression>;
  targetDetermined: boolean;
  /** Для invalid: присваивание вне области (переменная → значение). */
  outOfDomainValues: Record<string, Value>;
  selfLoop: boolean;
  kind: EdgeKind;
};

export type ProjectionCandidate = {
  variable: Variable;
  size: number;
  allowed: boolean;
};

export type StateProjection = {
  variableIds: string[];
  variables: Variable[];
  hiddenVariables: Variable[];
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
  /** Переходы, guard которых ложен при любом значении проекции: в графе их нет. */
  neverEnabled: string[];
  maxNodes: number;
};

export type ProjectionRefusal = {
  ok: false;
  reason: string;
  nodeCount: number;
  maxNodes: number;
};
export type ProjectionResult =
  | { ok: true; projection: StateProjection }
  | ProjectionRefusal;

export function nodeKey(
  values: Record<string, Value>,
  variableIds: string[],
): string {
  return JSON.stringify(variableIds.map((id) => values[id] ?? null));
}

export function projectionCandidates(
  model: BehavioralModel,
  maxNodes = DEFAULT_MAX_PROJECTION_NODES,
): ProjectionCandidate[] {
  return model.variables.map((variable) => {
    const size = domainSize(variable.domain);
    return { variable, size, allowed: size <= maxNodes };
  });
}

const CONTROL_NAME =
  /^(status|state|phase|stage|step|mode)$|status|state|phase|stage/i;

/**
 * Проекция по умолчанию: enum с наибольшей областью в пределах лимита,
 * при равенстве — переменная с именем status/state/phase. Если enum нет,
 * берётся первая подходящая переменная. Пустой массив — нет подходящих.
 */
export function defaultProjection(
  model: BehavioralModel,
  maxNodes = DEFAULT_MAX_PROJECTION_NODES,
): string[] {
  const candidates = projectionCandidates(model, maxNodes).filter(
    (candidate) => candidate.allowed,
  );
  const enums = candidates.filter(
    (candidate) =>
      candidate.variable.domain.kind === "enum" && candidate.size > 1,
  );
  const pool =
    enums.length > 0
      ? enums
      : candidates.filter((candidate) => candidate.size > 1);
  if (pool.length === 0) return [];
  const best = [...pool].sort((a, b) => {
    const named =
      Number(CONTROL_NAME.test(b.variable.id)) -
      Number(CONTROL_NAME.test(a.variable.id));
    if (named !== 0) return named;
    if (enums.length > 0 && a.size !== b.size) return b.size - a.size;
    return (
      model.variables.indexOf(a.variable) - model.variables.indexOf(b.variable)
    );
  })[0]!;
  return [best.variable.id];
}

function cartesian(variables: Variable[]): Array<Record<string, Value>> {
  let combos: Array<Record<string, Value>> = [{}];
  for (const variable of variables) {
    const next: Array<Record<string, Value>> = [];
    for (const combo of combos) {
      for (const value of domainValues(variable.domain))
        next.push({ ...combo, [variable.id]: value });
    }
    combos = next;
  }
  return combos;
}

export function nodeLabel(
  values: Record<string, Value>,
  variables: Variable[],
): string {
  if (variables.length === 0) return "Все состояния";
  if (variables.length === 1) {
    const variable = variables[0]!;
    const value = values[variable.id]!;
    return variable.domain.kind === "enum"
      ? String(value)
      : `${variable.id} = ${formatValue(value)}`;
  }
  return variables
    .map((variable) => {
      const value = values[variable.id]!;
      return variable.domain.kind === "enum"
        ? String(value)
        : `${variable.id} = ${formatValue(value)}`;
    })
    .join(", ");
}

function edgeKind(edge: Omit<ProjectionEdge, "kind">): EdgeKind {
  if (edge.target === OUT_OF_DOMAIN_NODE_ID) return "invalid";
  if (!edge.targetDetermined) return "computed";
  if (edge.guardResidual !== null) return "conditional";
  return "unconditional";
}

export function projectModel(
  model: BehavioralModel,
  variableIds: string[],
  maxNodes = DEFAULT_MAX_PROJECTION_NODES,
): ProjectionResult {
  const byId = new Map(
    model.variables.map((variable) => [variable.id, variable]),
  );
  const unknown = variableIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `Нет переменной: ${unknown.join(", ")}`,
      nodeCount: 0,
      maxNodes,
    };
  }
  if (new Set(variableIds).size !== variableIds.length) {
    return {
      ok: false,
      reason: "Переменная выбрана дважды",
      nodeCount: 0,
      maxNodes,
    };
  }
  const variables = variableIds.map((id) => byId.get(id)!);
  const nodeCount = variables.reduce(
    (product, variable) => product * domainSize(variable.domain),
    1,
  );
  if (nodeCount > maxNodes) {
    const detail = variables
      .map((variable) => `${variable.id}: ${domainSize(variable.domain)}`)
      .join(" × ");
    return {
      ok: false,
      reason: `Проекция даёт ${nodeCount} узлов (${detail}), предел — ${maxNodes}. Выберите меньше переменных или переменную с меньшей областью.`,
      nodeCount,
      maxNodes,
    };
  }
  const hiddenVariables = model.variables.filter(
    (variable) => !variableIds.includes(variable.id),
  );
  const initialValues = Object.fromEntries(
    variables.map((variable) => [variable.id, variable.initial_value]),
  );
  const initialKey = nodeKey(initialValues, variableIds);

  const nodes: ProjectionNode[] = cartesian(variables).map((values) => {
    const id = nodeKey(values, variableIds);
    return {
      id,
      values,
      label: nodeLabel(values, variables),
      initial: id === initialKey,
      outOfDomain: false,
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));

  const edges: ProjectionEdge[] = [];
  const neverEnabled: string[] = [];
  let needsOutOfDomain = false;

  for (const transition of model.transitions) {
    let enabledSomewhere = false;
    for (const node of nodes) {
      const produced = projectTransition(
        transition,
        node,
        variables,
        variableIds,
      );
      if (produced === null) continue;
      enabledSomewhere = true;
      for (const edge of produced) {
        if (edge.target === OUT_OF_DOMAIN_NODE_ID) needsOutOfDomain = true;
        else if (!nodeIds.has(edge.target)) continue;
        if (edges.length >= 1200)
          return {
            ok: false,
            reason:
              "Проекция содержит больше 1200 стрелок. Откройте таблицу переходов или выберите меньше переменных.",
            nodeCount,
            maxNodes,
          };
        edges.push(edge);
      }
    }
    if (!enabledSomewhere) neverEnabled.push(transition.id);
  }

  if (needsOutOfDomain) {
    nodes.push({
      id: OUT_OF_DOMAIN_NODE_ID,
      values: {},
      label: "Вне области",
      initial: false,
      outOfDomain: true,
    });
  }

  return {
    ok: true,
    projection: {
      variableIds,
      variables,
      hiddenVariables,
      nodes,
      edges,
      neverEnabled,
      maxNodes,
    },
  };
}

function safeSimplify(
  expression: Expression,
  known: Record<string, Value>,
): Expression {
  try {
    return simplify(expression, known);
  } catch {
    return expression;
  }
}

/** Рёбра одного перехода из одного узла; null — guard ложен при значениях узла. */
function projectTransition(
  transition: Transition,
  node: ProjectionNode,
  variables: Variable[],
  variableIds: string[],
): ProjectionEdge[] | null {
  // Модель черновика может содержать ошибки типов; тогда условие считается неизвестным,
  // чтобы граф не потерял ребро, а ошибка показывается проверкой модели.
  const guard = safeSimplify(transition.guard, node.values);
  if (guard.kind === "literal" && guard.value === false) return null;
  const guardResidual =
    guard.kind === "literal" && guard.value === true ? null : guard;

  const effects = new Map(
    transition.effects.map((effect) => [effect.variable, effect.value]),
  );
  const effectResiduals: Record<string, Expression> = {};
  const outOfDomainValues: Record<string, Value> = {};
  const choices: Array<Value[]> = [];
  let determined = true;

  for (const variable of variables) {
    const effect = effects.get(variable.id);
    if (!effect) {
      choices.push([node.values[variable.id]!]);
      continue;
    }
    const value = safeSimplify(effect, node.values);
    if (value.kind === "literal") {
      if (!domainContains(variable.domain, value.value))
        outOfDomainValues[variable.id] = value.value;
      choices.push([value.value]);
    } else {
      determined = false;
      effectResiduals[variable.id] = value;
      choices.push(domainValues(variable.domain));
    }
  }

  const base = {
    transitionId: transition.id,
    source: node.id,
    guardResidual,
    effectResiduals,
    targetDetermined: determined,
    outOfDomainValues,
  };

  if (Object.keys(outOfDomainValues).length > 0) {
    const edge = {
      ...base,
      id: `${transition.id}|${node.id}|${OUT_OF_DOMAIN_NODE_ID}`,
      target: OUT_OF_DOMAIN_NODE_ID,
      selfLoop: false,
    };
    return [{ ...edge, kind: edgeKind(edge) }];
  }

  const targets: Array<Record<string, Value>> = [{}];
  variables.forEach((variable, index) => {
    const next: Array<Record<string, Value>> = [];
    for (const partial of targets.splice(0)) {
      for (const value of choices[index]!)
        next.push({ ...partial, [variable.id]: value });
    }
    targets.push(...next);
  });

  return targets.map((values) => {
    const target = nodeKey(values, variableIds);
    const edge = {
      ...base,
      id: `${transition.id}|${node.id}|${target}`,
      target,
      selfLoop: target === node.id,
    };
    return { ...edge, kind: edgeKind(edge) };
  });
}

/** Узел проекции для полного состояния модели (например, шага трассы). */
export function nodeForState(
  projection: StateProjection,
  state: Record<string, Value>,
): string | null {
  const values: Record<string, Value> = {};
  for (const variable of projection.variables) {
    const value = state[variable.id];
    if (value === undefined) return null;
    if (!domainContains(variable.domain, value)) return OUT_OF_DOMAIN_NODE_ID;
    values[variable.id] = value;
  }
  const key = nodeKey(values, projection.variableIds);
  return projection.nodes.some((node) => node.id === key) ? key : null;
}

export function edgeFor(
  projection: StateProjection,
  transitionId: string,
  source: string,
  target: string,
): ProjectionEdge | null {
  return (
    projection.edges.find(
      (edge) =>
        edge.transitionId === transitionId &&
        edge.source === source &&
        edge.target === target,
    ) ?? null
  );
}
