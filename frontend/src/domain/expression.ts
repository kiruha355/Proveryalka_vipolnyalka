import type { BinaryOp, Domain, Expression, Value } from "../api/types";

const PRECEDENCE: Record<BinaryOp, number> = {
  implies: 1, or: 2, and: 3,
  eq: 4, ne: 4, lt: 4, le: 4, gt: 4, ge: 4,
  add: 5, sub: 5, mul: 6,
};

const SYMBOL: Record<BinaryOp, string> = {
  implies: "⇒", or: "или", and: "и",
  eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥",
  add: "+", sub: "−", mul: "×",
};

export function formatValue(value: Value | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Readable infix form; parentheses only where precedence requires them. */
export function formatExpression(expression: Expression | null | undefined, parent = 0): string {
  if (!expression) return "—";
  switch (expression.kind) {
    case "literal":
      return formatValue(expression.value);
    case "variable":
      return expression.name;
    case "unary": {
      const inner = formatExpression(expression.operand, 7);
      return expression.op === "not" ? `не ${inner}` : `−${inner}`;
    }
    case "binary": {
      const own = PRECEDENCE[expression.op];
      // Comparisons and implication are not associative: parenthesize equal-precedence children.
      const strict = own === 4 || expression.op === "implies" || expression.op === "sub";
      const left = formatExpression(expression.left, own);
      const right = formatExpression(expression.right, strict ? own + 1 : own);
      const text = `${left} ${SYMBOL[expression.op]} ${right}`;
      return own < parent ? `(${text})` : text;
    }
  }
}

export function formatDomain(domain: Domain): string {
  switch (domain.kind) {
    case "boolean":
      return "true / false";
    case "integer":
      return `${domain.minimum}…${domain.maximum}`;
    case "enum":
      return domain.values.join(", ");
  }
}

export function domainKindLabel(domain: Domain): string {
  return domain.kind === "boolean" ? "логическая" : domain.kind === "integer" ? "целое" : "перечисление";
}

export function variablesOf(expression: Expression | null | undefined, into = new Set<string>()): Set<string> {
  if (!expression) return into;
  if (expression.kind === "variable") into.add(expression.name);
  else if (expression.kind === "unary") variablesOf(expression.operand, into);
  else if (expression.kind === "binary") {
    variablesOf(expression.left, into);
    variablesOf(expression.right, into);
  }
  return into;
}

export class EvaluationError extends Error {}

/** Same semantics as proveryalka.behavior.runtime.evaluate. */
export function evaluate(expression: Expression, state: Record<string, Value>): Value {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "variable": {
      if (!(expression.name in state)) throw new EvaluationError(`Нет значения переменной ${expression.name}`);
      return state[expression.name] as Value;
    }
    case "unary": {
      const value = evaluate(expression.operand, state);
      return expression.op === "not" ? !value : -(value as number);
    }
    case "binary": {
      const a = evaluate(expression.left, state);
      const b = evaluate(expression.right, state);
      switch (expression.op) {
        case "and": return Boolean(a) && Boolean(b);
        case "or": return Boolean(a) || Boolean(b);
        case "implies": return !a || Boolean(b);
        case "eq": return a === b;
        case "ne": return a !== b;
        case "lt": return (a as number) < (b as number);
        case "le": return (a as number) <= (b as number);
        case "gt": return (a as number) > (b as number);
        case "ge": return (a as number) >= (b as number);
        case "add": return (a as number) + (b as number);
        case "sub": return (a as number) - (b as number);
        case "mul": return (a as number) * (b as number);
      }
    }
  }
}

export function tryEvaluate(expression: Expression, state: Record<string, Value>): Value | undefined {
  try {
    return evaluate(expression, state);
  } catch {
    return undefined;
  }
}
