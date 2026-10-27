import json
import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from uuid import uuid4

from agents import ModelSettings, RunConfig, RunContextWrapper, Runner, Session, function_tool
from pydantic import Field, StrictInt, model_validator

from ..behavior import BehavioralModel
from ..behavior.expressions import Identifier
from ..contracts import Contract
from ..verification import BehaviorChecker, CheckLimits, VerificationReport, VerificationRequest, check_behavior
from ..verification.contracts import VerificationEvent
from ..verification.checker import make_request, spec_hash, validate_report
from .agent import create_agent
from .dialogue import load_dialogue
from .llm_config import create_client


class TraceComment(Contract):
    number: StrictInt = Field(ge=0)
    explanation: str = Field(min_length=1)


class PropertyExplanation(Contract):
    property_id: Identifier
    explanation: str = Field(min_length=1)
    steps: list[TraceComment]
    hypotheses: list[str] = Field(default_factory=list)


class VerificationNarrative(Contract):
    summary: str = Field(min_length=1)
    properties: list[PropertyExplanation] = Field(min_length=1)


class VerificationOutcome(Contract):
    request: VerificationRequest
    report: VerificationReport
    explanation: VerificationNarrative | None

    @model_validator(mode="after")
    def consistent(self):
        self.report = validate_report(self.request, self.report)
        if self.explanation is not None:
            validate_explanation(self.report, self.explanation)
        return self


@dataclass
class VerificationContext:
    request: VerificationRequest
    checker: BehaviorChecker | None
    report: VerificationReport | None = None
    started: bool = False
    check_id: str = ""
    on_event: Callable[[VerificationEvent], Awaitable[None]] | None = None


async def perform_check(context: VerificationContext) -> str:
    if context.started:
        raise ValueError("Проверка в этом запуске уже выполнена")
    context.started = True
    context.check_id = uuid4().hex
    async def emit(event, report=None, error=None):
        if context.on_event is not None:
            await context.on_event(VerificationEvent(
                event=event, check_id=context.check_id, version_id=context.request.version_id,
                spec_hash=spec_hash(context.request.model), property_ids=context.request.property_ids,
                report=report, error=error,
            ))
    await emit("tool_started")
    try:
        context.report = await check_behavior(
            context.request.model, context.checker, context.request.property_ids, context.request.limits,
            version_id=context.request.version_id,
        )
    except (Exception, asyncio.CancelledError) as error:
        await emit("tool_failed", error=type(error).__name__ + ": " + str(error))
        raise
    await emit("tool_finished", report=context.report)
    return context.report.model_dump_json()


@function_tool(
    name_override="check_behavior",
    description_override="Проверить выбранные свойства привязанной модели с заданными лимитами. Модель и свойства определены приложением и не изменяются инструментом.",
    failure_error_function=None,
)
async def check_behavior_tool(ctx: RunContextWrapper[VerificationContext]) -> str:
    return await perform_check(ctx.context)


def validate_explanation(report, narrative):
    known = {result.property_id: result for result in report.results}
    ids = [item.property_id for item in narrative.properties]
    if len(set(ids)) != len(ids) or set(ids) != set(known):
        raise ValueError("Объяснение относится к другим свойствам")
    for item in narrative.properties:
        expected = [step.number for step in known[item.property_id].trace]
        actual = [step.number for step in item.steps]
        if actual != expected:
            raise ValueError("Объяснение содержит неверные или пропущенные шаги трассы")


async def verify_and_explain(
    model: BehavioralModel,
    checker: BehaviorChecker | None = None,
    property_ids: list[str] | None = None,
    limits: CheckLimits | None = None,
    session: Session | None = None,
    *,
    version_id: str | None = None,
    on_event: Callable[[VerificationEvent], Awaitable[None]] | None = None,
) -> VerificationOutcome:
    request = make_request(model, property_ids, limits, version_id)
    snapshot = request.model
    if session is not None and any(source.session_id != session.session_id for source in snapshot.sources):
        raise ValueError("Модель относится к другой сессии")
    context = VerificationContext(request=request, checker=checker, on_event=on_event)
    explanation = None
    try:
        if checker is None:
            await perform_check(context)
        else:
            payload = {"verification_request": {
                "model_name": snapshot.name,
                "spec_hash": spec_hash(snapshot), "version_id": request.version_id,
                "limits": request.limits.model_dump(),
                "property_ids": request.property_ids,
                "variables": [{"id": v.id, "name": v.name} for v in snapshot.variables],
                "transitions": [t.model_dump() for t in snapshot.transitions],
                "properties": [p.model_dump() for p in snapshot.properties if p.id in request.property_ids],
                "requirements": [{"id": r.id, "text": r.text} for r in snapshot.requirements],
            }}
            async with create_client() as client:
                agent = create_agent(client).clone(
                    tools=[check_behavior_tool], output_type=VerificationNarrative,
                    model_settings=ModelSettings(store=False, tool_choice="required", parallel_tool_calls=False),
                )
                result = await Runner.run(
                    agent, input=json.dumps(payload, ensure_ascii=False), context=context,
                    max_turns=2, run_config=RunConfig(tracing_disabled=True),
                )
            if context.report is None:
                raise ValueError("Агент не вызвал проверяющий инструмент")
            validate_explanation(context.report, result.final_output)
            explanation = result.final_output
        return VerificationOutcome(request=request, report=context.report, explanation=explanation)
    finally:
        if session is not None and context.report is not None:
            saved = VerificationOutcome(request=request, report=context.report, explanation=explanation)
            await session.add_items([
                {"role": "user", "content": json.dumps({"verification_request": request.model_dump(mode="json")}, ensure_ascii=False)},
                {"role": "assistant", "content": json.dumps({"analyst_verification": saved.model_dump(mode="json")}, ensure_ascii=False)},
            ])


async def verify_dialogue(session: Session, checker: BehaviorChecker | None = None, property_ids=None, limits=None, *, version_id=None, on_event=None):
    state = await load_dialogue(session)
    if state is None or state.status != "ready" or state.analysis.behavior is None:
        raise ValueError("Для проверки нужна готовая модель без открытых вопросов")
    return await verify_and_explain(state.analysis.behavior, checker, property_ids, limits, session, version_id=version_id, on_event=on_event)


async def load_verification(session: Session) -> VerificationOutcome | None:
    for item in reversed(await session.get_items()):
        content = item.get("content")
        if item.get("role") == "assistant" and isinstance(content, str) and content.startswith('{"analyst_verification":'):
            return VerificationOutcome.model_validate(json.loads(content)["analyst_verification"])
    return None


STATUS_TEXT = {
    "PROPERTY_HOLDS": "Свойство выполнено в проверенной конечной модели",
    "PROPERTY_VIOLATED": "Свойство нарушено в проверенной конечной модели",
    "MODEL_INVALID": "Модель отклонена проверяющим ядром",
    "TIMEOUT": "Превышено время проверки; вывод о свойстве не получен",
    "STATE_LIMIT_REACHED": "Достигнут лимит состояний; вывод о свойстве не получен",
    "ENGINE_ERROR": "Ошибка проверки; вывод о свойстве не получен",
}


def render_verification(outcome: VerificationOutcome) -> str:
    report = outcome.report
    request = outcome.request
    validate_report(request, report)
    model = request.model
    properties = {item.id: item for item in model.properties}
    transitions = {item.id: item for item in model.transitions}
    requirements = {item.id: item for item in model.requirements}
    lines = [f"Модель: {model.name}. Хеш: {report.spec_hash}."]
    if request.version_id is not None:
        lines.append(f"Версия: {request.version_id}.")
    domains = "; ".join(f"{v.name}: {v.domain.model_dump_json()}" for v in model.variables)
    lines.append(f"Конечные области модели: {domains}.")
    lines.append(f"Лимиты проверки: {request.limits.model_dump_json()}.")
    lines.append("Вывод относится к этой конечной модели и выбранным свойствам; он не гарантирует корректность работающего приложения.")
    if report.mode == "test":
        lines.append("Тестовый адаптер: это проверка интеграции, а не результат TLC.")
    if not report.executed:
        lines.append("Проверяющее ядро не запускалось.")
    if report.engine is not None:
        lines.append(f"Движок: {report.engine.name}, версия {report.engine.version}.")
    explanations = {item.property_id: item for item in outcome.explanation.properties} if outcome.explanation else {}
    for result in report.results:
        label = f"тестовый ответ {result.status}" if report.mode == "test" else STATUS_TEXT[result.status]
        prop = properties[result.property_id]
        lines.append(f"{prop.name} ({result.property_id}): {label}.")
        lines.append(prop.explanation)
        lines.append(result.message)
        for identifier in result.related_requirements:
            requirement = requirements[identifier]
            lines.append(f"Требование {identifier}: {requirement.text}")
        if not result.conclusive:
            lines.append(NEXT_STEPS[result.status])
        stats = result.statistics.model_dump(exclude_none=True)
        if stats:
            lines.append(f"Статистика движка: {json.dumps(stats, ensure_ascii=False)}")
        if result.property_id in explanations:
            lines.append(explanations[result.property_id].explanation)
            for hypothesis in explanations[result.property_id].hypotheses:
                lines.append(f"Гипотеза, не установленный факт: {hypothesis}")
        for item in result.trace:
            transition = transitions[item.transition_id].name if item.transition_id is not None else "начальное состояние"
            lines.append(f"Шаг {item.number}, {transition}: {json.dumps(item.state, ensure_ascii=False)}")
            if item.number:
                before = result.trace[item.number - 1].state
                changes = {key: {"было": before[key], "стало": value} for key, value in item.state.items() if value != before[key]}
                lines.append(f"Изменения: {json.dumps(changes, ensure_ascii=False)}")
            if result.property_id in explanations:
                lines.append(explanations[result.property_id].steps[item.number].explanation)
    if outcome.explanation is not None:
        lines.append(outcome.explanation.summary)
    return "\n".join(lines)


NEXT_STEPS = {
    "MODEL_INVALID": "Исправьте указанные ошибки модели и запустите проверку заново.",
    "TIMEOUT": "Можно увеличить время проверки или согласовать меньшую модель; результат пока неизвестен.",
    "STATE_LIMIT_REACHED": "Можно увеличить лимит состояний или согласовать меньшие области модели; результат пока неизвестен.",
    "ENGINE_ERROR": "Проверьте подключение и диагностику движка, затем запустите проверку заново.",
}
