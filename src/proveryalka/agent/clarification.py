from typing import Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import Field

from ..contracts import Contract, Source, SourceRef
from .analysis import (
    Analysis, ExtractedRequirement, ExtractionDraft, assemble_analysis, reference,
    requirement_id, validate_quotes, validate_requirement_ids,
)
from .formalization import semantics


class QuestionDraft(Contract):
    text: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    kind: Literal["missing", "conflict", "assumption"]
    assumption: str | None


class Question(QuestionDraft):
    id: str
    status: Literal["open", "answered", "confirmed", "rejected"] = "open"
    answer_source_id: str | None = None


class Resolution(Contract):
    question_id: str
    decision: Literal["answered", "confirmed", "rejected"]
    quote: str = Field(min_length=1)


class Correction(Contract):
    requirement_id: str
    reason: str = Field(min_length=1)
    quote: str = Field(min_length=1)


class DialogueDraft(Contract):
    analysis: ExtractionDraft
    questions: list[QuestionDraft] = Field(max_length=3)
    resolutions: list[Resolution]
    corrections: list[Correction]


class Answer(Contract):
    source_id: str
    question_id: str | None


class AppliedCorrection(Correction):
    answer_source_id: str


class DialogueState(Contract):
    schema_version: Literal["2.0"] = "2.0"
    sources: list[Source]
    analysis: Analysis
    questions: list[Question]
    answers: list[Answer]
    corrections: list[AppliedCorrection]
    property_approvals: dict[str, SourceRef] = Field(default_factory=dict)
    round: int
    max_rounds: int
    status: Literal["needs_clarification", "model_incomplete", "ready", "limit_reached"]

    @property
    def pending_questions(self) -> list[Question]:
        return [question for question in self.questions if question.status == "open"]


def update_questions(questions, draft, answer, selected_id):
    questions = {question.id: question.model_copy(deep=True) for question in questions}
    resolved = set()
    for resolution in draft.resolutions:
        question = questions.get(resolution.question_id)
        if question is None or question.id in resolved:
            raise ValueError("Недопустимое разрешение вопроса")
        if question.status != "open" or (selected_id and question.id != selected_id):
            raise ValueError("Ответ относится к другому или закрытому вопросу")
        if (question.kind == "assumption") != (resolution.decision in {"confirmed", "rejected"}):
            raise ValueError("Предположение требует подтверждения или отклонения")
        reference(answer, resolution.quote)
        question.status = resolution.decision
        question.answer_source_id = answer.id
        resolved.add(question.id)
    return questions


def new_questions(questions, proposals, analysis, source_id):
    assumptions = {item.text for item in analysis.assumptions}
    for proposed in proposals:
        text = proposed.text.strip().casefold().rstrip("?. ")
        if not text:
            raise ValueError("Вопрос не должен быть пустым")
        identifier = "q_" + uuid5(NAMESPACE_URL, f"{source_id}\0{text}").hex
        if identifier in questions:
            raise ValueError("Вопрос уже был задан")
        if (proposed.kind == "assumption") != (proposed.assumption is not None):
            raise ValueError("Для подтверждения нужно указать предположение")
        if proposed.assumption is not None and proposed.assumption not in assumptions:
            raise ValueError("Подтверждаемое предположение отсутствует в анализе")
        questions[identifier] = Question(**proposed.model_dump(), id=identifier)
    return list(questions.values())


def build_requirements(facts, previous, sources, corrections):
    sources_by_id = {source.id: source for source in sources}
    answer = sources[-1]
    requirements = []
    retained = set()
    for fact in facts:
        if fact.source_id not in sources_by_id:
            raise ValueError("Требование ссылается на неизвестный источник")
        if fact.previous_id is not None and fact.previous_id not in previous:
            raise ValueError("Неизвестное прежнее требование")
        if fact.previous_id is not None and fact.previous_id in retained:
            raise ValueError("Прежнее требование указано несколько раз")
        retained.add(fact.previous_id)
        old = previous.get(fact.previous_id)
        correction = corrections.get(fact.previous_id)
        if old and old.text != fact.text and not correction:
            raise ValueError("Изменение требования должно быть явно отмечено")
        identity_source = answer.id if correction else fact.source_id
        identifier = old.id if old and not correction else requirement_id(identity_source, fact.quote)
        if identifier in previous and fact.previous_id is None:
            raise ValueError("Для прежнего требования нужно указать previous_id")
        refs = list(old.source_refs) if old else []
        refs.append(reference(sources_by_id[fact.source_id], fact.quote))
        if correction:
            refs.append(reference(answer, correction.quote))
        unique_refs = {(ref.source_id, ref.start, ref.end): ref for ref in refs}
        requirements.append(ExtractedRequirement(
            id=identifier, text=fact.text, source_refs=list(unique_refs.values()),
        ))
    if set(previous) - retained - set(corrections):
        raise ValueError("Требование удалено без явной корректировки")
    validate_requirement_ids(requirements)
    return requirements


def resolve_properties(draft, previous, questions, answer):
    approvals = dict(previous.property_approvals) if previous else {}
    dismissed = set()
    previous_properties = {prop.id: prop for prop in previous.analysis.properties} if previous else {}
    for prop in draft.analysis.properties:
        old = previous_properties.get(prop.id)
        if old is not None and (old.origin, old.assumption) != (prop.origin, prop.assumption):
            raise ValueError("Нельзя менять происхождение предложенного свойства")
        if old is not None and prop.id in approvals and semantics(old) != semantics(prop):
            raise ValueError("Изменённое предложенное свойство нужно согласовать заново с новым ID")
        if prop.origin == "requirement":
            if prop.assumption is not None:
                raise ValueError("Исходное свойство не должно содержать предположение")
            continue
        matching = [q for q in questions if q.kind == "assumption" and q.assumption == prop.assumption]
        if not prop.assumption or len(matching) != 1 or matching[0].status == "rejected":
            raise ValueError("Предложенное свойство требует отдельного согласования")
        question = matching[0]
        if question.status == "confirmed":
            resolution = next((r for r in draft.resolutions if r.question_id == question.id), None)
            if resolution is not None:
                approvals[prop.id] = reference(answer, resolution.quote)
            elif prop.id not in approvals:
                raise ValueError("Не сохранено подтверждение предложенного свойства")
    if previous is not None:
        for prop in previous.analysis.properties:
            if prop.origin == "proposal" and any(q.assumption == prop.assumption and q.status == "rejected" for q in questions):
                dismissed.add(prop.id)
    return approvals, dismissed


def build_state(
    sources: list[Source],
    draft: DialogueDraft,
    previous: DialogueState | None,
    question_id: str | None,
    max_rounds: int,
) -> DialogueState:
    validate_quotes(draft.analysis, sources)
    answer = sources[-1]
    old_requirements = {item.id: item for item in previous.analysis.requirements} if previous else {}
    corrections = {item.requirement_id: item for item in draft.corrections}
    if len(corrections) != len(draft.corrections) or set(corrections) - set(old_requirements):
        raise ValueError("Исправляется неизвестное или повторное требование")
    for correction in corrections.values():
        reference(answer, correction.quote)
    requirements = build_requirements(draft.analysis.requirements, old_requirements, sources, corrections)
    questions = update_questions(previous.questions if previous else [], draft, answer, question_id)
    questions = new_questions(questions, draft.questions, draft.analysis, sources[0].id)
    pending = [question for question in questions if question.status == "open"]
    approvals, dismissed = resolve_properties(draft, previous, questions, answer)
    analysis = assemble_analysis(
        sources, draft.analysis, requirements, pending=pending,
        previous=previous.analysis if previous else None,
        approvals=approvals, dismissed=dismissed,
    )
    if len(pending) > 3:
        raise ValueError("Одновременно можно задать не более трёх вопросов")
    if not pending and (analysis.contradictions or analysis.assumptions):
        raise ValueError("Неразрешённые сведения требуют уточняющего вопроса")
    round_number = previous.round + 1 if previous else 0
    status = "ready" if analysis.behavior is not None else "model_incomplete"
    if pending:
        status = "limit_reached" if round_number >= max_rounds else "needs_clarification"
    return DialogueState(
        sources=sources,
        analysis=analysis,
        questions=questions,
        answers=previous.answers + [Answer(source_id=answer.id, question_id=question_id)] if previous else [],
        corrections=(previous.corrections if previous else []) + [
            AppliedCorrection(**item.model_dump(), answer_source_id=answer.id)
            for item in corrections.values()
        ],
        property_approvals={prop.id: approvals[prop.id] for prop in draft.analysis.properties if prop.id in approvals},
        round=round_number,
        max_rounds=max_rounds,
        status=status,
    )
