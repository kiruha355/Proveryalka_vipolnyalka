import json
import re
from dataclasses import dataclass, field

from ..behavior.runtime import initial_state, step
from ..behavior.validation import contains
from ..verification.contracts import CheckStatistics, TraceStep
from .spec import LIMIT_DEPTH, LIMIT_STATES, TYPE_OK


MESSAGE = re.compile(r"@!@!@STARTMSG (\d+):(\d+) @!@!@\n(.*?)@!@!@ENDMSG \1 @!@!@", re.S)
VIOLATED = re.compile(r"^Invariant (\w+) is violated")
STATES = re.compile(r"([\d,]+) states generated.*?([\d,]+) distinct states found")
DEPTH = re.compile(r"depth of the complete state graph search is ([\d,]+)")
PROGRESS = re.compile(r"Progress\(([\d,]+)\)")

SUCCESS = 2193
SUCCESS_TEXT = "Model checking completed. No error has been found."
STATS = 2199
SEARCH_DEPTH = 2194
PROGRESS_CODE = 2200
INVARIANT_INITIAL = 2107
INVARIANT_BEHAVIOR = 2110
BEHAVIOR_HEADER = 2121
ERROR = 1
EXIT_SAFETY_VIOLATION = 12


class TraceError(ValueError):
    pass


@dataclass(frozen=True)
class Message:
    code: int
    severity: int
    text: str


@dataclass
class Outcome:
    status: str
    message: str
    trace: list[TraceStep] = field(default_factory=list)
    statistics: CheckStatistics = field(default_factory=CheckStatistics)
    reason: str = ""


def messages(output):
    return [Message(int(code), int(severity), text.strip()) for code, severity, text in MESSAGE.findall(output)]


def number(text):
    return int(text.replace(",", ""))


def statistics(items, elapsed=None):
    """Только то, что TLC действительно сообщил; отсутствующие значения остаются пустыми."""
    generated = distinct = depth = None
    for item in items:
        if item.code in {STATS, PROGRESS_CODE} and (match := STATES.search(item.text)):
            generated, distinct = number(match.group(1)), number(match.group(2))
        if item.code == PROGRESS_CODE and (match := PROGRESS.search(item.text)):
            depth = max(number(match.group(1)) - 1, 0)
        if item.code == SEARCH_DEPTH and (match := DEPTH.search(item.text)):
            depth = max(number(match.group(1)) - 1, 0)
    if generated is not None and distinct is not None and distinct > generated:
        generated = distinct = None
    return CheckStatistics(states_generated=generated, distinct_states=distinct, depth=depth, elapsed_seconds=elapsed)


def read_states(path, spec):
    """Читает -dumpTrace json: состояния с исходными типами значений и точные имена действий."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        example = data["counterexample"]
        states, actions = example["state"], example.get("action") or []
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise TraceError(f"Контрпример TLC не прочитан: {error}") from error
    result = []
    for index, item in enumerate(states):
        if not isinstance(item, list) or len(item) != 2 or item[0] != index + 1 or not isinstance(item[1], dict):
            raise TraceError(f"Повреждён шаг {index} контрпримера TLC")
        if set(item[1]) != set(spec.variables):
            raise TraceError(f"Шаг {index} содержит неизвестные или неполные переменные")
        state = {spec.variables[name]: value for name, value in item[1].items()}
        if any(not isinstance(value, (bool, int, str)) for value in state.values()):
            raise TraceError(f"Шаг {index} содержит значение неподдерживаемого типа")
        transition = None
        if index:
            action = actions[index - 1] if index - 1 < len(actions) else None
            try:
                source, label, target = action
                name = label["name"]
            except (TypeError, ValueError, KeyError) as error:
                raise TraceError(f"Не указано действие шага {index}") from error
            if source[0] != index or target[0] != index + 1 or name not in spec.transitions:
                raise TraceError(f"Действие шага {index} не соответствует модели: {name}")
            transition = spec.transitions[name]
        result.append((transition, state))
    if not result:
        raise TraceError("Контрпример TLC пуст")
    return result


def build_trace(model, states):
    """Сверяет каждое состояние TLC с одним шагом семантики модели; при расхождении ничего не угадывает."""
    trace = []
    previous = None
    for index, (transition, state) in enumerate(states):
        for variable in model.variables:
            if not contains(variable.domain, state[variable.id]):
                raise TraceError(f"Шаг {index}: значение {variable.id} вне области")
        expected = initial_state(model) if index == 0 else step(model, previous, transition)
        if state != expected:
            raise TraceError(f"Шаг {index} контрпримера не совпадает с семантикой перехода {transition}")
        ordered = {variable.id: state[variable.id] for variable in model.variables}
        trace.append(TraceStep(number=index, transition_id=transition, state=ordered))
        previous = state
    return trace


def trace_changes(trace):
    """Изменённые переменные по шагам: удобно для журнала и объяснения."""
    changes = []
    for previous, current in zip(trace, trace[1:]):
        changes.append({
            "number": current.number, "transition_id": current.transition_id,
            "changed": {key: [previous.state[key], value] for key, value in current.state.items() if previous.state[key] != value},
        })
    return changes


def domain_violation(model, states):
    *_, (transition, state) = states
    broken = [
        f"{v.id}={state[v.id]!r}" for v in model.variables
        if v.id in state and not contains(v.domain, state[v.id])
    ]
    path = " → ".join(item for item, _ in states[1:]) or "начальное состояние"
    return f"переход {transition} выводит {', '.join(broken) or 'значение'} за область (путь: {path})"


def interpret(result, prop, model, spec, trace_path, limits):
    items = messages(result.stdout)
    stats = statistics(items, round(result.elapsed_seconds, 3))
    if result.stopped == "timeout":
        return Outcome("TIMEOUT", "Проверка остановлена по лимиту времени; исследование неполное", statistics=stats, reason="timeout")
    if result.stopped == "cancelled":
        return Outcome("ENGINE_ERROR", "CANCELLED: проверка остановлена по запросу; исследование неполное", statistics=stats, reason="cancelled")
    violated = [match.group(1) for item in items if item.code in {INVARIANT_INITIAL, INVARIANT_BEHAVIOR} and (match := VIOLATED.match(item.text))]
    errors = [item.text for item in items if item.severity == ERROR and item.code not in {INVARIANT_INITIAL, INVARIANT_BEHAVIOR, BEHAVIOR_HEADER}]
    if violated:
        name = violated[0]
        if result.returncode != EXIT_SAFETY_VIOLATION:
            return Outcome("ENGINE_ERROR", f"TLC сообщил о нарушении {name}, но завершился с кодом {result.returncode}", statistics=stats, reason="engine")
        try:
            states = read_states(trace_path, spec)
            if name == TYPE_OK:
                return Outcome("MODEL_INVALID", f"MODEL_INVALID: {domain_violation(model, states)}", statistics=stats, reason="domain")
            if name in {LIMIT_STATES, LIMIT_DEPTH}:
                limit = f"max_states={limits.max_states}" if name == LIMIT_STATES else f"max_depth={limits.max_depth}"
                return Outcome("STATE_LIMIT_REACHED", f"Достигнут лимит {limit}; исследование неполное", statistics=stats, reason=name)
            if name != spec.properties[prop.id]:
                raise TraceError(f"TLC нарушил неизвестный инвариант {name}")
            trace = build_trace(model, states)
        except TraceError as error:
            return Outcome("ENGINE_ERROR", f"Не удалось разобрать результат TLC: {error}", statistics=stats, reason="parse")
        if prop.kind == "reachable":
            return Outcome("PROPERTY_HOLDS", f"Цель достижима за {len(trace) - 1} шаг(ов)", trace, stats, "witness")
        return Outcome("PROPERTY_VIOLATED", f"Найдено нарушение за {len(trace) - 1} шаг(ов)", trace, stats, "counterexample")
    if errors:
        text = "; ".join(errors)[:2000]
        if "Overflow" in text:
            return Outcome("MODEL_INVALID", f"MODEL_INVALID: переполнение целого в TLC: {text}", statistics=stats, reason="overflow")
        return Outcome("ENGINE_ERROR", f"TLC сообщил об ошибке: {text}", statistics=stats, reason="engine")
    completed = any(item.code == SUCCESS and item.text.startswith(SUCCESS_TEXT) for item in items)
    if result.returncode == 0 and completed and stats.distinct_states is not None:
        explored = f"полностью исследовано {stats.distinct_states} различных состояний"
        if prop.kind == "reachable":
            return Outcome("PROPERTY_VIOLATED", f"Цель недостижима: {explored}", statistics=stats, reason="complete")
        return Outcome("PROPERTY_HOLDS", f"Свойство выполняется: {explored}", statistics=stats, reason="complete")
    tail = (result.stderr or result.stdout).strip()[-500:]
    return Outcome("ENGINE_ERROR", f"TLC завершился с кодом {result.returncode} без итогового сообщения: {tail}", statistics=stats, reason="engine")
