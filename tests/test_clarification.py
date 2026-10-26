import asyncio
import json
from types import SimpleNamespace

import pytest

from proveryalka.agent import dialogue
from proveryalka.agent.clarification import DialogueDraft, build_state
from proveryalka.contracts import Source
from proveryalka.storage.session import StoredSession
from proveryalka.storage.sqlite import SQLiteStore


def draft(requirements, questions=(), resolutions=(), corrections=(), assumptions=()):
    return DialogueDraft.model_validate({
        "analysis": {
            "subject": "Запись", "requirements": [
                {"source_id": "source1", "previous_id": None, **item} for item in requirements
            ],
            "entities": [], "participants": [], "variables": [],
            "initial_state": [], "events": [], "assumptions": assumptions,
            "missing_information": [], "contradictions": [],
        },
        "questions": list(questions), "resolutions": list(resolutions), "corrections": list(corrections),
    })


def question(text="После отмены время освобождается?", assumption=None):
    return {"text": text, "reason": "Определяет результат отмены", "kind": "assumption" if assumption else "missing", "assumption": assumption}


@pytest.fixture
def source():
    return Source(id="source1", session_id="session1", text="Запись можно отменить.")


def test_answer_closes_question_and_keeps_original_evidence(source):
    original = {"text": source.text, "quote": source.text}
    first = build_state([source], draft([original], [question()]), None, None, 5)
    original = {**original, "previous_id": first.analysis.requirements[0].id}
    answer = Source(id="answer1", session_id=source.session_id, text="При отмене время освобождается.")
    updated = draft([original, {"text": answer.text, "quote": answer.text, "source_id": answer.id}], resolutions=[{
        "question_id": first.questions[0].id, "decision": "answered", "quote": answer.text,
    }])
    second = build_state([source, answer], updated, first, first.questions[0].id, 5)
    assert second.status == "ready"
    assert not second.pending_questions
    assert second.analysis.requirements[0] == first.analysis.requirements[0]
    assert second.analysis.requirements[1].source_refs[0].source_id == answer.id
    assert second.answers[0].question_id == first.questions[0].id
    assert second.questions[0].answer_source_id == answer.id


@pytest.mark.parametrize("decision,answer_text", [("confirmed", "Да, подтверждаю."), ("rejected", "Нет, не надо.")])
def test_assumption_requires_explicit_decision_and_is_not_left_pending(source, decision, answer_text):
    proposal = "При отмене время освобождается"
    first = build_state([source], draft([], [question(assumption=proposal)], assumptions=[{
        "text": proposal, "quote": source.text, "reason": "Предложенная интерпретация",
    }]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text=answer_text)
    facts = [{"text": proposal, "quote": answer_text, "source_id": answer.id}] if decision == "confirmed" else []
    second = build_state([source, answer], draft(facts, resolutions=[{
        "question_id": first.questions[0].id, "decision": decision, "quote": answer_text,
    }]), first, first.questions[0].id, 5)
    assert second.questions[0].status == decision
    assert not second.analysis.assumptions
    assert bool(second.analysis.requirements) == (decision == "confirmed")


def test_unrelated_question_and_repeated_question_are_rejected(source):
    first = build_state([source], draft([], [question(), question("Кто отменяет запись?")]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text="Да.")
    unrelated = draft([], resolutions=[{"question_id": first.questions[1].id, "decision": "answered", "quote": "Да."}])
    with pytest.raises(ValueError, match="другому"):
        build_state([source, answer], unrelated, first, first.questions[0].id, 5)
    with pytest.raises(ValueError, match="уже был задан"):
        build_state([source, answer], draft([], [question()]), first, None, 5)


def test_correction_keeps_old_source_and_new_identity_across_next_turn(source):
    original = {"text": source.text, "quote": source.text}
    first = build_state([source], draft([original]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text="Исправляю: запись нельзя отменить.")
    correction = {"requirement_id": first.analysis.requirements[0].id, "reason": "Пользователь заменил правило", "quote": answer.text}
    revised = {"text": "Запись нельзя отменить.", "quote": source.text, "previous_id": first.analysis.requirements[0].id}
    second = build_state([source, answer], draft([revised], corrections=[correction]), first, None, 5)
    revised = {**revised, "previous_id": second.analysis.requirements[0].id}
    next_answer = Source(id="answer2", session_id=source.session_id, text="Других изменений нет.")
    third = build_state([source, answer, next_answer], draft([revised]), second, None, 5)
    assert second.analysis.requirements[0].id != first.analysis.requirements[0].id
    assert third.analysis.requirements == second.analysis.requirements
    assert {ref.source_id for ref in third.analysis.requirements[0].source_refs} == {source.id, answer.id}
    assert third.corrections[0].answer_source_id == answer.id
    assert third.sources[0].text == source.text


def test_original_requirement_cannot_disappear_without_correction(source):
    first = build_state([source], draft([{"text": source.text, "quote": source.text}]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text="Привет.")
    with pytest.raises(ValueError, match="удалено"):
        build_state([source, answer], draft([]), first, None, 5)


def test_correction_cannot_reuse_old_identity_without_previous_id(source):
    first = build_state([source], draft([{"text": source.text, "quote": source.text}]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text="Исправляю: запись нельзя отменить.")
    replacement = draft([{"text": "Запись нельзя отменить.", "quote": source.text}], corrections=[{
        "requirement_id": first.analysis.requirements[0].id,
        "reason": "Пользователь заменил правило", "quote": answer.text,
    }])
    with pytest.raises(ValueError, match="previous_id"):
        build_state([source, answer], replacement, first, None, 5)


def test_llm_links_requirement_by_id_with_another_supporting_quote():
    source = Source(id="source1", session_id="session1", text="Запись можно отменить. Доступна отмена записи.")
    first = build_state([source], draft([{
        "text": "Запись можно отменить", "quote": "Запись можно отменить.",
    }]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text="Да, это то же самое правило.")
    second = build_state([source, answer], draft([{
        "text": "Запись можно отменить", "quote": "Доступна отмена записи.",
        "previous_id": first.analysis.requirements[0].id,
    }]), first, None, 5)
    assert second.analysis.requirements[0].id == first.analysis.requirements[0].id
    assert second.analysis.requirements[0].text == "Запись можно отменить"
    assert len(second.analysis.requirements[0].source_refs) == 2
    assert not second.corrections


@pytest.mark.parametrize("link", [
    {"source_id": "unknown"},
    {"previous_id": "unknown"},
])
def test_unknown_links_are_rejected_without_searching_for_a_replacement(source, link):
    with pytest.raises(ValueError, match="неизвестный источник|Неизвестное прежнее"):
        build_state([source], draft([{"text": source.text, "quote": source.text, **link}]), None, None, 5)


@pytest.mark.parametrize("text", ["Запись нельзя отменить.", "Запись можно отме��ить."])
def test_requirement_text_cannot_change_without_explicit_correction(source, text):
    first = build_state([source], draft([{"text": source.text, "quote": source.text}]), None, None, 5)
    answer = Source(id="answer1", session_id=source.session_id, text="Других изменений нет.")
    revised = draft([{
        "text": text, "quote": source.text,
        "previous_id": first.analysis.requirements[0].id,
    }])
    with pytest.raises(ValueError, match="Изменение требования"):
        build_state([source, answer], revised, first, None, 5)


@pytest.mark.parametrize("field,value", [
    ("missing_information", ["После отмены время освобождается?"]),
    ("assumptions", [{"text": "При отмене время освобождается", "quote": "Запись можно отменить.", "reason": "Нужно подтвердить"}]),
    ("contradictions", [{"description": "Правила несовместимы", "quotes": ["Запись можно отменить.", "Запись можно отменить."]}]),
])
def test_unresolved_information_cannot_be_ready_without_a_question(source, field, value):
    result = draft([])
    result.analysis = result.analysis.model_validate({**result.analysis.model_dump(), field: value})
    with pytest.raises(ValueError, match="Неразрешённые сведения"):
        build_state([source], result, None, None, 5)


def test_identical_short_answers_to_different_questions_keep_separate_sources(source):
    first = build_state([source], draft([], [question(), question("Сохранять историю отмен?")]), None, None, 5)
    answer1 = Source(id="answer1", session_id=source.session_id, text="Да.")
    rule1 = {"text": "При отмене время освобождается.", "quote": "Да.", "source_id": answer1.id}
    second = build_state([source, answer1], draft([rule1], resolutions=[{
        "question_id": first.questions[0].id, "decision": "answered", "quote": "Да.",
    }]), first, first.questions[0].id, 5)
    rule1 = {**rule1, "previous_id": second.analysis.requirements[0].id}
    answer2 = Source(id="answer2", session_id=source.session_id, text="Да.")
    rule2 = {"text": "История отмен сохраняется.", "quote": "Да.", "source_id": answer2.id}
    third = build_state([source, answer1, answer2], draft([rule1, rule2], resolutions=[{
        "question_id": first.questions[1].id, "decision": "answered", "quote": "Да.",
    }]), second, first.questions[1].id, 5)
    assert third.status == "ready"
    assert [item.source_refs[0].source_id for item in third.analysis.requirements] == [answer1.id, answer2.id]
    assert len({item.id for item in third.analysis.requirements}) == 2


def test_sqlite_resume_answer_and_round_limit_without_duplicate_history(tmp_path, monkeypatch):
    store = SQLiteStore(tmp_path / "dialogue.sqlite3")
    store.initialize()
    session_id = store.create_session({"title": "Запись"}, "session")["id"]
    source = Source(id="source1", session_id=session_id, text="Запись можно отменить.")
    outputs = [draft([], [question()]), draft([])]
    calls = []

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    async def run(agent, **kwargs):
        calls.append(json.loads(kwargs["input"]))
        result = outputs.pop(0)
        return SimpleNamespace(final_output=result)

    monkeypatch.setattr(dialogue, "create_client", Client)
    monkeypatch.setattr(dialogue, "create_agent", lambda client: SimpleNamespace(clone=lambda **kwargs: object()))
    monkeypatch.setattr(dialogue.Runner, "run", run)

    async def scenario():
        session = StoredSession(store, session_id)
        first = await dialogue.start_dialogue(source, session, max_rounds=1)
        restarted = SQLiteStore(store.path)
        restarted.initialize()
        resumed = StoredSession(restarted, session_id)
        assert await dialogue.load_dialogue(resumed) == first
        second = await dialogue.reply_dialogue(resumed, "Пока не знаю.", first.pending_questions[0].id)
        assert second.status == "limit_reached"
        assert second.questions[0].status == "open"
        assert len(await resumed.get_items()) == 4
        with pytest.raises(ValueError, match="лимит"):
            await dialogue.reply_dialogue(resumed, "Да.")
        assert len(await resumed.get_items()) == 4
        assert len(calls) == 2
        other_id = store.create_session({"title": "Другой"}, "other")["id"]
        assert await dialogue.load_dialogue(StoredSession(store, other_id)) is None

    asyncio.run(scenario())


def test_provider_failure_does_not_write_partial_turn(tmp_path, monkeypatch):
    store = SQLiteStore(tmp_path / "failure.sqlite3")
    store.initialize()
    session_id = store.create_session({"title": "Сбой"}, "session")["id"]
    session = StoredSession(store, session_id)

    def failed_client():
        raise RuntimeError("provider failed")

    monkeypatch.setattr(dialogue, "create_client", failed_client)

    async def scenario():
        with pytest.raises(RuntimeError, match="provider failed"):
            await dialogue.start_dialogue(Source(id="source1", session_id=session_id, text="Запись можно отменить."), session)
        assert await session.get_items() == []

    asyncio.run(scenario())
