import type { Domain, Expression, Value } from "../contracts/model";

export type State = Record<string, Value>;

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationError";
  }
}

function literal(value: Value): Expression {
  return { kind: "literal", value };
}

function isLiteral(
  expression: Expression,
): expression is { kind: "literal"; value: Value } {
  return expression.kind === "literal";
}

function asBoolean(value: Value, where: string): boolean {
  if (typeof value !== "boolean")
    throw new EvaluationError(
      `${where}: ожидалось boolean, получено ${JSON.stringify(value)}`,
    );
  return value;
}

function asInteger(value: Value, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EvaluationError(
      `${where}: ожидалось целое, получено ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Частичное вычисление: подставляет известные значения и упрощает выражение
 * по трёхзначной логике. Если результат — литерал, значение определено
 * независимо от неизвестных переменных; иначе возвращается остаток условия.
 * Все операции DSL тотальны (нет деления), поэтому упрощение `false and x`
 * до `false` корректно для любого x.
 */
export function simplify(
  expression: Expression,
  known: Partial<State>,
): Expression {
  switch (expression.kind) {
    case "literal":
      return expression;
    case "variable": {
      const value = known[expression.name];
      return value === undefined ? expression : literal(value);
    }
    case "unary": {
      const operand = simplify(expression.operand, known);
      if (isLiteral(operand)) {
        return expression.op === "not"
          ? literal(!asBoolean(operand.value, "not"))
          : literal(-asInteger(operand.value, "neg"));
      }
      return { kind: "unary", op: expression.op, operand };
    }
    case "binary": {
      const left = simplify(expression.left, known);
      const right = simplify(expression.right, known);
      const op = expression.op;
      if (op === "and") {
        if (
          (isLiteral(left) && left.value === false) ||
          (isLiteral(right) && right.value === false)
        )
          return literal(false);
        if (isLiteral(left) && left.value === true) return right;
        if (isLiteral(right) && right.value === true) return left;
        return { kind: "binary", op, left, right };
      }
      if (op === "or") {
        if (
          (isLiteral(left) && left.value === true) ||
          (isLiteral(right) && right.value === true)
        )
          return literal(true);
        if (isLiteral(left) && left.value === false) return right;
        if (isLiteral(right) && right.value === false) return left;
        return { kind: "binary", op, left, right };
      }
      if (op === "implies") {
        if (
          (isLiteral(left) && left.value === false) ||
          (isLiteral(right) && right.value === true)
        )
          return literal(true);
        if (isLiteral(left) && left.value === true) return right;
        if (isLiteral(right) && right.value === false)
          return simplify({ kind: "unary", op: "not", operand: left }, {});
        return { kind: "binary", op, left, right };
      }
      if (!isLiteral(left) || !isLiteral(right))
        return { kind: "binary", op, left, right };
      const a = left.value;
      const b = right.value;
      switch (op) {
        case "eq":
          return literal(a === b);
        case "ne":
          return literal(a !== b);
        case "lt":
          return literal(asInteger(a, "<") < asInteger(b, "<"));
        case "le":
          return literal(asInteger(a, "<=") <= asInteger(b, "<="));
        case "gt":
          return literal(asInteger(a, ">") > asInteger(b, ">"));
        case "ge":
          return literal(asInteger(a, ">=") >= asInteger(b, ">="));
        case "add":
          return literal(asInteger(a, "+") + asInteger(b, "+"));
        case "sub":
          return literal(asInteger(a, "-") - asInteger(b, "-"));
        case "mul":
          return literal(asInteger(a, "*") * asInteger(b, "*"));
      }
    }
  }
}

/** Значение выражения в полностью известном состоянии. */
export function evaluate(expression: Expression, state: State): Value {
  const result = simplify(expression, state);
  if (!isLiteral(result)) {
    const missing =
      result.kind === "variable" ? result.name : "переменные выражения";
    throw new EvaluationError(`В состоянии нет значения: ${missing}`);
  }
  return result.value;
}

export function domainContains(domain: Domain, value: Value): boolean {
  if (domain.kind === "boolean") return typeof value === "boolean";
  if (domain.kind === "integer") {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= domain.minimum &&
      value <= domain.maximum
    );
  }
  return typeof value === "string" && domain.values.includes(value);
}

/** Все значения конечной области по порядку. Для integer — от minimum до maximum. */
export function domainValues(domain: Domain): Value[] {
  if (domain.kind === "boolean") return [false, true];
  if (domain.kind === "enum") return [...domain.values];
  const values: number[] = [];
  for (let value = domain.minimum; value <= domain.maximum; value += 1)
    values.push(value);
  return values;
}

export function domainSize(domain: Domain): number {
  if (domain.kind === "boolean") return 2;
  if (domain.kind === "enum") return domain.values.length;
  return domain.maximum - domain.minimum + 1;
}
