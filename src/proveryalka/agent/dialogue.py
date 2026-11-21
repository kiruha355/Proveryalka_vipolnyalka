import asyncio
import json
from uuid import uuid4

from agents import ModelBehaviorError, ModelSettings, RunConfig, Session
from pydantic import ValidationError

from ..contracts import Contract, Source
from ..behavior import BehavioralModel
from .agent import create_agent
from .clarification import DialogueDraft, DialogueState, build_state
from .llm_config import create_client
from .errors import check_context, run_agent
from .activity import activity
from .formalization import semantics


def find_dialogue(items) -> DialogueState | None:
    version_id = None
    for item in reversed(items):
        content = item.get("content")
        if item.get("role") != "assistant" or not isinstance(content, str):
            continue
        if content.startswith('{"analyst_version":'):
            version_id = json.loads(content)["analyst_version"]
        if content.startswith('{"analyst_dialogue":'):
            state = json.loads(content)["analyst_dialogue"]
            if state.get("schema_version") != "2.0":
                raise ValueError("Диалог использует прежний текстовый формат модели. Начните новую сессию; история сохранена.")
            return DialogueState.model_validate({**state, **({"base_version_id": version_id} if version_id else {})})
    return None


async def load_dialogue(session: Session) -> DialogueState | None:
    return find_dialogue(await session.get_items())


class GenerationError(Exception):
    code = "MODEL_OUTPUT_INVALID"

    def __init__(self, attempts: int, diagnostics: str):
        self.attempts = attempts
        self.diagnostics = diagnostics
        super().__init__(f"Модель не прошла валидацию за {attempts} попытки: {diagnostics}")


class PendingTurn(Contract):
    source: Source
    question_id: str | None
    max_rounds: int
    run_id: str | None = None
    attached: bool = False
    attachment: Source | None = None
    base_version_id: str | None = None
    base_model: BehavioralModel | None = None
    impact: dict | None = None


def find_pending(items) -> PendingTurn | None:
    for item in reversed(items):
        content = item.get("content")
        if item.get("role") != "assistant" or not isinstance(content, str):
            continue
        if content.startswith('{"analyst_dialogue":') or content.startswith('{"analyst_pending_cancelled":'):
            return None
        if content.startswith('{"analyst_pending":'):
            return PendingTurn.model_validate(json.loads(content)["analyst_pending"])
    return None


async def load_pending(session: Session) -> PendingTurn | None:
    return find_pending(await session.get_items())


async def generate_state(payload, sources, previous, question_id, max_rounds, max_attempts=2):
    if not 1 <= max_attempts <= 3:
        raise ValueError("Допустимо от одной до трёх попыток генерации")
    repair = None
    async with create_client() as client:
        agent = create_agent(client).clone(output_type=DialogueDraft)
        for attempt in range(1, max_attempts + 1):
            candidate = None
            data = {**payload, "validation_feedback": repair}
            if attempt > 1:
                await activity("retry", attempt=attempt, purpose="analysis")
            try:
                await activity("model_request", attempt=attempt, purpose="analysis")
                result = await run_agent(
                    agent, input=json.dumps(data, ensure_ascii=False), max_turns=1,
                    run_config=RunConfig(tracing_disabled=True, model_settings=ModelSettings(store=False)),
                )
                await activity("model_response", attempt=attempt, purpose="analysis")
                candidate = result.final_output
            except (ModelBehaviorError, ValidationError) as error:
                diagnostic = str(error)
            else:
                try:
                    if payload.get("turn_kind") == "attachment" and (candidate.corrections or candidate.resolutions):
                        raise ValueError("Источник не может подтверждать ответы и изменения за пользователя")
                    if payload.get("impact_review") and previous:
                        if candidate.corrections:
                            raise ValueError("Получите отдельное подтверждение для изменения действующего правила")
                        properties = {prop.id: semantics(prop) for prop in candidate.analysis.properties}
                        for old in previous.analysis.properties:
                            if properties.get(old.id) != semantics(old):
                                raise ValueError(f"Сохраните действующее свойство {old.id} до согласования его изменения")
                    observations = payload.get("image_observations", {})
                    image_question_source = None
                    if observations:
                        from ..images.evidence import validate_observations
                        image_question_source = validate_observations(candidate, sources, observations)
                    image_ranges = {key: observation["visible_ranges"] for key, observation in observations.items()}
                    state = build_state(sources, candidate, previous, question_id, max_rounds, image_ranges, image_question_source)
                    await activity("validation", attempt=attempt, outcome="passed")
                    return state
                except ValueError as error:
                    diagnostic = str(error)
            await activity("validation", attempt=attempt, outcome="failed")
            repair = {"error": diagnostic, "rejected_draft": candidate.model_dump(mode="json") if candidate else None}
        raise GenerationError(attempt, diagnostic)


async def advance(
    source: Source,
    session: Session,
    question_id: str | None,
    max_rounds: int,
    run_id: str | None = None,
    *,
    attached: bool = False,
    attachment: Source | None = None,
    base: tuple[str, BehavioralModel] | None = None,
    impact: dict | None = None,
) -> DialogueState:
    check_context(source.text)
    pending = PendingTurn(source=source, question_id=question_id, max_rounds=max_rounds, run_id=run_id,
                          attached=attached, attachment=attachment, base_version_id=base[0] if base else None,
                          base_model=base[1] if base else None, impact=impact)
    await session.add_items([
        {"role": "user", "content": source.text},
        {"role": "assistant", "content": json.dumps({"analyst_pending": pending.model_dump(mode="json")}, ensure_ascii=False)},
    ])
    return await resume_pending(session)


async def resume_pending(session: Session) -> DialogueState:
    pending = await load_pending(session)
    if pending is None:
        raise ValueError("Нет незавершённого сообщения")
    previous = await load_dialogue(session)
    if pending.base_model is not None:
        if previous is None or (previous.base_version_id != pending.base_version_id
                                and previous.analysis.behavior != pending.base_model):
            from .baseline import version_state
            previous = version_state(pending.base_model, pending.base_version_id, pending.max_rounds)
        elif previous.base_version_id != pending.base_version_id:
            previous = previous.model_copy(update={"base_version_id": pending.base_version_id})
    source = pending.source
    sources = list(previous.sources) if previous else []
    if pending.attachment and all(item.id != pending.attachment.id for item in sources):
        sources.append(pending.attachment)
    sources.append(source)
    payload = {
        "sources": [item.model_dump() for item in sources],
        "previous": previous.model_dump(
            include={"analysis", "questions"},
            exclude={"analysis": {"behavior", "model_issues", "missing_information"}},
        ) if previous else None,
        "answer_to_question_id": pending.question_id,
    }
    if pending.attached:
        payload["turn_kind"] = "attachment"
    if pending.attachment:
        payload["attached_source_id"] = pending.attachment.id
    if pending.impact:
        payload["impact_review"] = pending.impact
    if previous is not None and previous.analysis.behavior is not None:
        from ..verification import spec_hash
        from .verification import load_verification

        checked = await load_verification(session)
        # Только отчёт проверки именно текущей модели; объяснение может ещё отсутствовать.
        if checked is not None and checked.report.spec_hash == spec_hash(previous.analysis.behavior):
            payload["verification_context"] = {
                "question": checked.explanation.question if checked.explanation else None,
                "report": checked.report.model_dump(mode="json"),
                "explanation": checked.explanation.model_dump(mode="json", exclude={"question"}) if checked.explanation else None,
            }
    from ..storage.session import StoredSession
    if isinstance(session, StoredSession):
        observations = await session.image_observations(sources)
        if observations:
            payload["image_observations"] = observations
    check_context(payload)
    await activity("context_ready", source_id=source.id, sources_count=len(sources), purpose="analysis")
    state = await generate_state(payload, sources, previous, pending.question_id, pending.max_rounds)
    if await load_pending(session) != pending:
        raise asyncio.CancelledError()
    await session.add_items([{"role": "assistant", "content": json.dumps({"analyst_dialogue": state.model_dump(mode="json")}, ensure_ascii=False)}])
    return state


async def cancel_pending(session: Session) -> None:
    if await load_pending(session) is None:
        raise ValueError("Нет незавершённого сообщения")
    await session.add_items([{"role": "assistant", "content": json.dumps({"analyst_pending_cancelled": True})}])


async def start_dialogue(source: Source, session: Session, max_rounds: int = 5, *, run_id: str | None = None) -> DialogueState:
    if source.session_id != session.session_id:
        raise ValueError("Источник относится к другому диалогу")
    if not source.text.strip() or not 1 <= max_rounds <= 10:
        raise ValueError("Нужен исходный текст и лимит от 1 до 10 раундов")
    if await load_dialogue(session) is not None:
        raise ValueError("Диалог уже начат")
    if await load_pending(session) is not None:
        raise ValueError("Есть незавершённое сообщение: продолжите или отмените его")
    return await advance(source, session, None, max_rounds, run_id)


async def reply_dialogue(session: Session, message: str, question_id: str | None = None, *,
                         run_id: str | None = None, base=None, attachment: Source | None = None, impact=None) -> DialogueState:
    if await load_pending(session) is not None:
        raise ValueError("Есть незавершённое сообщение: продолжите или отмените его")
    state = await load_dialogue(session)
    if state is None and base is None:
        raise ValueError("Диалог ещё не начат")
    if not message.strip():
        raise ValueError("Ответ не должен быть пустым")
    if state and state.status == "limit_reached" and (base is None or state.base_version_id == base[0]):
        raise ValueError("Достигнут лимит уточняющих раундов")
    if question_id and (state is None or question_id not in {item.id for item in state.pending_questions}):
        raise ValueError("Вопрос не найден среди открытых")
    source = Source(id="answer_" + uuid4().hex, session_id=session.session_id, text=message)
    return await advance(source, session, question_id, state.max_rounds if state else 5, run_id,
                         attachment=attachment, base=base, impact=impact)


async def attach_source(session: Session, source: Source, *, run_id: str | None = None, base=None) -> DialogueState:
    if source.session_id != session.session_id:
        raise ValueError("Источник относится к другому диалогу")
    state = await load_dialogue(session)
    return await advance(source, session, None, state.max_rounds if state else 5, run_id, attached=True, base=base)
