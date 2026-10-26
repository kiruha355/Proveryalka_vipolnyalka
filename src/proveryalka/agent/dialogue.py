import json
from uuid import uuid4

from agents import ModelSettings, RunConfig, Runner, Session

from ..contracts import Source
from .agent import create_agent
from .clarification import DialogueDraft, DialogueState, build_state
from .llm_config import create_client


async def load_dialogue(session: Session) -> DialogueState | None:
    for item in reversed(await session.get_items()):
        content = item.get("content")
        if item.get("role") == "assistant" and isinstance(content, str) and content.startswith('{"analyst_dialogue":'):
            return DialogueState.model_validate(json.loads(content)["analyst_dialogue"])
    return None


async def advance(
    source: Source,
    session: Session,
    previous: DialogueState | None,
    question_id: str | None,
    max_rounds: int,
) -> DialogueState:
    sources = previous.sources + [source] if previous else [source]
    payload = {
        "sources": [item.model_dump() for item in sources],
        "previous": previous.model_dump(include={"analysis", "questions"}) if previous else None,
        "answer_to_question_id": question_id,
    }
    async with create_client() as client:
        agent = create_agent(client).clone(output_type=DialogueDraft)
        result = await Runner.run(
            agent,
            input=json.dumps(payload, ensure_ascii=False),
            max_turns=1,
            run_config=RunConfig(tracing_disabled=True, model_settings=ModelSettings(store=False)),
        )
    state = build_state(sources, result.final_output, previous, question_id, max_rounds)
    await session.add_items([
        {"role": "user", "content": source.text},
        {"role": "assistant", "content": json.dumps({"analyst_dialogue": state.model_dump(mode="json")}, ensure_ascii=False)},
    ])
    return state


async def start_dialogue(source: Source, session: Session, max_rounds: int = 5) -> DialogueState:
    if source.session_id != session.session_id:
        raise ValueError("Источник относится к другому диалогу")
    if not source.text.strip() or not 1 <= max_rounds <= 10:
        raise ValueError("Нужен исходный текст и лимит от 1 до 10 раундов")
    if await load_dialogue(session) is not None:
        raise ValueError("Диалог уже начат")
    return await advance(source, session, None, None, max_rounds)


async def reply_dialogue(session: Session, message: str, question_id: str | None = None) -> DialogueState:
    state = await load_dialogue(session)
    if state is None:
        raise ValueError("Диалог ещё не начат")
    if not message.strip():
        raise ValueError("Ответ не должен быть пустым")
    if state.status == "limit_reached":
        raise ValueError("Достигнут лимит уточняющих раундов")
    if question_id and question_id not in {item.id for item in state.pending_questions}:
        raise ValueError("Вопрос не найден среди открытых")
    source = Source(id="answer_" + uuid4().hex, session_id=session.session_id, text=message)
    return await advance(source, session, state, question_id, state.max_rounds)
