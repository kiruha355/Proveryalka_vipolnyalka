from typing import Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import Field

from ..behavior.contracts import Assignment, BehavioralModel, Domain, LinkedElement
from ..behavior.expressions import Expression, Value
from ..contracts import Contract, ExtractedRequirement, Source, SourceRef


class Fact(Contract):
    text: str = Field(min_length=1)
    quote: str = Field(min_length=1)


class RequirementDraft(Fact):
    source_id: str
    previous_id: str | None


class Variable(LinkedElement):
    domain: Domain | None
    initial_value: Value | None
    quote: str = Field(min_length=1)


class Event(LinkedElement):
    guard: Expression | None
    effects: list[Assignment] | None
    quote: str = Field(min_length=1)


class Property(LinkedElement):
    kind: Literal["invariant", "forbidden_state", "reachable", "deadlock_free"]
    predicate: Expression | None
    quote: str = Field(min_length=1)
    explanation: str = Field(min_length=1)
    origin: Literal["requirement", "proposal"] = "requirement"
    assumption: str | None = None


class Assumption(Fact):
    reason: str


class Contradiction(Contract):
    description: str
    quotes: list[str] = Field(min_length=2)


class ExtractionDraft(Contract):
    subject: str | None
    requirements: list[RequirementDraft]
    entities: list[Fact]
    participants: list[Fact]
    variables: list[Variable]
    initial_state: list[Fact]
    events: list[Event]
    properties: list[Property]
    assumptions: list[Assumption]
    contradictions: list[Contradiction]


class ModelIssue(Contract):
    path: str
    message: str


class Analysis(ExtractionDraft):
    source: Source
    requirements: list[ExtractedRequirement]
    missing_information: list[str] = Field(default_factory=list)
    behavior: BehavioralModel | None = None
    model_issues: list[ModelIssue] = Field(default_factory=list)


def requirement_id(source_id: str, quote: str) -> str:
    return "req_" + uuid5(NAMESPACE_URL, f"{source_id}\0{quote}").hex


def reference(source: Source, quote: str) -> SourceRef:
    if not quote.strip() or quote not in source.text:
        raise ValueError("Цитата отсутствует в исходном тексте")
    start = source.text.index(quote)
    return SourceRef(source_id=source.id, quote=quote, start=start, end=start + len(quote))


def validate_quotes(draft: ExtractionDraft, sources: list[Source]) -> None:
    facts = [
        *draft.entities, *draft.participants, *draft.variables,
        *draft.initial_state, *draft.events, *draft.properties, *draft.assumptions,
    ]
    quotes = [fact.quote for fact in facts] + [
        quote for conflict in draft.contradictions for quote in conflict.quotes
    ]
    for quote in quotes:
        if not quote.strip() or not any(quote in source.text for source in sources):
            raise ValueError("Цитата отсутствует в исходном тексте")


def validate_requirement_ids(requirements: list[ExtractedRequirement]) -> None:
    if len({item.id for item in requirements}) != len(requirements):
        raise ValueError("Требования должны иметь различимые исходные фрагменты")


def build_analysis(source: Source, draft: ExtractionDraft) -> Analysis:
    validate_quotes(draft, [source])
    requirements = []
    for fact in draft.requirements:
        if fact.source_id != source.id or fact.previous_id is not None:
            raise ValueError("Требование ссылается на неизвестный источник или прежнее требование")
        requirements.append(ExtractedRequirement(
            id=requirement_id(source.id, fact.quote),
            text=fact.text,
            source_refs=[reference(source, fact.quote)],
        ))
    validate_requirement_ids(requirements)
    return assemble_analysis([source], draft, requirements)


def assemble_analysis(sources, draft, requirements, pending=(), previous=None, approvals=None, dismissed=()):
    from .formalization import formalize

    data, behavior, issues = formalize(draft, requirements, sources, bool(pending), previous, approvals, dismissed)
    return Analysis(
        **data, requirements=requirements, source=sources[0], behavior=behavior,
        model_issues=issues, missing_information=[question.text for question in pending],
    )
