from .contracts import BooleanDomain, EnumDomain, IntegerDomain
from .expressions import LiteralExpression, UnaryExpression, VariableExpression


class ModelPathError(ValueError):
    """Ошибка модели с путём к проблемному полю: variables.<id>.initial_value, transitions.<id>.guard.left."""

    def __init__(self, path, reason):
        super().__init__(f"{path}: {reason}" if path else reason)
        self.path = path
        self.reason = reason


def value_type(value):
    return {bool: "boolean", int: "integer", str: "enum"}[type(value)]


def domain_type(domain):
    return domain.kind if domain is not None else None


def contains(domain, value):
    if isinstance(domain, BooleanDomain):
        return type(value) is bool
    if isinstance(domain, IntegerDomain):
        return type(value) is int and domain.minimum <= value <= domain.maximum
    return type(value) is str and value in domain.values


def expression_type(expression, variables, depth=0, path=""):
    if depth > 32:
        raise ModelPathError(path, "Глубина выражения превышает 32")
    if isinstance(expression, LiteralExpression):
        return value_type(expression.value)
    if isinstance(expression, VariableExpression):
        if expression.name not in variables:
            raise ModelPathError(path, f"Неизвестная переменная: {expression.name}")
        return domain_type(variables[expression.name].domain)
    if isinstance(expression, UnaryExpression):
        expected = "boolean" if expression.op == "not" else "integer"
        require_type(expression_type(expression.operand, variables, depth + 1, f"{path}.operand"), expected, f"{path}.operand")
        return expected
    left = expression_type(expression.left, variables, depth + 1, f"{path}.left")
    right = expression_type(expression.right, variables, depth + 1, f"{path}.right")
    if expression.op in {"and", "or", "implies"}:
        require_type(left, "boolean", f"{path}.left")
        require_type(right, "boolean", f"{path}.right")
        return "boolean"
    if expression.op in {"eq", "ne"}:
        if left is not None and right is not None and left != right:
            raise ModelPathError(path, "Сравнение значений разных типов")
        for variable, literal, side in [(expression.left, expression.right, "right"), (expression.right, expression.left, "left")]:
            if isinstance(variable, VariableExpression) and isinstance(literal, LiteralExpression):
                domain = variables[variable.name].domain
                if isinstance(domain, EnumDomain) and not contains(domain, literal.value):
                    raise ModelPathError(f"{path}.{side}", f"Значение отсутствует в enum переменной {variable.name}")
        return "boolean"
    require_type(left, "integer", f"{path}.left")
    require_type(right, "integer", f"{path}.right")
    return "integer" if expression.op in {"add", "sub", "mul"} else "boolean"


def require_type(actual, expected, path=""):
    if actual is not None and expected is not None and actual != expected:
        raise ModelPathError(path, f"Ожидался тип {expected}, получен {actual}")


def unique(items, label):
    ids = [item.id for item in items]
    for identifier in ids:
        if ids.count(identifier) > 1:
            raise ModelPathError(f"{label}.{identifier}", f"Повторяющийся ID: {label}")


def validate_elements(variables, transitions, properties, requirement_ids):
    for items, label in [(variables, "variables"), (transitions, "transitions"), (properties, "properties")]:
        unique(items, label)
        for item in items:
            if not item.name.strip():
                raise ModelPathError(f"{label}.{item.id}.name", f"Название не должно быть пустым: {item.id}")
            if len(set(item.requirement_ids)) != len(item.requirement_ids) or set(item.requirement_ids) - requirement_ids:
                raise ModelPathError(f"{label}.{item.id}.requirement_ids", f"Недостоверная ссылка на требование: {item.id}")
    known = {item.id: item for item in variables}
    for variable in variables:
        if variable.domain is not None and variable.initial_value is not None and not contains(variable.domain, variable.initial_value):
            raise ModelPathError(f"variables.{variable.id}.initial_value", f"Начальное значение вне области: {variable.id}")
    for transition in transitions:
        path = f"transitions.{transition.id}"
        if transition.guard is not None:
            require_type(expression_type(transition.guard, known, path=f"{path}.guard"), "boolean", f"{path}.guard")
        if transition.effects is None:
            continue
        targets = [effect.variable for effect in transition.effects]
        if len(set(targets)) != len(targets):
            raise ModelPathError(f"{path}.effects", f"Повторное присваивание в переходе: {transition.id}")
        for index, effect in enumerate(transition.effects):
            where = f"{path}.effects[{index}]"
            if effect.variable not in known:
                raise ModelPathError(f"{where}.variable", f"Неизвестная переменная присваивания: {effect.variable}")
            domain = known[effect.variable].domain
            require_type(expression_type(effect.value, known, path=f"{where}.value"), domain_type(domain), f"{where}.value")
            if domain is not None and isinstance(effect.value, LiteralExpression) and not contains(domain, effect.value.value):
                raise ModelPathError(f"{where}.value", f"Присваивание значения вне области: {effect.variable}")
    for prop in properties:
        if prop.predicate is not None:
            path = f"properties.{prop.id}.predicate"
            require_type(expression_type(prop.predicate, known, path=path), "boolean", path)


def validate_model(model):
    unique(model.sources, "sources")
    unique(model.requirements, "requirements")
    sources = {source.id: source for source in model.sources}
    if not model.name.strip() or any(not source.id.strip() or not source.session_id.strip() for source in model.sources):
        raise ModelPathError("sources", "Имя модели, ID источника и сессии должны быть непустыми")
    if len({source.session_id for source in model.sources}) != 1:
        raise ModelPathError("sources", "Источники модели относятся к разным сессиям")
    for requirement in model.requirements:
        if not requirement.id.strip() or not requirement.text.strip():
            raise ModelPathError(f"requirements.{requirement.id}", "ID и текст требования должны быть непустыми")
        for ref in requirement.source_refs:
            source = sources.get(ref.source_id)
            if source is None or not ref.quote.strip() or not 0 <= ref.start < ref.end <= len(source.text) or source.text[ref.start:ref.end] != ref.quote:
                raise ModelPathError(f"requirements.{requirement.id}.source_refs", f"Недостоверная ссылка на источник: {requirement.id}")
    for prop in model.properties:
        if (prop.origin == "proposal") != (prop.approved_by is not None):
            raise ModelPathError(f"properties.{prop.id}.approved_by", f"Предложенное свойство требует подтверждения: {prop.id}")
        if prop.approved_by is not None:
            ref = prop.approved_by
            source = sources.get(ref.source_id)
            if source is None or not ref.quote.strip() or not 0 <= ref.start < ref.end <= len(source.text) or source.text[ref.start:ref.end] != ref.quote:
                raise ModelPathError(f"properties.{prop.id}.approved_by", f"Недостоверное подтверждение свойства: {prop.id}")
    validate_elements(model.variables, model.transitions, model.properties, {item.id for item in model.requirements})
