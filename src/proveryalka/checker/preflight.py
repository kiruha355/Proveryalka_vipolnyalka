import re
from dataclasses import dataclass

from pydantic import ValidationError

from ..behavior.contracts import IntegerDomain
from ..behavior.expressions import BinaryExpression, LiteralExpression, UnaryExpression, VariableExpression
from .tla import INT_MAX, INT_MIN, UnsupportedConstruct, compile_expression, literal


@dataclass(frozen=True)
class ModelIssue:
    path: str
    message: str

    def __str__(self):
        return f"{self.path}: {self.message}" if self.path else self.message


def interval(expression, variables, path, issues):
    """Границы целого выражения по областям переменных; None для boolean/enum."""
    if isinstance(expression, LiteralExpression):
        return (expression.value, expression.value) if type(expression.value) is int else None
    if isinstance(expression, VariableExpression):
        domain = variables[expression.name].domain
        return (domain.minimum, domain.maximum) if isinstance(domain, IntegerDomain) else None
    if isinstance(expression, UnaryExpression):
        operand = interval(expression.operand, variables, f"{path}.operand", issues)
        bounds = (-operand[1], -operand[0]) if expression.op == "neg" and operand else None
    else:
        left = interval(expression.left, variables, f"{path}.left", issues)
        right = interval(expression.right, variables, f"{path}.right", issues)
        if expression.op not in {"add", "sub", "mul"} or not left or not right:
            return None
        if expression.op == "add":
            bounds = (left[0] + right[0], left[1] + right[1])
        elif expression.op == "sub":
            bounds = (left[0] - right[1], left[1] - right[0])
        else:
            products = [a * b for a in left for b in right]
            bounds = (min(products), max(products))
    if bounds and (bounds[0] < INT_MIN or bounds[1] > INT_MAX):
        issues.append(ModelIssue(path, f"значение может выйти за 32-битное целое TLC: [{bounds[0]}, {bounds[1]}]"))
    return bounds


def expressions(model):
    for transition in model.transitions:
        yield f"transitions.{transition.id}.guard", transition.guard
        for index, effect in enumerate(transition.effects):
            yield f"transitions.{transition.id}.effects[{index}].value", effect.value
    for prop in model.properties:
        yield f"properties.{prop.id}.predicate", prop.predicate


def preflight(model):
    """Проверки на стороне ядра, которых нет в общем контракте: ограничения TLC и переводимость в TLA+."""
    issues = []
    variables = {variable.id: variable for variable in model.variables}
    for variable in model.variables:
        path = f"variables.{variable.id}"
        if isinstance(variable.domain, IntegerDomain):
            for field in ("minimum", "maximum"):
                if not INT_MIN <= getattr(variable.domain, field) <= INT_MAX:
                    issues.append(ModelIssue(f"{path}.domain.{field}", "граница не помещается в 32-битное целое TLC"))
        try:
            literal(variable.initial_value, f"{path}.initial_value")
            for index, value in enumerate(getattr(variable.domain, "values", [])):
                literal(value, f"{path}.domain.values[{index}]")
        except UnsupportedConstruct as error:
            issues.append(ModelIssue(error.path, error.reason))
    for path, expression in expressions(model):
        try:
            compile_expression(expression, path)
        except UnsupportedConstruct as error:
            issues.append(ModelIssue(error.path, error.reason))
            continue
        interval(expression, variables, path, issues)
    return issues


UNION_BRANCHES = {
    "BooleanDomain", "IntegerDomain", "EnumDomain",
    "LiteralExpression", "VariableExpression", "UnaryExpression", "BinaryExpression",
}


VALIDATOR_TAG = re.compile(r"^function-\w+\[.*, (\w+)\]$")


def branch(part):
    """Имя варианта объединения в пути Pydantic: 'IntegerDomain' или 'function-after[ordered(), IntegerDomain]'."""
    if not isinstance(part, str):
        return None
    match = VALIDATOR_TAG.match(part)
    name = match.group(1) if match else part
    return name if name in UNION_BRANCHES else None


def describe_validation_error(error: ValidationError):
    """Переводит ошибку Pydantic в список проблем с путями к полям входного JSON.

    Для объединений (domain, выражения) Pydantic сообщает об ошибках всех вариантов;
    оставляем только вариант с подходящим kind, а имя варианта убираем из пути.
    """
    errors = error.errors()
    mismatched = {
        tuple(item["loc"][:-1]) for item in errors
        if item["type"] == "literal_error" and len(item["loc"]) > 1
        and item["loc"][-1] == "kind" and branch(item["loc"][-2])
    }
    issues = []
    for item in errors:
        loc = tuple(item["loc"])
        if any(loc[:len(failed)] == failed for failed in mismatched):
            continue
        path = ".".join(str(part) for part in loc if not branch(part))
        message = item["msg"].removeprefix("Value error, ")
        context = item.get("ctx", {}).get("error")
        inner = getattr(context, "path", None)
        if inner:
            path, message = (f"{path}.{inner}" if path else inner), context.reason
        issues.append(ModelIssue(path, message))
    if not issues:
        for failed in sorted(mismatched, key=str):
            path = ".".join(str(part) for part in failed if not branch(part))
            issues.append(ModelIssue(f"{path}.kind", "неизвестный вид элемента"))
    return list(dict.fromkeys(issues))
