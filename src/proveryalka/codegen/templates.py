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

API = '''"""HTTP API сервиса: модель, текущее состояние и применение событий."""
from typing import Annotated, Optional, Union

from fastapi import APIRouter, FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, StrictStr

from . import engine
from .domain import InvalidState
from .config import API_PREFIX, APPLICATION_MODE, STORAGE
from .rules import TRANSITIONS
from .state_store import RevisionConflict, state_store
from .spec import GENERATOR, MODEL_NAME, REQUIREMENTS, SPEC_HASH, VARIABLES, VERSION_ID


Value = Union[StrictBool, StrictInt, StrictStr]
InstanceID = Annotated[str, Query(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
REJECTIONS = (InvalidState, engine.UnknownTransition, engine.TransitionNotEnabled, engine.EffectOutOfDomain)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RevisionRequest(Body):
    expected_revision: Optional[StrictInt] = None


class EventRequest(RevisionRequest):
    transition: StrictStr


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


def create_app(database=None):
    app = FastAPI(title=MODEL_NAME, version=VERSION_ID)
    router = APIRouter(prefix=API_PREFIX)
    store = state_store(database)

    def snapshot(current):
        state, revision = current
        return {"state": state, "revision": revision, "enabled": engine.enabled_transitions(state)}

    def unsupported_instance(instance_id):
        return STORAGE == "memory" and instance_id != "default"

    @router.get("/model")
    def model():
        return {
            "name": MODEL_NAME, "version_id": VERSION_ID, "spec_hash": SPEC_HASH, "generator": GENERATOR,
            "variables": [describe(variable) for variable in VARIABLES],
            "transitions": [{"id": rule.id, "name": rule.name, "requirement_ids": list(rule.requirement_ids),
                             "assigns": list(rule.assigns)} for rule in TRANSITIONS.values()],
            "requirements": REQUIREMENTS,
        }

    @router.get("/state")
    def state(instance_id: InstanceID = "default"):
        if unsupported_instance(instance_id):
            return error(422, "INSTANCE_UNSUPPORTED", "Именованные экземпляры требуют SQLite")
        return snapshot(store.read(instance_id))

    @router.post("/events")
    def apply_event(body: EventRequest, instance_id: InstanceID = "default"):
        if unsupported_instance(instance_id):
            return error(422, "INSTANCE_UNSUPPORTED", "Именованные экземпляры требуют SQLite")
        try:
            current = store.update(instance_id, lambda state: engine.apply(state, body.transition),
                                   expected_revision=body.expected_revision)
        except RevisionConflict:
            return error(409, "REVISION_CONFLICT", "Состояние изменилось; перечитайте /state")
        except REJECTIONS as failure:
            return rejection(body.transition, failure)
        return {**snapshot(current), "applied": body.transition}

    @router.post("/evaluate")
    def evaluate(body: EvaluateRequest):
        try:
            following = engine.apply(body.state, body.transition)
        except REJECTIONS as failure:
            return rejection(body.transition, failure)
        return {"state": following, "enabled": engine.enabled_transitions(following)}

    @router.post("/reset")
    def reset(instance_id: InstanceID = "default"):
        if unsupported_instance(instance_id):
            return error(422, "INSTANCE_UNSUPPORTED", "Именованные экземпляры требуют SQLite")
        return snapshot(store.update(instance_id, lambda _: engine.initial_state()))

    if APPLICATION_MODE == "agent":
        from .actions import ACTIONS

        @router.get("/actions")
        def actions():
            return ACTIONS

        @router.post("/actions/{action}")
        def apply_action(action: str, body: Optional[RevisionRequest] = None, instance_id: InstanceID = "default"):
            transition = ACTIONS.get(action)
            if transition is None:
                return error(404, "UNKNOWN_ACTION", "Прикладное действие не найдено")
            return apply_event(EventRequest(transition=transition, expected_revision=body.expected_revision if body else None),
                               instance_id)

    app.include_router(router)
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


STATE_STORE = '''"""Атомарное обновление сохранённого состояния через один интерфейс."""
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from threading import Lock

from .config import STORAGE
from .engine import initial_state
from .spec import SPEC_HASH


class RevisionConflict(Exception):
    pass


def advance(current, transform, expected_revision):
    state, revision = current
    if expected_revision is not None and expected_revision != revision:
        raise RevisionConflict
    return transform(state), revision + 1


class MemoryState:
    def __init__(self):
        self.lock = Lock()
        self.current = (initial_state(), 0)

    def read(self, instance_id):
        with self.lock:
            state, revision = self.current
            return dict(state), revision

    def update(self, instance_id, transform, expected_revision=None):
        with self.lock:
            self.current = advance(self.current, transform, expected_revision)
            return dict(self.current[0]), self.current[1]


class SQLiteState:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.lock = Lock()
        self.initialized = False

    def connect(self):
        return sqlite3.connect(self.path, timeout=10, isolation_level=None)

    def initialize(self):
        with self.lock:
            if self.initialized:
                return
            with closing(self.connect()) as db:
                db.execute("""
                    CREATE TABLE IF NOT EXISTS process_instances (
                        spec_hash TEXT NOT NULL,
                        instance_id TEXT NOT NULL,
                        state_json TEXT NOT NULL,
                        revision INTEGER NOT NULL,
                        PRIMARY KEY (spec_hash, instance_id)
                    )
                """)
            self.initialized = True

    def load(self, db, instance_id):
        row = db.execute(
            "SELECT state_json, revision FROM process_instances WHERE spec_hash = ? AND instance_id = ?",
            (SPEC_HASH, instance_id),
        ).fetchone()
        return (json.loads(row[0]), row[1]) if row else (initial_state(), 0)

    def read(self, instance_id):
        self.initialize()
        with closing(self.connect()) as db:
            return self.load(db, instance_id)

    def update(self, instance_id, transform, expected_revision=None):
        self.initialize()
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            state, revision = advance(self.load(db, instance_id), transform, expected_revision)
            db.execute("""
                INSERT INTO process_instances (spec_hash, instance_id, state_json, revision) VALUES (?, ?, ?, ?)
                ON CONFLICT (spec_hash, instance_id) DO UPDATE
                SET state_json = excluded.state_json, revision = excluded.revision
            """, (SPEC_HASH, instance_id, json.dumps(state, ensure_ascii=False), revision))
            return state, revision


def state_store(database):
    if STORAGE == "sqlite":
        return SQLiteState(database or os.environ.get("SERVICE_STATE_DB", "service-state.sqlite3"))
    return MemoryState()
'''


PERSISTENCE_TESTS = '''"""Экземпляры процесса, повторное открытие БД и конкурентные запросы."""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi.testclient import TestClient

from app.api import create_app
from app.config import API_PREFIX
from test_api import INITIAL, PATH


def test_instances_survive_reopening_database(tmp_path):
    database = tmp_path / "state.db"
    with TestClient(create_app(database)) as api:
        untouched = api.post(API_PREFIX + "/reset?instance_id=b").json()
        if PATH:
            transition, expected = PATH[0]
            response = api.post(API_PREFIX + "/events?instance_id=a", json={"transition": transition})
            assert response.status_code == 200
            changed = response.json()
            assert changed["state"] == expected
            del changed["applied"]
        else:
            changed = api.post(API_PREFIX + "/reset?instance_id=a").json()
        assert changed["revision"] == 1
        assert api.get(API_PREFIX + "/state?instance_id=b").json() == untouched
    script = """
import json
import sys
from fastapi.testclient import TestClient
from app.api import create_app
from app.config import API_PREFIX

with TestClient(create_app(sys.argv[1])) as client:
    print(json.dumps([client.get(API_PREFIX + "/state", params={"instance_id": key}).json()
                      for key in ("a", "b", "c")]))
"""
    restarted = subprocess.run([sys.executable, "-c", script, str(database)],
                               check=True, capture_output=True, text=True, timeout=20)
    first, second, new = json.loads(restarted.stdout)
    assert first == changed
    assert second == untouched
    assert new["state"] == INITIAL and new["revision"] == 0


def test_concurrent_writes_serialize_across_app_instances(tmp_path):
    database = tmp_path / "state.db"
    with TestClient(create_app(database)) as first, TestClient(create_app(database)) as second:
        ready = Barrier(2)
        if PATH:
            url = API_PREFIX + "/events?instance_id=a"
            kwargs = {"json": {"transition": PATH[0][0], "expected_revision": 0}}
        else:
            url = API_PREFIX + "/reset?instance_id=a"
            kwargs = {}

        def write(api):
            ready.wait(timeout=10)
            return api.post(url, **kwargs).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            assert sorted(executor.map(write, (first, second))) == ([200, 409] if PATH else [200, 200])

        revisions = 1 if PATH else 2
        assert first.get(API_PREFIX + "/state?instance_id=a").json()["revision"] == revisions

        def reset(api):
            return api.post(API_PREFIX + "/reset?instance_id=a").json()["revision"]

        with ThreadPoolExecutor(max_workers=2) as executor:
            assert sorted(executor.map(reset, (first, second))) == [revisions + 1, revisions + 2]
'''
