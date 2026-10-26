import asyncio

import pytest
from pydantic import ValidationError

from proveryalka.agent.analysis import ExtractionDraft, Fact, build_analysis
from proveryalka.agent.extraction import extract_requirements
from proveryalka.contracts import Source


def requirement(text, quote, source_id="src1"):
    return {"text": text, "quote": quote, "source_id": source_id, "previous_id": None}


@pytest.fixture
def draft():
    return {
        "subject": "Заявка",
        "requirements": [],
        "entities": [],
        "participants": [],
        "variables": [],
        "initial_state": [],
        "events": [],
        "assumptions": [],
        "missing_information": [],
        "contradictions": [],
    }


def test_evidence_offsets_match_original_russian_text(draft):
    source = Source(id="src1", session_id="s1", text="  Заявку можно отменить.\nПри отмене согласование сохраняется.")
    draft["requirements"] = [requirement("Отмена сохраняет согласование", "При отмене согласование сохраняется.")]
    result = build_analysis(source, ExtractionDraft(**draft))
    reference = result.requirements[0].source_refs[0]
    assert source.text[reference.start:reference.end] == reference.quote
    assert reference.source_id == source.id
    assert result.source.text == source.text


def test_requirement_identity_survives_reordering_and_paraphrasing(draft):
    source = Source(id="src1", session_id="s1", text="Заявку можно согласовать. Заявку можно отменить.")
    draft["requirements"] = [
        requirement("Согласование заявки", "Заявку можно согласовать."),
        requirement("Отмена заявки", "Заявку можно отменить."),
    ]
    first = build_analysis(source, ExtractionDraft(**draft))
    draft["requirements"] = [
        requirement("Доступна отмена", "Заявку можно отменить."),
        requirement("Доступно согласование", "Заявку можно согласовать."),
    ]
    second = build_analysis(source, ExtractionDraft(**draft))
    assert {r.source_refs[0].quote: r.id for r in first.requirements} == {
        r.source_refs[0].quote: r.id for r in second.requirements
    }
    draft["requirements"] = [{**item, "source_id": "src2"} for item in draft["requirements"]]
    another = build_analysis(source.model_copy(update={"id": "src2"}), ExtractionDraft(**draft))
    assert {r.id for r in second.requirements}.isdisjoint(r.id for r in another.requirements)


@pytest.mark.parametrize("section,item", [
    ("requirements", requirement("Правило", "Придуманная цитата")),
    ("entities", {"text": "Объект", "quote": "Придуманная цитата"}),
    ("participants", {"text": "Участник", "quote": "Придуманная цитата"}),
    ("variables", {"name": "status", "domain": None, "initial_value": None, "quote": "Придуманная цитата"}),
    ("initial_state", {"text": "Начальное состояние", "quote": "Придуманная цитата"}),
    ("events", {"name": "Cancel", "guard": None, "effects": [], "quote": "Придуманная цитата"}),
    ("assumptions", {"text": "Предположение", "reason": "Причина", "quote": "Придуманная цитата"}),
    ("contradictions", {"description": "Конфликт", "quotes": ["Заявку можно отменить.", "Придуманная цитата"]}),
])
def test_invented_evidence_is_rejected_in_every_section(draft, section, item):
    source = Source(id="src1", session_id="s1", text="Заявку можно отменить.")
    draft[section] = [item]
    with pytest.raises(ValueError, match="Цитата отсутствует"):
        build_analysis(source, ExtractionDraft(**draft))


def test_ambiguous_requirement_identity_is_rejected(draft):
    source = Source(id="src1", session_id="s1", text="Заявку можно отменить.")
    draft["requirements"] = [
        requirement("Первое правило", source.text),
        requirement("Другое правило", source.text),
    ]
    with pytest.raises(ValueError, match="различимые исходные фрагменты"):
        build_analysis(source, ExtractionDraft(**draft))


def test_unknown_fields_are_not_silently_accepted():
    with pytest.raises(ValidationError):
        Fact(text="Правило", quote="Источник", verified=True)


def test_blank_source_does_not_call_provider(monkeypatch):
    def unexpected_client():
        pytest.fail("Провайдер не должен вызываться для пустого текста")

    monkeypatch.setattr("proveryalka.agent.extraction.create_client", unexpected_client)
    with pytest.raises(ValueError, match="пустым"):
        asyncio.run(extract_requirements(Source(id="src1", session_id="s1", text=" \n ")))
