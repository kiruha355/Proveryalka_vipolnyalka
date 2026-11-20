import { describe, expect, it } from "vitest";
import type { Expression } from "../contracts/model";
import {
  ORDER_BUG_SPEC,
  ORDER_FIXED_SPEC,
  TLC_ORDER_BUG_RESULT,
  TLC_ORDER_FIXED_RESULT,
} from "../fixtures/order-versions";
import { TICKETS_SPEC } from "../fixtures/tickets";
import { evaluate, simplify } from "./evaluate";
import {
  expressionsEqual,
  ExpressionSyntaxError,
  formatExpression,
  parseExpression,
} from "./expression-text";
import { computeSpecHash } from "./spec-hash";
import { validateModel } from "./validate";

const v = (name: string): Expression => ({ kind: "variable", name });
const lit = (value: boolean | number | string): Expression => ({
  kind: "literal",
  value,
});
const bin = (
  op: Extract<Expression, { kind: "binary" }>["op"],
  left: Expression,
  right: Expression,
): Expression => ({ kind: "binary", op, left, right });

function randomExpression(random: () => number, depth: number): Expression {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  if (depth === 0 || random() < 0.25) {
    return pick<Expression>([
      v("status"),
      v("approved"),
      v("n"),
      v("and"),
      v("true"),
      lit(true),
      lit(false),
      lit(0),
      lit(7),
      lit(-3),
      lit("Created"),
      lit('с "кавычкой"\n'),
    ]);
  }
  if (random() < 0.2)
    return {
      kind: "unary",
      op: pick(["not", "neg"] as const),
      operand: randomExpression(random, depth - 1),
    };
  const op = pick([
    "and",
    "or",
    "implies",
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "add",
    "sub",
    "mul",
  ] as const);
  return bin(
    op,
    randomExpression(random, depth - 1),
    randomExpression(random, depth - 1),
  );
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("текстовая запись выражений", () => {
  it("печатает guards из модели заявки", () => {
    expect(formatExpression(ORDER_BUG_SPEC.transitions[1]!.guard)).toBe(
      'status == "Created" or status == "Approved"',
    );
    expect(formatExpression(ORDER_BUG_SPEC.transitions[2]!.guard)).toBe(
      "approved == true",
    );
  });

  it("сохраняет дерево при печати и разборе (5000 случайных выражений)", () => {
    const random = seeded(40);
    for (let index = 0; index < 5000; index += 1) {
      const expression = randomExpression(random, 5);
      const text = formatExpression(expression);
      const parsed = parseExpression(text);
      expect(expressionsEqual(parsed, expression), text).toBe(true);
    }
  });

  it("различает скобки, задающие структуру", () => {
    expect(
      formatExpression(bin("and", v("a"), bin("and", v("b"), v("c")))),
    ).toBe("a and (b and c)");
    expect(
      formatExpression(bin("sub", v("a"), bin("sub", v("b"), v("c")))),
    ).toBe("a - (b - c)");
    expect(
      formatExpression(bin("implies", v("a"), bin("implies", v("b"), v("c")))),
    ).toBe("a => b => c");
    expect(
      formatExpression({ kind: "unary", op: "neg", operand: lit(5) }),
    ).toBe("-(5)");
    expect(parseExpression("-5")).toEqual(lit(-5));
  });

  it("принимает привычные синонимы операторов", () => {
    expect(parseExpression("!a && b || c -> d")).toEqual(
      bin(
        "implies",
        bin(
          "or",
          bin("and", { kind: "unary", op: "not", operand: v("a") }, v("b")),
          v("c"),
        ),
        v("d"),
      ),
    );
  });

  it("сообщает позицию синтаксической ошибки", () => {
    const attempt = (text: string) => {
      try {
        parseExpression(text);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionSyntaxError);
        return (error as ExpressionSyntaxError).offset;
      }
    };
    expect(attempt('status = "Created"')).toBe(7);
    expect(attempt("a < b < c")).toBe(6);
    expect(attempt("(a and b")).toBe(8);
    expect(attempt("1.5 + x")).toBe(0);
    expect(attempt('"не закрыта')).toBe(0);
    expect(attempt("")).toBe(0);
    expect(attempt("_hidden")).toBe(0);
  });
});

describe("вычисление", () => {
  it("частично вычисляет guard по известной части состояния", () => {
    const guard = ORDER_BUG_SPEC.transitions[2]!.guard; // approved == true
    expect(simplify(guard, { status: "Cancelled" })).toEqual(guard);
    expect(simplify(guard, { approved: false })).toEqual(lit(false));
    const cancel = ORDER_BUG_SPEC.transitions[1]!.guard;
    expect(simplify(cancel, { status: "Approved" })).toEqual(lit(true));
    expect(simplify(cancel, { status: "Executed" })).toEqual(lit(false));
  });

  it("по трёхзначной логике отбрасывает неизвестное там, где результат уже определён", () => {
    expect(simplify(bin("and", v("x"), lit(false)), {})).toEqual(lit(false));
    expect(simplify(bin("or", v("x"), lit(true)), {})).toEqual(lit(true));
    expect(simplify(bin("implies", lit(false), v("x")), {})).toEqual(lit(true));
    expect(simplify(bin("implies", v("x"), lit(false)), {})).toEqual({
      kind: "unary",
      op: "not",
      operand: v("x"),
    });
  });

  it("вычисляет арифметику ограниченных целых", () => {
    const sell = TICKETS_SPEC.transitions[1]!.effects[0]!.value; // sold + 2
    expect(evaluate(sell, { sold: 1 })).toBe(3);
  });
});

describe("проверка модели", () => {
  it("принимает эталонные модели backend", () => {
    expect(validateModel(ORDER_BUG_SPEC)).toEqual([]);
    expect(validateModel(ORDER_FIXED_SPEC)).toEqual([]);
    expect(validateModel(TICKETS_SPEC)).toEqual([]);
  });

  it("находит ошибки с путями, как сервер", () => {
    const broken = structuredClone(ORDER_BUG_SPEC);
    broken.transitions[2]!.guard = bin("eq", v("status"), lit("Archived"));
    broken.transitions[2]!.effects.push({
      variable: "status",
      value: lit("Created"),
    });
    broken.transitions[0]!.effects[1] = { variable: "approved", value: lit(1) };
    broken.transitions[1]!.requirement_ids = [];
    const paths = validateModel(broken).map((issue) => issue.path);
    expect(paths).toContain("transitions.Execute.guard.right");
    expect(paths).toContain("transitions.Execute.effects");
    expect(paths).toContain("transitions.Approve.effects[1].value");
    expect(paths).toContain("transitions.Cancel.requirement_ids");
  });
});

describe("spec_hash", () => {
  it("совпадает с хешем, который вернул реальный TLC-прогон сервера", () => {
    expect(computeSpecHash(ORDER_BUG_SPEC)).toBe(
      TLC_ORDER_BUG_RESULT.spec_hash,
    );
    expect(computeSpecHash(ORDER_FIXED_SPEC)).toBe(
      TLC_ORDER_FIXED_RESULT.spec_hash,
    );
  });
});
