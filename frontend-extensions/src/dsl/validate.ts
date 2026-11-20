import type {
  BehavioralModel,
  Expression,
  SourceRef,
  Value,
  ValueType,
  Variable,
} from "../contracts/model";
import { IDENTIFIER_PATTERN, MAX_EXPRESSION_DEPTH } from "../contracts/model";
import { domainContains } from "./evaluate";

/**
 * Клиентская предварительная проверка модели перед созданием версии.
 * Повторяет правила backend 62c12b8 (behavior/validation.py и ограничения
 * Pydantic в behavior/contracts.py), но собирает все ошибки, а не первую.
 * Окончательное решение принимает сервер: ответ 422 показывается как есть.
 */
export type ModelIssue = { path: string; message: string };

type Scope = Map<string, Variable>;

function valueType(value: Value): ValueType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "integer";
  return "enum";
}

export function inferExpressionType(
  expression: Expression,
  scope: Scope,
  path: string,
  issues: ModelIssue[],
  depth = 0,
): ValueType | null {
  if (depth > MAX_EXPRESSION_DEPTH) {
    issues.push({
      path,
      message: `Глубина выражения превышает ${MAX_EXPRESSION_DEPTH}`,
    });
    return null;
  }
  switch (expression.kind) {
    case "literal":
      if (
        typeof expression.value === "number" &&
        !Number.isInteger(expression.value)
      ) {
        issues.push({ path, message: "Допустимы только целые числа" });
        return null;
      }
      return valueType(expression.value);
    case "variable": {
      const variable = scope.get(expression.name);
      if (!variable) {
        issues.push({
          path,
          message: `Неизвестная переменная: ${expression.name}`,
        });
        return null;
      }
      return variable.domain.kind;
    }
    case "unary": {
      const expected: ValueType =
        expression.op === "not" ? "boolean" : "integer";
      const actual = inferExpressionType(
        expression.operand,
        scope,
        `${path}.operand`,
        issues,
        depth + 1,
      );
      requireType(actual, expected, `${path}.operand`, issues);
      return expected;
    }
    case "binary": {
      const left = inferExpressionType(
        expression.left,
        scope,
        `${path}.left`,
        issues,
        depth + 1,
      );
      const right = inferExpressionType(
        expression.right,
        scope,
        `${path}.right`,
        issues,
        depth + 1,
      );
      const { op } = expression;
      if (op === "and" || op === "or" || op === "implies") {
        requireType(left, "boolean", `${path}.left`, issues);
        requireType(right, "boolean", `${path}.right`, issues);
        return "boolean";
      }
      if (op === "eq" || op === "ne") {
        if (left !== null && right !== null && left !== right) {
          issues.push({ path, message: "Сравнение значений разных типов" });
        }
        const pairs: Array<[Expression, Expression, string]> = [
          [expression.left, expression.right, "right"],
          [expression.right, expression.left, "left"],
        ];
        for (const [variable, literal, side] of pairs) {
          if (variable.kind === "variable" && literal.kind === "literal") {
            const domain = scope.get(variable.name)?.domain;
            if (
              domain?.kind === "enum" &&
              !domainContains(domain, literal.value)
            ) {
              issues.push({
                path: `${path}.${side}`,
                message: `Значение отсутствует в enum переменной ${variable.name}`,
              });
            }
          }
        }
        return "boolean";
      }
      requireType(left, "integer", `${path}.left`, issues);
      requireType(right, "integer", `${path}.right`, issues);
      return op === "add" || op === "sub" || op === "mul"
        ? "integer"
        : "boolean";
    }
  }
}

function requireType(
  actual: ValueType | null,
  expected: ValueType | null,
  path: string,
  issues: ModelIssue[],
) {
  if (actual !== null && expected !== null && actual !== expected) {
    issues.push({
      path,
      message: `Ожидался тип ${expected}, получен ${actual}`,
    });
  }
}

/**
 * Позиции source_refs на сервере — индексы Python str (кодовые точки).
 * В JS slice работает с UTF-16; для текста вне BMP индексы разойдутся,
 * поэтому сравниваем по массиву кодовых точек.
 */
function codePointSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join("");
}

function checkRefCodePoints(
  ref: SourceRef,
  sources: Map<string, string>,
): boolean {
  const text = sources.get(ref.source_id);
  if (text === undefined) return false;
  const length = Array.from(text).length;
  return (
    ref.quote.trim() !== "" &&
    Number.isInteger(ref.start) &&
    Number.isInteger(ref.end) &&
    0 <= ref.start &&
    ref.start < ref.end &&
    ref.end <= length &&
    codePointSlice(text, ref.start, ref.end) === ref.quote
  );
}

function refIsValid(ref: SourceRef, sources: Map<string, string>): boolean {
  return checkRefCodePoints(ref, sources);
}

export function validateModel(model: BehavioralModel): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const push = (path: string, message: string) =>
    issues.push({ path, message });

  if (model.schema_version !== "1.0")
    push("schema_version", "Поддерживается только schema_version 1.0");
  if (!model.name.trim()) push("name", "Имя модели не должно быть пустым");
  if (model.sources.length === 0)
    push("sources", "Нужен хотя бы один источник");
  if (model.variables.length === 0)
    push("variables", "Нужна хотя бы одна переменная");

  const duplicates = (ids: string[], label: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) push(`${label}.${id}`, `Повторяющийся ID: ${label}`);
      seen.add(id);
    }
  };
  duplicates(
    model.sources.map((source) => source.id),
    "sources",
  );
  duplicates(
    model.requirements.map((requirement) => requirement.id),
    "requirements",
  );
  if (new Set(model.sources.map((source) => source.session_id)).size > 1) {
    push("sources", "Источники модели относятся к разным сессиям");
  }

  const sources = new Map(
    model.sources.map((source) => [source.id, source.text]),
  );
  for (const requirement of model.requirements) {
    if (!requirement.id.trim() || !requirement.text.trim()) {
      push(
        `requirements.${requirement.id}`,
        "ID и текст требования должны быть непустыми",
      );
    }
    if (
      requirement.source_refs.length === 0 ||
      requirement.source_refs.some((ref) => !refIsValid(ref, sources))
    ) {
      push(
        `requirements.${requirement.id}.source_refs`,
        `Недостоверная ссылка на источник: ${requirement.id}`,
      );
    }
  }
  for (const property of model.properties) {
    if ((property.origin === "proposal") !== (property.approved_by !== null)) {
      push(
        `properties.${property.id}.approved_by`,
        `Предложенное свойство требует подтверждения: ${property.id}`,
      );
    }
    if (property.approved_by && !refIsValid(property.approved_by, sources)) {
      push(
        `properties.${property.id}.approved_by`,
        `Недостоверное подтверждение свойства: ${property.id}`,
      );
    }
    if (!property.explanation.trim())
      push(
        `properties.${property.id}.explanation`,
        "Пояснение свойства не должно быть пустым",
      );
  }

  const requirementIds = new Set(
    model.requirements.map((requirement) => requirement.id),
  );
  const groups = [
    ["variables", model.variables],
    ["transitions", model.transitions],
    ["properties", model.properties],
  ] as const;
  for (const [label, items] of groups) {
    duplicates(
      items.map((item) => item.id),
      label,
    );
    for (const item of items) {
      if (!IDENTIFIER_PATTERN.test(item.id))
        push(`${label}.${item.id}.id`, `Недопустимый ID: ${item.id}`);
      if (!item.name.trim())
        push(
          `${label}.${item.id}.name`,
          `Название не должно быть пустым: ${item.id}`,
        );
      const refs = item.requirement_ids;
      if (
        refs.length === 0 ||
        new Set(refs).size !== refs.length ||
        refs.some((id) => !requirementIds.has(id))
      ) {
        push(
          `${label}.${item.id}.requirement_ids`,
          `Недостоверная ссылка на требование: ${item.id}`,
        );
      }
    }
  }

  const scope: Scope = new Map(
    model.variables.map((variable) => [variable.id, variable]),
  );
  for (const variable of model.variables) {
    const { domain } = variable;
    if (domain.kind === "integer") {
      if (
        !Number.isInteger(domain.minimum) ||
        !Number.isInteger(domain.maximum)
      ) {
        push(
          `variables.${variable.id}.domain`,
          "Границы области должны быть целыми",
        );
      } else if (domain.minimum > domain.maximum) {
        push(
          `variables.${variable.id}.domain`,
          "Нижняя граница области больше верхней",
        );
      }
    }
    if (domain.kind === "enum") {
      if (domain.values.length === 0)
        push(
          `variables.${variable.id}.domain`,
          "Область enum не должна быть пустой",
        );
      if (
        new Set(domain.values).size !== domain.values.length ||
        domain.values.some((value) => !value.trim())
      ) {
        push(
          `variables.${variable.id}.domain`,
          "Значения enum должны быть непустыми и различимыми",
        );
      }
    }
    if (!domainContains(domain, variable.initial_value)) {
      push(
        `variables.${variable.id}.initial_value`,
        `Начальное значение вне области: ${variable.id}`,
      );
    }
  }

  for (const transition of model.transitions) {
    const path = `transitions.${transition.id}`;
    const guardType = inferExpressionType(
      transition.guard,
      scope,
      `${path}.guard`,
      issues,
    );
    requireType(guardType, "boolean", `${path}.guard`, issues);
    const targets = transition.effects.map((effect) => effect.variable);
    if (new Set(targets).size !== targets.length)
      push(
        `${path}.effects`,
        `Повторное присваивание в переходе: ${transition.id}`,
      );
    transition.effects.forEach((effect, index) => {
      const where = `${path}.effects[${index}]`;
      const variable = scope.get(effect.variable);
      if (!variable) {
        push(
          `${where}.variable`,
          `Неизвестная переменная присваивания: ${effect.variable}`,
        );
        inferExpressionType(effect.value, scope, `${where}.value`, issues);
        return;
      }
      const actual = inferExpressionType(
        effect.value,
        scope,
        `${where}.value`,
        issues,
      );
      requireType(actual, variable.domain.kind, `${where}.value`, issues);
      if (
        effect.value.kind === "literal" &&
        !domainContains(variable.domain, effect.value.value)
      ) {
        push(
          `${where}.value`,
          `Присваивание значения вне области: ${effect.variable}`,
        );
      }
    });
  }

  for (const property of model.properties) {
    const path = `properties.${property.id}.predicate`;
    requireType(
      inferExpressionType(property.predicate, scope, path, issues),
      "boolean",
      path,
      issues,
    );
  }
  return issues;
}
