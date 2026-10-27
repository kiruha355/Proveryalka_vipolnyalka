import asyncio
import hashlib
import json
from typing import Protocol

from ..behavior import BehavioralModel, evaluate, initial_state, step
from ..behavior.runtime import validate_state
from .contracts import CheckLimits, VerificationReport, VerificationRequest, VerificationResult


class BehaviorChecker(Protocol):
    async def check(self, request: VerificationRequest) -> VerificationReport: ...


class CheckerError(Exception):
    pass


def spec_hash(model: BehavioralModel) -> str:
    data = json.dumps(model.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def incomplete_report(request, status, message, executed):
    return VerificationReport(
        results=[VerificationResult(
            spec_hash=spec_hash(request.model), mode="engine", executed=executed,
            version_id=request.version_id,
            engine=None, limits=request.limits, property_id=identifier,
            status=status, conclusive=False, message=message,
        )
                 for identifier in request.property_ids],
    )


def validate_trace(model, prop, result, limits):
    initial = initial_state(model)
    initial_predicate = evaluate(prop.predicate, initial)
    if result.status == "PROPERTY_HOLDS":
        if (prop.kind == "invariant" and not initial_predicate) or (prop.kind == "forbidden_state" and initial_predicate):
            raise ValueError("Окончательный результат противоречит начальному состоянию")
        if prop.kind == "deadlock_free" and not initial_predicate and not any(evaluate(t.guard, initial) for t in model.transitions):
            raise ValueError("Начальное состояние является недопустимым тупиком")
    if result.status == "PROPERTY_VIOLATED" and prop.kind == "reachable" and initial_predicate:
        raise ValueError("Цель уже достижима в начальном состоянии")
    needs_trace = (result.status == "PROPERTY_VIOLATED" and prop.kind != "reachable") or (result.status == "PROPERTY_HOLDS" and prop.kind == "reachable")
    if not needs_trace:
        if result.trace:
            raise ValueError("Трасса не соответствует результату свойства")
        return
    if not result.trace:
        raise ValueError("Для этого результата нужна трасса")
    if limits.max_depth is not None and len(result.trace) - 1 > limits.max_depth:
        raise ValueError("Трасса превышает заданную глубину")
    previous = initial
    for index, item in enumerate(result.trace):
        if item.number != index or (item.transition_id is None) != (index == 0):
            raise ValueError("Нарушены номера шагов или ссылка на переход")
        validate_state(model, item.state)
        expected = previous if index == 0 else step(model, previous, item.transition_id)
        if item.state != expected:
            raise ValueError("Состояние трассы не соответствует переходу модели")
        previous = item.state
    predicate = evaluate(prop.predicate, previous)
    if prop.kind == "invariant" and predicate:
        raise ValueError("Конечное состояние не нарушает инвариант")
    if prop.kind in {"forbidden_state", "reachable"} and not predicate:
        raise ValueError("Конечное состояние не удовлетворяет предикату")
    if prop.kind == "deadlock_free" and (predicate or any(evaluate(t.guard, previous) for t in model.transitions)):
        raise ValueError("Трасса не заканчивается недопустимым тупиком")


def validate_report(request: VerificationRequest, report: VerificationReport) -> VerificationReport:
    if report.spec_hash != spec_hash(request.model) or report.limits != request.limits or report.version_id != request.version_id:
        raise ValueError("Результат относится к другой модели или лимитам")
    if {item.property_id for item in report.results} != set(request.property_ids):
        raise ValueError("Результат не соответствует выбранным свойствам")
    properties = {prop.id: prop for prop in request.model.properties}
    transitions = {transition.id: transition for transition in request.model.transitions}
    results = {result.property_id: result for result in report.results}
    bound = []
    for identifier in request.property_ids:
        result = results[identifier]
        prop = properties[result.property_id]
        validate_trace(request.model, prop, result, request.limits)
        related = set(prop.requirement_ids)
        for item in result.trace[1:]:
            related.update(transitions[item.transition_id].requirement_ids)
        bound.append(result.model_copy(update={"related_requirements": [r.id for r in request.model.requirements if r.id in related]}))
    return report.model_copy(update={"results": bound})


def make_request(model, property_ids=None, limits=None, version_id=None):
    request = VerificationRequest(
        model=model,
        version_id=version_id,
        property_ids=property_ids if property_ids is not None else [prop.id for prop in model.properties],
        limits=limits if limits is not None else CheckLimits(),
    )
    return VerificationRequest.model_validate_json(request.model_dump_json())


async def check_behavior(
    model: BehavioralModel,
    checker: BehaviorChecker | None = None,
    property_ids: list[str] | None = None,
    limits: CheckLimits | None = None,
    *,
    version_id: str | None = None,
) -> VerificationReport:
    request = make_request(model, property_ids, limits, version_id)
    request_snapshot = request.model_dump_json()
    if checker is None:
        report = incomplete_report(request, "ENGINE_ERROR", "CHECKER_UNAVAILABLE: проверяющее ядро не подключено, проверка не запускалась", False)
    else:
        try:
            report = await asyncio.wait_for(checker.check(request), timeout=request.limits.timeout_seconds)
        except TimeoutError:
            report = incomplete_report(request, "TIMEOUT", "Проверяющий адаптер не вернул результат за отведённое время", True)
        except CheckerError as error:
            report = incomplete_report(request, "ENGINE_ERROR", str(error), True)
    if request.model_dump_json() != request_snapshot:
        raise ValueError("Адаптер изменил переданный запрос")
    report = VerificationReport.model_validate_json(report.model_dump_json())
    return validate_report(request, report)
