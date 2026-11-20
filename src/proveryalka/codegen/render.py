"""Файлы проекта, зависящие от модели: данные, правила переходов, тесты и README."""
import json
from contextlib import contextmanager

from ..behavior.contracts import BooleanDomain, IntegerDomain
from .explore import sequential
from .pyexpr import comment, compile_expression, literal, markdown, one_line
from .scope import GENERATOR_NAME, GENERATOR_VERSION, TECHNICAL_CONDITIONS


GENERATOR = f"{GENERATOR_NAME} {GENERATOR_VERSION}"
MAX_API_PATH = 12


class Source:
    """Текст файла с диапазонами строк элементов модели для перехода «код ↔ правило»."""

    def __init__(self):
        self.lines = []
        self.elements = []

    def add(self, *lines):
        for line in lines:
            self.lines.extend(line.split("\n"))

    @contextmanager
    def element(self, kind, identifier, name, requirement_ids):
        start = len(self.lines) + 1
        yield
        end = len(self.lines)
        while end > start and not self.lines[end - 1].strip():
            end -= 1
        self.elements.append({"kind": kind, "id": identifier, "name": name,
                              "requirement_ids": list(requirement_ids), "start_line": start, "end_line": end})

    def text(self):
        return "\n".join(self.lines).rstrip("\n") + "\n"


def requirement_line(model, requirement_ids):
    texts = {item.id: item.text for item in model.requirements}
    return "; ".join(f"{identifier}: {texts.get(identifier, '')}" for identifier in requirement_ids)


def variable_args(variable):
    domain = variable.domain
    args = [f"id={literal(variable.id)}", f"name={literal(variable.name)}", f"kind={literal(domain.kind)}",
            f"initial={literal(variable.initial_value)}", f"requirement_ids={literal(tuple(variable.requirement_ids))}"]
    if isinstance(domain, IntegerDomain):
        args += [f"minimum={literal(domain.minimum)}", f"maximum={literal(domain.maximum)}"]
    elif not isinstance(domain, BooleanDomain):
        args.append(f"values={literal(tuple(domain.values))}")
    return ", ".join(args)


def render_spec(model, provenance):
    source = Source()
    source.add('"""Данные согласованной модели: требования, переменные, области значений, начальное состояние."""',
               "from .domain import Variable", "", "",
               comment(f"Модель: {model.name}"),
               f"MODEL_NAME = {literal(model.name)}",
               f"VERSION_ID = {literal(provenance.version_id)}",
               f"SPEC_HASH = {literal(provenance.spec_hash)}",
               f"GENERATOR = {literal(GENERATOR)}", "", "REQUIREMENTS = {")
    for requirement in model.requirements:
        with source.element("requirement", requirement.id, requirement.id, [requirement.id]):
            source.add(f"    {literal(requirement.id)}: {literal(requirement.text)},")
    source.add("}", "", "VARIABLES = (")
    for variable in model.variables:
        with source.element("variable", variable.id, variable.name, variable.requirement_ids):
            source.add("    " + comment(f"{variable.id} «{variable.name}» — {', '.join(variable.requirement_ids)}"),
                       f"    Variable({variable_args(variable)}),")
    source.add(")", "", "INITIAL_STATE = {variable.id: variable.initial for variable in VARIABLES}")
    return source


def render_rules(model, provenance):
    source = Source()
    source.add('"""Правила переходов модели: условие (guard) и одновременное присваивание (effects).',
               "",
               "Функции effects_* читают только состояние до события `s` и возвращают новые значения",
               "присваиваемых переменных; остальные переменные не меняются. Правила меняются только через",
               'новую согласованную версию модели и повторную генерацию."""',
               comment(f"Версия {provenance.version_id}, spec_hash {provenance.spec_hash}, {GENERATOR}"),
               "from dataclasses import dataclass",
               "from typing import Callable", "", "",
               "@dataclass(frozen=True)",
               "class Transition:",
               "    id: str", "    name: str", "    requirement_ids: tuple", "    assigns: tuple",
               "    guard: Callable", "    effects: Callable", "")
    for transition in model.transitions:
        path = f"transitions.{transition.id}"
        source.add("")
        with source.element("transition", transition.id, transition.name, transition.requirement_ids):
            source.add(comment(f"Переход {transition.id} «{transition.name}»"),
                       comment(requirement_line(model, transition.requirement_ids)),
                       f"def guard_{transition.id}(s):",
                       f"    return {compile_expression(transition.guard, path=f'{path}.guard')}",
                       "", "")
            source.add(f"def effects_{transition.id}(s):")
            if transition.effects:
                source.add("    return {")
                for index, effect in enumerate(transition.effects):
                    value = compile_expression(effect.value, path=f"{path}.effects[{index}].value")
                    source.add(f"        {literal(effect.variable)}: {value},")
                source.add("    }")
            else:
                source.add("    return {}")
            source.add("")
    source.add("", "TRANSITIONS = {")
    for transition in model.transitions:
        assigns = tuple(effect.variable for effect in transition.effects)
        source.add(f"    {literal(transition.id)}: Transition(",
                   f"        id={literal(transition.id)},",
                   f"        name={literal(transition.name)},",
                   f"        requirement_ids={literal(tuple(transition.requirement_ids))},",
                   f"        assigns={literal(assigns)},",
                   f"        guard=guard_{transition.id},",
                   f"        effects=effects_{transition.id},",
                   "    ),")
    source.add("}")
    return source


def first(rows, transition_id, kind, predicate=None):
    return next((row for row in rows if row.transition == transition_id and row.outcome == kind
                 and (predicate is None or predicate(row))), None)


def most_changing(rows, transition):
    """Свидетель применения, где меняется больше всего присваиваемых переменных; при равенстве — первый в BFS."""
    candidates = [(position, row) for position, row in enumerate(rows) if row.transition == transition.id and row.outcome == "applied"]
    if not candidates:
        return None
    changed = lambda row: sum(row.next[effect.variable] != row.state[effect.variable] for effect in transition.effects)  # noqa: E731
    return max(candidates, key=lambda item: (changed(item[1]), -item[0]))[1]


def render_transition_tests(model, exploration):
    rows = exploration.rows
    source = Source()
    source.add('"""Тесты переходов: сгенерированные правила против семантики согласованной модели.',
               "",
               "Ожидаемые состояния вычислены генератором по BehavioralModel 1.0 (proveryalka.behavior.step)",
               "для этой версии. Тесты проверяют перечисленные состояния и не доказывают соответствие",
               'во всех состояниях."""',
               "import json", "from pathlib import Path", "", "import pytest", "", "from app import engine", "", "",
               'TABLE = json.loads((Path(__file__).parent / "data" / "conformance.json").read_text(encoding="utf-8"))',
               'ROWS = TABLE["rows"]', "", "")
    for transition in model.transitions:
        tid = transition.id
        assigned = [effect.variable for effect in transition.effects]
        kept = tuple(variable.id for variable in model.variables if variable.id not in assigned)
        with source.element("transition", tid, transition.name, transition.requirement_ids):
            source.add(comment(f"{tid} «{transition.name}» — {', '.join(transition.requirement_ids)}"))
            applied = most_changing(rows, transition)
            if applied is None:
                source.add(comment(f"Среди перечисленных состояний нет такого, где условие {tid} выполнено и область не нарушена."))
            else:
                if applied.origin == "reachable":
                    route = " → ".join(exploration.paths[applied.index])
                    source.add(comment(f"Исходное состояние достигается из начального: {route}" if route else "Исходное состояние — начальное"))
                source.add(f"def test_{tid}_applies_effects_and_keeps_other_variables():",
                           f"    before = {literal(applied.state)}",
                           f"    after = engine.apply(before, {literal(tid)})",
                           f"    assert after == {literal(applied.next)}")
                if kept:
                    source.add(f"    kept = {literal(kept)}",
                               "    assert {name: after[name] for name in kept} == {name: before[name] for name in kept}")
                source.add(f"    assert before == {literal(applied.state)}", "", "")
            parallel = first(rows, tid, "applied", lambda row, rule=transition: sequential(rule, row.state) != row.next)
            if parallel is not None:
                source.add(comment(f"Последовательное присваивание дало бы {sequential(transition, parallel.state)}"),
                           f"def test_{tid}_assigns_simultaneously():",
                           f"    assert engine.apply({literal(parallel.state)}, {literal(tid)}) == {literal(parallel.next)}",
                           "", "")
            blocked = first(rows, tid, "not_enabled")
            if blocked is not None:
                source.add(f"def test_{tid}_rejected_when_guard_is_false():",
                           f"    state = {literal(blocked.state)}",
                           "    with pytest.raises(engine.TransitionNotEnabled):",
                           f"        engine.apply(state, {literal(tid)})",
                           "    assert engine.check_state(state) == state", "", "")
            outside = first(rows, tid, "out_of_domain")
            if outside is not None:
                source.add(f"def test_{tid}_rejected_when_effect_leaves_domain():",
                           "    with pytest.raises(engine.EffectOutOfDomain):",
                           f"        engine.apply({literal(outside.state)}, {literal(tid)})", "", "")
    if rows:
        source.add('@pytest.mark.parametrize("row", ROWS, ids=[row["id"] for row in ROWS])',
                   "def test_conformance_table(row):",
                   '    if row["outcome"] == "applied":',
                   '        assert engine.apply(row["state"], row["transition"]) == row["next"]',
                   "        return",
                   '    expected = engine.TransitionNotEnabled if row["outcome"] == "not_enabled" else engine.EffectOutOfDomain',
                   "    with pytest.raises(expected):",
                   '        engine.apply(row["state"], row["transition"])', "", "")
    source.add("def test_unknown_transition_is_rejected():",
               "    with pytest.raises(engine.UnknownTransition):",
               "        engine.apply(engine.initial_state(), '__unknown__')")
    return source


def api_path(exploration):
    depth = [len(path) for path in exploration.paths]
    target = max(range(len(depth)), key=lambda index: (min(depth[index], MAX_API_PATH), -index))
    path = exploration.paths[target][:MAX_API_PATH]
    steps = []
    by_path = {tuple(p): i for i, p in enumerate(exploration.paths)}
    for length in range(1, len(path) + 1):
        current = by_path[tuple(path[:length])]
        steps.append((path[length - 1], exploration.states[current]))
    return steps


def render_api_tests(model, exploration):
    initial = exploration.states[0]
    enabled = [row.transition for row in exploration.rows if row.origin == "reachable" and row.index == 0 and row.outcome != "not_enabled"]
    # enabled_transitions смотрит только на условие: переход с выходом за область тоже «доступен».
    blocked = next((row.transition for row in exploration.rows if row.origin == "reachable" and row.index == 0 and row.outcome == "not_enabled"), None)
    outside = next((row for row in exploration.rows if row.outcome == "out_of_domain"), None)
    steps = api_path(exploration)
    ids = [transition.id for transition in model.transitions]
    source = Source()
    source.add('"""HTTP API: модель, состояние, применение событий и отказы."""',
               "from fastapi.testclient import TestClient", "",
               "from app.api import create_app",
               "from app.spec import SPEC_HASH, VERSION_ID", "", "",
               f"INITIAL = {literal(initial)}",
               f"INITIAL_ENABLED = {literal(tuple(enabled))}",
               f"TRANSITIONS = {literal({transition.id: tuple(transition.requirement_ids) for transition in model.transitions})}",
               "PATH = (")
    for transition_id, state in steps:
        source.add(f"    ({literal(transition_id)}, {literal(state)}),")
    source.add(")", "", "",
               "def client():",
               "    return TestClient(create_app())", "", "",
               "def test_model_endpoint_links_version_and_requirements():",
               '    body = client().get("/model").json()',
               '    assert body["version_id"] == VERSION_ID',
               '    assert body["spec_hash"] == SPEC_HASH',
               '    assert {item["id"]: tuple(item["requirement_ids"]) for item in body["transitions"]} == TRANSITIONS', "", "",
               "def test_initial_state():",
               '    assert client().get("/state").json() == {"state": INITIAL, "revision": 0, "enabled": list(INITIAL_ENABLED)}', "", "")
    if steps:
        source.add("def test_event_sequence_over_http():",
                   "    api = client()",
                   "    for revision, (transition_id, expected) in enumerate(PATH, start=1):",
                   '        response = api.post("/events", json={"transition": transition_id, "expected_revision": revision - 1})',
                   "        assert response.status_code == 200, response.text",
                   '        assert response.json()["state"] == expected',
                   '        assert response.json()["revision"] == revision',
                   '    assert api.get("/state").json()["state"] == PATH[-1][1]', "", "",
                   "def test_reset_returns_initial_state():",
                   "    api = client()",
                   '    api.post("/events", json={"transition": PATH[0][0]})',
                   '    body = api.post("/reset").json()',
                   '    assert body["state"] == INITIAL', "", "")
    if blocked is not None:
        source.add("def test_disabled_event_is_rejected_and_state_kept():",
                   "    api = client()",
                   f'    response = api.post("/events", json={{"transition": {literal(blocked)}}})',
                   "    assert response.status_code == 409",
                   '    assert response.json()["error"]["code"] == "TRANSITION_NOT_ENABLED"',
                   '    assert api.get("/state").json() == {"state": INITIAL, "revision": 0, "enabled": list(INITIAL_ENABLED)}', "", "")
    if outside is not None:
        source.add("def test_evaluate_reports_effect_out_of_domain():",
                   f'    response = client().post("/evaluate", json={{"state": {literal(outside.state)}, "transition": {literal(outside.transition)}}})',
                   "    assert response.status_code == 409",
                   '    assert response.json()["error"]["code"] == "EFFECT_OUT_OF_DOMAIN"', "", "")
    probe = ids[0] if ids else "__unknown__"
    source.add("def test_unknown_transition_returns_404():",
               '    response = client().post("/events", json={"transition": "__unknown__"})',
               "    assert response.status_code == 404",
               '    assert response.json()["error"]["code"] == "UNKNOWN_TRANSITION"', "", "",
               "def test_revision_conflict_returns_409():",
               f'    response = client().post("/events", json={{"transition": {literal(probe)}, "expected_revision": 99}})',
               "    assert response.status_code == 409",
               '    assert response.json()["error"]["code"] == "REVISION_CONFLICT"', "", "",
               "def test_request_body_is_validated():",
               '    assert client().post("/events", json={"transition": 1}).status_code == 422',
               '    assert client().post("/events", json={"transition": "x", "extra": True}).status_code == 422', "", "",
               "def test_evaluate_rejects_invalid_state():",
               '    response = client().post("/evaluate", json={"state": {}, "transition": "__unknown__"})',
               "    assert response.status_code == 422",
               '    assert response.json()["error"]["code"] == "INVALID_STATE"')
    return source


def conformance_data(model, provenance, exploration, traces):
    rows = [{"id": f"{row.origin[0]}{row.index}-{row.transition}", "origin": row.origin, "state": row.state,
             "transition": row.transition, "outcome": row.outcome, "next": row.next} for row in exploration.rows]
    return {
        "semantics": "BehavioralModel 1.0, proveryalka.behavior.step",
        "version_id": provenance.version_id, "spec_hash": provenance.spec_hash,
        "initial_state": exploration.states[0], "reachable_states": len(exploration.states),
        "exhaustive": exploration.exhaustive, "boundary_states": exploration.boundary_states,
        "rows": rows, "invalid_states": exploration.invalid_states, "traces": traces,
    }


VERIFICATION_TEXT = {
    "holds": "TLC подтвердил все свойства модели для этой версии (в пределах лимитов проверки).",
    "violated": "TLC нашёл нарушение свойств. Код воспроизводит согласованную модель вместе с этим поведением: генератор модель не исправляет. Генерация выполнена с явным подтверждением.",
    "inconclusive": "Проверка TLC не дала окончательного результата по всем свойствам. Генерация выполнена с явным подтверждением.",
    "not_checked": "Для этой версии нет завершённой проверки TLC. Генерация выполнена с явным подтверждением.",
}


def render_readme(model, provenance, verification, coverage, rules_elements, files):
    lines = {element["id"]: element["start_line"] for element in rules_elements}
    out = [f"# {markdown(model.name)}", "",
           f"Сервис сгенерирован `{GENERATOR}` из согласованной версии модели. Изменения правил вносятся новой версией модели и повторной генерацией.", "",
           "| Поле | Значение |", "|---|---|",
           f"| version_id | `{one_line(provenance.version_id)}` |",
           f"| spec_hash | `{one_line(provenance.spec_hash)}` |",
           f"| Цель | Python {TECHNICAL_CONDITIONS['python']}, {TECHNICAL_CONDITIONS['framework']}, {TECHNICAL_CONDITIONS['test_runner']} |",
           f"| Проверка TLC | {verification['state']} |", "",
           "## Запуск", "", "```bash",
           "python -m venv .venv && . .venv/bin/activate",
           "pip install -r requirements.txt",
           "pytest",
           "uvicorn app.api:app --port 8001",
           "```", "",
           "## API", "",
           "| Метод | Путь | Назначение |", "|---|---|---|",
           "| GET | `/model` | Переменные, области, переходы, ссылки на требования, version_id, spec_hash |",
           "| GET | `/state` | Текущее состояние, номер ревизии, доступные переходы |",
           "| POST | `/events` | `{\"transition\": id, \"expected_revision\"?: n}`: применить событие; 404 неизвестный переход, 409 условие ложно, выход за область или конфликт ревизии |",
           "| POST | `/evaluate` | `{\"state\": {...}, \"transition\": id}`: вычислить переход без изменения состояния сервиса; 422 при недопустимом состоянии |",
           "| POST | `/reset` | Вернуть начальное состояние |", "",
           "## Переходы и требования", "",
           "| Переход | Название | Требования | Присваивает | Код |", "|---|---|---|---|---|"]
    for transition in model.transitions:
        assigns = ", ".join(effect.variable for effect in transition.effects) or "—"
        out.append(f"| `{transition.id}` | {markdown(transition.name)} | {markdown(', '.join(transition.requirement_ids))} | {assigns} | `app/rules.py:{lines.get(transition.id, 1)}` |")
    out += ["", "## Требования", ""]
    out += [f"- **{markdown(item.id)}** — {markdown(item.text)}" for item in model.requirements]
    out += ["", "## Проверка модели (TLC)", "", VERIFICATION_TEXT[verification["state"]], ""]
    if verification["properties"]:
        out += ["| Свойство | Вид | Статус | Проверка |", "|---|---|---|---|"]
        kinds = {prop.id: prop.kind for prop in model.properties}
        for item in verification["properties"]:
            out.append(f"| `{item['property_id']}` | {kinds.get(item['property_id'], '')} | {item['status'] or 'не проверено'} | {one_line(item['check_run_id'] or '—')} |")
        out.append("")
    reach = "полный перебор" if coverage["exhaustive"] else "перебор остановлен на лимите"
    out += ["## Что проверяют тесты", "",
            f"- `tests/test_transitions.py` и `tests/data/conformance.json`: {coverage['conformance_cases']} исходов переходов для {coverage['reachable_states']} достижимых состояний ({reach}) и {coverage['boundary_states']} граничных состояний областей.",
            f"- `tests/test_domain.py`: типы и конечные области, {coverage['invalid_state_cases']} недопустимых состояний.",
            "- `tests/test_api.py`: HTTP API на последовательности событий и отказах.",
            f"- `tests/test_traces.py`: повтор трасс TLC через код, трасс: {coverage['trace_replays']}." if coverage["trace_replays"] else "- Трасс TLC в снимке проверки нет, файл повтора трасс не создан.",
            "- `tests/test_provenance.py`: spec_hash модели, состав переходов, переменных и ссылок на требования.", "",
            "Тесты сравнивают код с семантикой модели на перечисленных состояниях. Они не доказывают соответствие во всех состояниях и не заменяют проверку свойств: статусы свойств получены TLC в пределах его лимитов.", "",
            "## Файлы", ""]
    out += [f"- `{item['path']}` — {item['explanation']}" for item in files]
    return "\n".join(out) + "\n"


def to_json(data):
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
