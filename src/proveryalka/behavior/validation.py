from .contracts import BooleanDomain, EnumDomain, IntegerDomain
from .expressions import LiteralExpression, UnaryExpression, VariableExpression


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


def expression_type(expression, variables, depth=0):
    if depth > 32:
        raise ValueError("Глубина выражения превышает 32")
    if isinstance(expression, LiteralExpression):
        return value_type(expression.value)
    if isinstance(expression, VariableExpression):
        if expression.name not in variables:
            raise ValueError(f"Неизвестная переменная: {expression.name}")
        return domain_type(variables[expression.name].domain)
    if isinstance(expression, UnaryExpression):
        expected = "boolean" if expression.op == "not" else "integer"
        require_type(expression_type(expression.operand, variables, depth + 1), expected)
        return expected
    left = expression_type(expression.left, variables, depth + 1)
    right = expression_type(expression.right, variables, depth + 1)
    if expression.op in {"and", "or", "implies"}:
        require_type(left, "boolean")
        require_type(right, "boolean")
        return "boolean"
    if expression.op in {"eq", "ne"}:
        if left is not None and right is not None and left != right:
            raise ValueError("Сравнение значений разных типов")
        for variable, literal in [(expression.left, expression.right), (expression.right, expression.left)]:
            if isinstance(variable, VariableExpression) and isinstance(literal, LiteralExpression):
                domain = variables[variable.name].domain
                if isinstance(domain, EnumDomain) and not contains(domain, literal.value):
                    raise ValueError(f"Значение отсутствует в enum переменной {variable.name}")
        return "boolean"
    require_type(left, "integer")
    require_type(right, "integer")
    return "integer" if expression.op in {"add", "sub", "mul"} else "boolean"


def require_type(actual, expected):
    if actual is not None and expected is not None and actual != expected:
        raise ValueError(f"Ожидался тип {expected}, получен {actual}")


def unique(items, label):
    ids = [item.id for item in items]
    if len(set(ids)) != len(ids):
        raise ValueError(f"Повторяющийся ID: {label}")


def validate_elements(variables, transitions, properties, requirement_ids):
    for items, label in [(variables, "variables"), (transitions, "transitions"), (properties, "properties")]:
        unique(items, label)
        for item in items:
            if not item.name.strip():
                raise ValueError(f"Название не должно быть пустым: {item.id}")
            if len(set(item.requirement_ids)) != len(item.requirement_ids) or set(item.requirement_ids) - requirement_ids:
                raise ValueError(f"Недостоверная ссылка на требование: {item.id}")
    known = {item.id: item for item in variables}
    for variable in variables:
        if variable.domain is not None and variable.initial_value is not None and not contains(variable.domain, variable.initial_value):
            raise ValueError(f"Начальное значение вне области: {variable.id}")
    for transition in transitions:
        if transition.guard is not None:
            require_type(expression_type(transition.guard, known), "boolean")
        if transition.effects is None:
            continue
        targets = [effect.variable for effect in transition.effects]
        if len(set(targets)) != len(targets):
            raise ValueError(f"Повторное присваивание в переходе: {transition.id}")
        for effect in transition.effects:
            if effect.variable not in known:
                raise ValueError(f"Неизвестная переменная присваивания: {effect.variable}")
            domain = known[effect.variable].domain
            require_type(expression_type(effect.value, known), domain_type(domain))
            if domain is not None and isinstance(effect.value, LiteralExpression) and not contains(domain, effect.value.value):
                raise ValueError(f"Присваивание значения вне области: {effect.variable}")
    for prop in properties:
        if prop.predicate is not None:
            require_type(expression_type(prop.predicate, known), "boolean")


def validate_model(model):
    unique(model.sources, "sources")
    unique(model.requirements, "requirements")
    sources = {source.id: source for source in model.sources}
    if not model.name.strip() or any(not source.id.strip() or not source.session_id.strip() for source in model.sources):
        raise ValueError("Имя модели, ID источника и сессии должны быть непустыми")
    if len({source.session_id for source in model.sources}) != 1:
        raise ValueError("Источники модели относятся к разным сессиям")
    for requirement in model.requirements:
        if not requirement.id.strip() or not requirement.text.strip():
            raise ValueError("ID и текст требования должны быть непустыми")
        for ref in requirement.source_refs:
            source = sources.get(ref.source_id)
            if source is None or not ref.quote.strip() or not 0 <= ref.start < ref.end <= len(source.text) or source.text[ref.start:ref.end] != ref.quote:
                raise ValueError(f"Недостоверная ссылка на источник: {requirement.id}")
    for prop in model.properties:
        if (prop.origin == "proposal") != (prop.approved_by is not None):
            raise ValueError(f"Предложенное свойство требует подтверждения: {prop.id}")
        if prop.approved_by is not None:
            ref = prop.approved_by
            source = sources.get(ref.source_id)
            if source is None or not ref.quote.strip() or not 0 <= ref.start < ref.end <= len(source.text) or source.text[ref.start:ref.end] != ref.quote:
                raise ValueError(f"Недостоверное подтверждение свойства: {prop.id}")
    validate_elements(model.variables, model.transitions, model.properties, {item.id for item in model.requirements})
