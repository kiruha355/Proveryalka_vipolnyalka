import type { BinaryOp, Expression, Value } from "../contracts/model";
import { IDENTIFIER_PATTERN, MAX_EXPRESSION_DEPTH } from "../contracts/model";

/**
 * Текстовая запись выражений DSL для чтения и редактирования guards/effects.
 *
 * Запись однозначно отображается в JSON-дерево Expression и обратно:
 * parseExpression(formatExpression(e)) структурно равно e. Скобки ставятся
 * только там, где без них изменилось бы дерево, поэтому вложенность
 * `a and (b and c)` сохраняется как есть, а не перестраивается.
 *
 *   implies (=>), or, and, not, == != < <= > >=, + -, *, унарный -
 *   true / false, целые числа, "строки" в JSON-кавычках, имена переменных.
 *   Имя, совпадающее с ключевым словом, пишется в обратных кавычках: `and`.
 */

const KEYWORDS = new Set(["and", "or", "not", "implies", "true", "false"]);

const BINARY_TEXT: Record<BinaryOp, string> = {
  implies: "=>",
  or: "or",
  and: "and",
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
  add: "+",
  sub: "-",
  mul: "*",
};

// Чем больше число, тем сильнее связывает оператор.
const PRECEDENCE: Record<BinaryOp, number> = {
  implies: 1,
  or: 2,
  and: 3,
  eq: 5,
  ne: 5,
  lt: 5,
  le: 5,
  gt: 5,
  ge: 5,
  add: 6,
  sub: 6,
  mul: 7,
};
const NOT_PRECEDENCE = 4;
const NEG_PRECEDENCE = 8;
const ATOM_PRECEDENCE = 9;

function precedenceOf(expression: Expression): number {
  if (expression.kind === "binary") return PRECEDENCE[expression.op];
  if (expression.kind === "unary")
    return expression.op === "not" ? NOT_PRECEDENCE : NEG_PRECEDENCE;
  if (
    expression.kind === "literal" &&
    typeof expression.value === "number" &&
    expression.value < 0
  ) {
    return NEG_PRECEDENCE;
  }
  return ATOM_PRECEDENCE;
}

export function formatValue(value: Value): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function formatIdentifier(name: string): string {
  return KEYWORDS.has(name) ? `\`${name}\`` : name;
}

export function formatExpression(expression: Expression): string {
  switch (expression.kind) {
    case "literal":
      return formatValue(expression.value);
    case "variable":
      return formatIdentifier(expression.name);
    case "unary": {
      const own = precedenceOf(expression);
      const inner = formatExpression(expression.operand);
      // Операнд со слабой связью, вложенный «-» и числовой литерал берём в скобки:
      // иначе `-(-x)` станет `--x`, а neg(5) прочитается обратно как литерал -5.
      const ambiguousNegation =
        expression.op === "neg" &&
        (precedenceOf(expression.operand) === NEG_PRECEDENCE ||
          (expression.operand.kind === "literal" &&
            typeof expression.operand.value === "number"));
      const wrapped =
        precedenceOf(expression.operand) < own || ambiguousNegation
          ? `(${inner})`
          : inner;
      return expression.op === "not" ? `not ${wrapped}` : `-${wrapped}`;
    }
    case "binary": {
      const own = PRECEDENCE[expression.op];
      const comparison = own === 5;
      const rightAssociative = expression.op === "implies";
      const leftPrecedence = precedenceOf(expression.left);
      const rightPrecedence = precedenceOf(expression.right);
      const wrapLeft =
        leftPrecedence < own ||
        (leftPrecedence === own && (rightAssociative || comparison));
      const wrapRight =
        rightPrecedence < own ||
        (rightPrecedence === own && (!rightAssociative || comparison));
      const left = formatExpression(expression.left);
      const right = formatExpression(expression.right);
      return `${wrapLeft ? `(${left})` : left} ${BINARY_TEXT[expression.op]} ${wrapRight ? `(${right})` : right}`;
    }
  }
}

export class ExpressionSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = "ExpressionSyntaxError";
    this.offset = offset;
  }
}

type Token =
  | { type: "number"; value: number; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | {
      type: "identifier";
      value: string;
      quoted: boolean;
      start: number;
      end: number;
    }
  | { type: "operator"; value: string; start: number; end: number }
  | { type: "end"; start: number; end: number };

const OPERATORS = [
  "=>",
  "->",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "+",
  "-",
  "*",
  "(",
  ")",
  "!",
  "=",
];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const start = index;
    if (/[0-9]/.test(char)) {
      while (index < text.length && /[0-9]/.test(text[index]!)) index += 1;
      if (index < text.length && /[A-Za-z_.]/.test(text[index]!)) {
        throw new ExpressionSyntaxError("Допустимы только целые числа", start);
      }
      const value = Number(text.slice(start, index));
      if (!Number.isSafeInteger(value))
        throw new ExpressionSyntaxError("Слишком большое число", start);
      tokens.push({ type: "number", value, start, end: index });
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      if (index >= text.length)
        throw new ExpressionSyntaxError("Строка не закрыта кавычкой", start);
      index += 1;
      let value: unknown;
      try {
        value = JSON.parse(text.slice(start, index));
      } catch {
        throw new ExpressionSyntaxError(
          "Неверная escape-последовательность в строке",
          start,
        );
      }
      tokens.push({
        type: "string",
        value: value as string,
        start,
        end: index,
      });
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0)
        throw new ExpressionSyntaxError(
          "Имя не закрыто обратной кавычкой",
          start,
        );
      const name = text.slice(index + 1, close);
      if (!IDENTIFIER_PATTERN.test(name))
        throw new ExpressionSyntaxError(`Недопустимое имя: ${name}`, start);
      index = close + 1;
      tokens.push({
        type: "identifier",
        value: name,
        quoted: true,
        start,
        end: index,
      });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index]!))
        index += 1;
      tokens.push({
        type: "identifier",
        value: text.slice(start, index),
        quoted: false,
        start,
        end: index,
      });
      continue;
    }
    const operator = OPERATORS.find((candidate) =>
      text.startsWith(candidate, index),
    );
    if (!operator)
      throw new ExpressionSyntaxError(`Неожиданный символ «${char}»`, start);
    if (operator === "=")
      throw new ExpressionSyntaxError("Для сравнения используйте ==", start);
    index += operator.length;
    tokens.push({ type: "operator", value: operator, start, end: index });
  }
  tokens.push({ type: "end", start: text.length, end: text.length });
  return tokens;
}

const COMPARISON: Record<string, BinaryOp> = {
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
};

/** Разбирает текстовую запись в Expression. Ошибка содержит позицию в строке. */
export function parseExpression(text: string): Expression {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position]!;
  const next = () => tokens[position++]!;
  const isWord = (token: Token, word: string) =>
    token.type === "identifier" && !token.quoted && token.value === word;
  const isOperator = (token: Token, ...values: string[]) =>
    token.type === "operator" && values.includes(token.value);

  function guardDepth(depth: number, token: Token) {
    if (depth > MAX_EXPRESSION_DEPTH) {
      throw new ExpressionSyntaxError(
        `Глубина выражения превышает ${MAX_EXPRESSION_DEPTH}`,
        token.start,
      );
    }
  }

  function parseImplies(depth: number): Expression {
    guardDepth(depth, peek());
    const left = parseOr(depth);
    const token = peek();
    if (isWord(token, "implies") || isOperator(token, "=>", "->")) {
      next();
      return {
        kind: "binary",
        op: "implies",
        left,
        right: parseImplies(depth + 1),
      };
    }
    return left;
  }

  function parseOr(depth: number): Expression {
    let left = parseAnd(depth);
    while (isWord(peek(), "or") || isOperator(peek(), "||")) {
      next();
      left = { kind: "binary", op: "or", left, right: parseAnd(depth + 1) };
    }
    return left;
  }

  function parseAnd(depth: number): Expression {
    let left = parseNot(depth);
    while (isWord(peek(), "and") || isOperator(peek(), "&&")) {
      next();
      left = { kind: "binary", op: "and", left, right: parseNot(depth + 1) };
    }
    return left;
  }

  function parseNot(depth: number): Expression {
    guardDepth(depth, peek());
    if (isWord(peek(), "not") || isOperator(peek(), "!")) {
      next();
      return { kind: "unary", op: "not", operand: parseNot(depth + 1) };
    }
    return parseComparison(depth);
  }

  function parseComparison(depth: number): Expression {
    const left = parseAdditive(depth);
    const token = peek();
    if (token.type === "operator" && token.value in COMPARISON) {
      next();
      const right = parseAdditive(depth + 1);
      const after = peek();
      if (after.type === "operator" && after.value in COMPARISON) {
        throw new ExpressionSyntaxError(
          "Цепочку сравнений нужно разделить скобками",
          after.start,
        );
      }
      return { kind: "binary", op: COMPARISON[token.value]!, left, right };
    }
    return left;
  }

  function parseAdditive(depth: number): Expression {
    let left = parseMultiplicative(depth);
    while (isOperator(peek(), "+", "-")) {
      const op: BinaryOp =
        (next() as { value: string }).value === "+" ? "add" : "sub";
      left = {
        kind: "binary",
        op,
        left,
        right: parseMultiplicative(depth + 1),
      };
    }
    return left;
  }

  function parseMultiplicative(depth: number): Expression {
    let left = parseUnary(depth);
    while (isOperator(peek(), "*")) {
      next();
      left = { kind: "binary", op: "mul", left, right: parseUnary(depth + 1) };
    }
    return left;
  }

  function parseUnary(depth: number): Expression {
    guardDepth(depth, peek());
    const token = peek();
    if (isOperator(token, "-")) {
      next();
      const after = peek();
      // `-5` — литерал, как его хранит сервер; `-(5)` и `-x` — унарный neg.
      if (after.type === "number") {
        next();
        return { kind: "literal", value: -after.value };
      }
      return { kind: "unary", op: "neg", operand: parseUnary(depth + 1) };
    }
    return parsePrimary(depth);
  }

  function parsePrimary(depth: number): Expression {
    const token = next();
    if (token.type === "number") return { kind: "literal", value: token.value };
    if (token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "identifier") {
      if (!token.quoted) {
        if (token.value === "true") return { kind: "literal", value: true };
        if (token.value === "false") return { kind: "literal", value: false };
        if (KEYWORDS.has(token.value)) {
          throw new ExpressionSyntaxError(
            `Ожидалось значение, найдено «${token.value}»`,
            token.start,
          );
        }
      }
      if (!IDENTIFIER_PATTERN.test(token.value)) {
        throw new ExpressionSyntaxError(
          `Недопустимое имя переменной: ${token.value}`,
          token.start,
        );
      }
      return { kind: "variable", name: token.value };
    }
    if (isOperator(token, "(")) {
      const inner = parseImplies(depth + 1);
      const close = next();
      if (!isOperator(close, ")"))
        throw new ExpressionSyntaxError(
          "Ожидалась закрывающая скобка",
          close.start,
        );
      return inner;
    }
    if (token.type === "end")
      throw new ExpressionSyntaxError("Выражение не закончено", token.start);
    throw new ExpressionSyntaxError(
      `Неожиданный элемент «${text.slice(token.start, token.end)}»`,
      token.start,
    );
  }

  if (peek().type === "end")
    throw new ExpressionSyntaxError("Пустое выражение", 0);
  const expression = parseImplies(0);
  const rest = peek();
  if (rest.type !== "end") {
    throw new ExpressionSyntaxError(
      `Лишний текст после выражения: «${text.slice(rest.start, rest.end)}»`,
      rest.start,
    );
  }
  return expression;
}

export function expressionDepth(expression: Expression): number {
  if (expression.kind === "unary")
    return 1 + expressionDepth(expression.operand);
  if (expression.kind === "binary")
    return (
      1 +
      Math.max(
        expressionDepth(expression.left),
        expressionDepth(expression.right),
      )
    );
  return 0;
}

export function expressionVariables(
  expression: Expression,
  into = new Set<string>(),
): Set<string> {
  if (expression.kind === "variable") into.add(expression.name);
  else if (expression.kind === "unary")
    expressionVariables(expression.operand, into);
  else if (expression.kind === "binary") {
    expressionVariables(expression.left, into);
    expressionVariables(expression.right, into);
  }
  return into;
}

export function expressionsEqual(a: Expression, b: Expression): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "literal":
      return (
        b.kind === "literal" &&
        typeof a.value === typeof b.value &&
        a.value === b.value
      );
    case "variable":
      return b.kind === "variable" && a.name === b.name;
    case "unary":
      return (
        b.kind === "unary" &&
        a.op === b.op &&
        expressionsEqual(a.operand, b.operand)
      );
    case "binary":
      return (
        b.kind === "binary" &&
        a.op === b.op &&
        expressionsEqual(a.left, b.left) &&
        expressionsEqual(a.right, b.right)
      );
  }
}
