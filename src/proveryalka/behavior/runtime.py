import operator

from .expressions import LiteralExpression, UnaryExpression, VariableExpression
from .validation import contains


OPERATIONS = {
    "and": operator.and_, "or": operator.or_, "implies": lambda a, b: not a or b,
    "eq": operator.eq, "ne": operator.ne, "lt": operator.lt, "le": operator.le,
    "gt": operator.gt, "ge": operator.ge, "add": operator.add,
    "sub": operator.sub, "mul": operator.mul,
}


def evaluate(expression, state):
    if isinstance(expression, LiteralExpression):
        return expression.value
    if isinstance(expression, VariableExpression):
        return state[expression.name]
    if isinstance(expression, UnaryExpression):
        value = evaluate(expression.operand, state)
        return not value if expression.op == "not" else -value
    return OPERATIONS[expression.op](evaluate(expression.left, state), evaluate(expression.right, state))


def validate_state(model, state):
    if set(state) != {variable.id for variable in model.variables}:
        raise ValueError("Состояние должно содержать все переменные модели")
    for variable in model.variables:
        if not contains(variable.domain, state[variable.id]):
            raise ValueError(f"Значение вне области: {variable.id}")


def initial_state(model):
    return {variable.id: variable.initial_value for variable in model.variables}


def step(model, state, transition_id):
    validate_state(model, state)
    transitions = {transition.id: transition for transition in model.transitions}
    if transition_id not in transitions:
        raise ValueError(f"Неизвестный переход: {transition_id}")
    transition = transitions[transition_id]
    if not evaluate(transition.guard, state):
        raise ValueError(f"Переход недоступен: {transition_id}")
    next_state = {**state, **{effect.variable: evaluate(effect.value, state) for effect in transition.effects}}
    validate_state(model, next_state)
    return next_state
