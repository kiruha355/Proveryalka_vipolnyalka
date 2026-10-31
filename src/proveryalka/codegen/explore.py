"""Ожидаемые исходы переходов для генерируемых тестов по эталонной семантике proveryalka.behavior.

Исходы считаются через behavior.evaluate/step на момент генерации и записываются в тесты как данные.
Перебор ограничен: при обрыве exhaustive=false, и это видно в манифесте проекта.
"""
import itertools
from dataclasses import dataclass, field

from ..behavior import evaluate, initial_state, step
from ..behavior.contracts import BooleanDomain, IntegerDomain


MAX_ROWS = 4000
MAX_REACHABLE = 256
MAX_BOUNDARY = 64
MAX_BOUNDARY_SCAN = 20_000


@dataclass
class Row:
    origin: str  # reachable | boundary
    index: int
    state: dict
    transition: str
    outcome: str  # applied | not_enabled | out_of_domain
    next: dict | None = None


@dataclass
class Exploration:
    states: list
    paths: list
    rows: list
    exhaustive: bool
    boundary_states: int
    invalid_states: list = field(default_factory=list)


def key(model, state):
    return tuple(state[variable.id] for variable in model.variables)


def outcome(model, state, transition):
    if not evaluate(transition.guard, state):
        return "not_enabled", None
    try:
        return "applied", step(model, state, transition.id)
    except ValueError:
        # Условие уже выполнено, поэтому step отказывает только из-за области нового состояния.
        return "out_of_domain", None


def sequential(transition, state):
    """Последовательное присваивание: используется только чтобы найти свидетеля одновременности."""
    current = dict(state)
    for effect in transition.effects:
        current[effect.variable] = evaluate(effect.value, current)
    return current


def boundary_values(variable):
    domain = variable.domain
    if isinstance(domain, BooleanDomain):
        values = [False, True]
    elif isinstance(domain, IntegerDomain):
        low, high = domain.minimum, domain.maximum
        values = sorted({low, min(low + 1, high), max(high - 1, low), high, variable.initial_value})
    else:
        values = list(domain.values[:8])
    if variable.initial_value not in values:
        values.append(variable.initial_value)
    return values


def invalid_states(model, initial):
    cases = []
    for variable in model.variables:
        domain = variable.domain
        if isinstance(domain, BooleanDomain):
            wrong = [("integer_instead_of_boolean", 1), ("string_instead_of_boolean", "true")]
        elif isinstance(domain, IntegerDomain):
            wrong = [("boolean_instead_of_integer", True), ("string_instead_of_integer", str(domain.minimum)),
                     ("below_minimum", domain.minimum - 1), ("above_maximum", domain.maximum + 1)]
        else:
            candidates = itertools.chain([""], (f"{domain.values[0]}_{n}" for n in itertools.count()))
            outside = next(candidate for candidate in candidates if candidate not in domain.values)
            wrong = [("integer_instead_of_enum", 0), ("value_outside_enum", outside)]
        for reason, value in wrong:
            cases.append({"id": f"{variable.id}-{reason}", "variable": variable.id, "state": {**initial, variable.id: value}})
    first = model.variables[0].id
    cases.append({"id": "missing_variable", "variable": first, "state": {k: v for k, v in initial.items() if k != first}})
    cases.append({"id": "unknown_variable", "variable": "__extra__", "state": {**initial, "__extra__": 0}})
    return cases


def explore(model):
    transitions = model.transitions
    width = max(len(transitions), 1)
    limit = max(1, min(MAX_REACHABLE, MAX_ROWS // width))
    initial = initial_state(model)
    states, paths, seen = [initial], [[]], {key(model, initial): 0}
    rows, exhaustive, index = [], True, 0
    while index < len(states):
        state = states[index]
        for transition in transitions:
            kind, following = outcome(model, state, transition)
            rows.append(Row("reachable", index, state, transition.id, kind, following))
            if kind == "applied" and key(model, following) not in seen:
                if len(states) < limit:
                    seen[key(model, following)] = len(states)
                    states.append(following)
                    paths.append(paths[index] + [transition.id])
                else:
                    exhaustive = False
        index += 1
    budget = min(MAX_BOUNDARY, max(0, (MAX_ROWS - len(rows)) // width)) if transitions else 0
    boundary = 0
    candidates = itertools.product(*(boundary_values(variable) for variable in model.variables))
    for values in itertools.islice(candidates, MAX_BOUNDARY_SCAN):
        if boundary >= budget:
            break
        state = {variable.id: value for variable, value in zip(model.variables, values, strict=True)}
        if key(model, state) in seen:
            continue
        seen[key(model, state)] = None
        for transition in transitions:
            kind, following = outcome(model, state, transition)
            rows.append(Row("boundary", boundary, state, transition.id, kind, following))
        boundary += 1
    return Exploration(states, paths, rows, exhaustive, boundary, invalid_states(model, initial))
