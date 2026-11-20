"""Неизменяемые файлы сгенерированного проекта: одинаковы для любой модели одной версии генератора."""

DOMAIN = '''"""Типы и конечные области значений переменных; проверка состояния модели."""
from dataclasses import dataclass
from typing import Optional


class InvalidState(ValueError):
    """Состояние не соответствует переменным или областям значений модели."""

    def __init__(self, variable, reason):
        super().__init__(f"{variable}: {reason}")
        self.variable = variable
        self.reason = reason


@dataclass(frozen=True)
class Variable:
    id: str
    name: str
    kind: str
    initial: object
    requirement_ids: tuple
    minimum: Optional[int] = None
    maximum: Optional[int] = None
    values: tuple = ()

    def contains(self, value):
        # bool не считается целым: True и 1 различаются, как в модели.
        if self.kind == "boolean":
            return type(value) is bool
        if self.kind == "integer":
            return type(value) is int and self.minimum <= value <= self.maximum
        return type(value) is str and value in self.values


def validate_state(variables, state):
    """Возвращает копию состояния или поднимает InvalidState."""
    if not isinstance(state, dict):
        raise InvalidState("*", "состояние должно быть объектом")
    known = {variable.id for variable in variables}
    for name in state:
        if name not in known:
            raise InvalidState(str(name), "переменной нет в модели")
    for variable in variables:
        if variable.id not in state:
            raise InvalidState(variable.id, "значение отсутствует")
        if not variable.contains(state[variable.id]):
            raise InvalidState(variable.id, f"значение {state[variable.id]!r} вне области {variable.kind}")
    return dict(state)
'''

ENGINE = '''"""Применение события модели к состоянию.

Порядок: проверка состояния, условие перехода, одновременное присваивание (все правые части
вычисляются по состоянию до события), проверка областей нового состояния. Переменные без
присваивания сохраняют значение. Отказ не меняет переданное состояние.
"""
from .domain import InvalidState, validate_state
from .rules import TRANSITIONS
from .spec import INITIAL_STATE, VARIABLES


class UnknownTransition(LookupError):
    """Перехода нет в модели."""


class TransitionNotEnabled(ValueError):
    """Условие перехода ложно в этом состоянии."""


class EffectOutOfDomain(ValueError):
    """Присваивание выводит переменную за область значений."""

    def __init__(self, transition_id, error):
        super().__init__(f"{transition_id}: {error}")
        self.transition_id = transition_id
        self.variable = error.variable


def initial_state():
    return dict(INITIAL_STATE)


def check_state(state):
    return validate_state(VARIABLES, state)


def transition(transition_id):
    try:
        return TRANSITIONS[transition_id]
    except (KeyError, TypeError):
        raise UnknownTransition(transition_id) from None


def enabled_transitions(state):
    current = check_state(state)
    return [rule.id for rule in TRANSITIONS.values() if rule.guard(current)]


def apply(state, transition_id):
    current = check_state(state)
    rule = transition(transition_id)
    if not rule.guard(current):
        raise TransitionNotEnabled(transition_id)
    following = {**current, **rule.effects(current)}
    try:
        return check_state(following)
    except InvalidState as error:
        raise EffectOutOfDomain(transition_id, error) from error
'''

API = '''"""HTTP API сервиса: модель, текущее состояние и применение событий.

Состояние хранится в памяти одного процесса; события применяются по одному под блокировкой.
"""
from threading import Lock
from typing import Optional, Union

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, StrictStr

from . import engine
from .domain import InvalidState
from .rules import TRANSITIONS
from .spec import GENERATOR, MODEL_NAME, REQUIREMENTS, SPEC_HASH, VARIABLES, VERSION_ID


Value = Union[StrictBool, StrictInt, StrictStr]
REJECTIONS = (InvalidState, engine.UnknownTransition, engine.TransitionNotEnabled, engine.EffectOutOfDomain)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EventRequest(Body):
    transition: StrictStr
    expected_revision: Optional[StrictInt] = None


class EvaluateRequest(Body):
    state: dict[str, Value]
    transition: StrictStr


def error(status, code, message):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def rejection(transition_id, failure):
    if isinstance(failure, engine.UnknownTransition):
        return error(404, "UNKNOWN_TRANSITION", f"Перехода {transition_id!r} нет в модели")
    if isinstance(failure, engine.TransitionNotEnabled):
        return error(409, "TRANSITION_NOT_ENABLED", f"Условие перехода {transition_id} не выполнено")
    if isinstance(failure, engine.EffectOutOfDomain):
        return error(409, "EFFECT_OUT_OF_DOMAIN", str(failure))
    return error(422, "INVALID_STATE", str(failure))


def describe(variable):
    domain = {"kind": variable.kind}
    if variable.kind == "integer":
        domain.update(minimum=variable.minimum, maximum=variable.maximum)
    if variable.kind == "enum":
        domain["values"] = list(variable.values)
    return {"id": variable.id, "name": variable.name, "domain": domain,
            "initial_value": variable.initial, "requirement_ids": list(variable.requirement_ids)}


def create_app():
    app = FastAPI(title=MODEL_NAME, version=VERSION_ID)
    lock = Lock()
    current = {"state": engine.initial_state(), "revision": 0}

    def snapshot():
        return {"state": dict(current["state"]), "revision": current["revision"],
                "enabled": engine.enabled_transitions(current["state"])}

    @app.get("/model")
    def model():
        return {
            "name": MODEL_NAME, "version_id": VERSION_ID, "spec_hash": SPEC_HASH, "generator": GENERATOR,
            "variables": [describe(variable) for variable in VARIABLES],
            "transitions": [{"id": rule.id, "name": rule.name, "requirement_ids": list(rule.requirement_ids),
                             "assigns": list(rule.assigns)} for rule in TRANSITIONS.values()],
            "requirements": REQUIREMENTS,
        }

    @app.get("/state")
    def state():
        with lock:
            return snapshot()

    @app.post("/events")
    def apply_event(body: EventRequest):
        with lock:
            if body.expected_revision is not None and body.expected_revision != current["revision"]:
                return error(409, "REVISION_CONFLICT", "Состояние изменилось; перечитайте /state")
            try:
                following = engine.apply(current["state"], body.transition)
            except REJECTIONS as failure:
                return rejection(body.transition, failure)
            current["state"] = following
            current["revision"] += 1
            return {**snapshot(), "applied": body.transition}

    @app.post("/evaluate")
    def evaluate(body: EvaluateRequest):
        try:
            following = engine.apply(body.state, body.transition)
        except REJECTIONS as failure:
            return rejection(body.transition, failure)
        return {"state": following, "enabled": engine.enabled_transitions(following)}

    @app.post("/reset")
    def reset():
        with lock:
            current["state"] = engine.initial_state()
            current["revision"] += 1
            return snapshot()

    return app


app = create_app()
'''

PYTEST_INI = """[pytest]
testpaths = tests
pythonpath = .
addopts = -p no:cacheprovider
"""

DOMAIN_TESTS = '''"""Проверка типов и конечных областей значений состояния."""
import json
from pathlib import Path

import pytest

from app import engine
from app.domain import InvalidState


TABLE = json.loads((Path(__file__).parent / "data" / "conformance.json").read_text(encoding="utf-8"))
CASES = TABLE["invalid_states"]


def test_initial_state_matches_model():
    assert engine.initial_state() == TABLE["initial_state"]
    assert engine.check_state(engine.initial_state()) == TABLE["initial_state"]


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_invalid_state_is_rejected(case):
    with pytest.raises(InvalidState) as error:
        engine.check_state(case["state"])
    assert error.value.variable == case["variable"]


def test_state_must_be_an_object():
    with pytest.raises(InvalidState):
        engine.check_state([])
'''

PROVENANCE_TESTS = '''"""Связь кода с согласованной моделью: spec_hash, переходы, переменные и ссылки на требования."""
import hashlib
import json
from pathlib import Path

from app.rules import TRANSITIONS
from app.spec import REQUIREMENTS, SPEC_HASH, VARIABLES


MODEL = json.loads((Path(__file__).resolve().parents[1] / "model" / "behavioral_model.json").read_text(encoding="utf-8"))


def test_model_file_matches_spec_hash():
    canonical = json.dumps(MODEL, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    assert hashlib.sha256(canonical.encode("utf-8")).hexdigest() == SPEC_HASH


def test_rules_follow_model_transitions():
    assert list(TRANSITIONS) == [item["id"] for item in MODEL["transitions"]]
    for item in MODEL["transitions"]:
        rule = TRANSITIONS[item["id"]]
        assert rule.requirement_ids == tuple(item["requirement_ids"])
        assert rule.assigns == tuple(effect["variable"] for effect in item["effects"])


def test_variables_follow_model():
    expected = [(item["id"], item["domain"]["kind"], item["initial_value"]) for item in MODEL["variables"]]
    assert [(variable.id, variable.kind, variable.initial) for variable in VARIABLES] == expected


def test_requirement_references_exist():
    assert set(REQUIREMENTS) == {item["id"] for item in MODEL["requirements"]}
    for rule in TRANSITIONS.values():
        assert set(rule.requirement_ids) <= set(REQUIREMENTS)
    for variable in VARIABLES:
        assert set(variable.requirement_ids) <= set(REQUIREMENTS)
'''

TRACE_TESTS = '''"""Повтор трасс TLC этой версии модели через сгенерированный код.

Статус свойства определяет TLC в пределах своих лимитов, а не эти тесты. Трасса нарушения
воспроизводится как поведение согласованной модели: генератор модель не исправляет.
"""
import json
from pathlib import Path

import pytest

from app import engine


TRACES = json.loads((Path(__file__).parent / "data" / "conformance.json").read_text(encoding="utf-8"))["traces"]


@pytest.mark.parametrize("trace", TRACES, ids=[trace["property_id"] for trace in TRACES])
def test_tlc_trace_is_reproduced(trace):
    state = engine.initial_state()
    assert state == trace["steps"][0]["state"]
    for step in trace["steps"][1:]:
        state = engine.apply(state, step["transition_id"])
        assert state == step["state"]
    if trace["kind"] == "deadlock_free" and trace["status"] == "PROPERTY_VIOLATED":
        assert engine.enabled_transitions(state) == []
'''
