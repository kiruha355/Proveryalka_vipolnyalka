from uuid import NAMESPACE_URL, uuid5

from pydantic import Field

from ..contracts import Contract, Source


class Fact(Contract):
    text: str = Field(min_length=1)
    quote: str = Field(min_length=1)


class RequirementDraft(Fact):
    source_id: str
    previous_id: str | None


class Variable(Contract):
    name: str
    domain: str | None
    initial_value: str | None
    quote: str = Field(min_length=1)


class Event(Contract):
    name: str
    guard: str | None
    effects: list[str]
    quote: str = Field(min_length=1)


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
    assumptions: list[Assumption]
    missing_information: list[str]
    contradictions: list[Contradiction]


class SourceRef(Contract):
    source_id: str
    quote: str
    start: int
    end: int


class ExtractedRequirement(Contract):
    id: str
    text: str
    source_refs: list[SourceRef]


class Analysis(ExtractionDraft):
    source: Source
    requirements: list[ExtractedRequirement]


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
        *draft.initial_state, *draft.events, *draft.assumptions,
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
    return Analysis(**{**draft.model_dump(), "requirements": requirements}, source=source)
