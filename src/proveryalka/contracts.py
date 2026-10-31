from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionCreate(Contract):
    title: StrictStr = Field(min_length=1, max_length=200)
    mode: Literal["analyzer", "debugger", "overview", "codegen"] = "analyzer"


class Session(SessionCreate):
    id: str
    created_at: datetime


class Message(Contract):
    id: str
    session_id: str
    sequence: int = Field(ge=1)
    message_data: dict[str, Any]
    created_at: datetime


class Requirement(Contract):
    id: str
    session_id: str
    source_id: str
    code: str
    text: str


class Source(Contract):
    id: str
    session_id: str
    kind: Literal["text"] = "text"
    text: str


class SourceRef(Contract):
    source_id: str
    quote: str = Field(min_length=1)
    start: StrictInt = Field(ge=0)
    end: StrictInt = Field(ge=1)


class ExtractedRequirement(Contract):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    source_refs: list[SourceRef] = Field(min_length=1)


class DocumentInfo(Contract):
    source_id: str
    filename: str
    format: Literal["txt", "md", "docx"]
    media_type: str
    size_bytes: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    characters: int = Field(ge=1)


class DocumentUpload(Contract):
    source: Source
    document: DocumentInfo


class SessionDetail(Session):
    messages: list[Message] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    requirements: list[Requirement] = Field(default_factory=list)
    documents: list[DocumentInfo] = Field(default_factory=list)


class MessageCreate(Contract):
    """Текст сообщения либо ID сохранённого источника для начала разбора.

    question_id адресует ответ одному открытому вопросу; без него ответ относится к диалогу целиком.
    """
    text: Optional[StrictStr] = Field(default=None, min_length=1, max_length=100_000)
    question_id: Optional[StrictStr] = Field(default=None, min_length=1, max_length=200)
    source_id: Optional[StrictStr] = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def one_input(self):
        if (self.text is None) == (self.source_id is None):
            raise ValueError("Нужен ровно один вход: text или source_id")
        if self.question_id is not None and self.text is None:
            raise ValueError("question_id допустим только с text")
        return self


class TextSourceCreate(Contract):
    text: StrictStr = Field(min_length=1, max_length=100_000)
    requirements: list[StrictStr] = Field(default_factory=list, max_length=1000)


class Run(Contract):
    run_id: str
    session_id: str
    state: Literal["queued", "running", "cancelling", "cancelled", "completed", "failed"]
    version_id: Optional[str] = None
    error_code: Optional[str] = None


class CheckCreate(Contract):
    property_ids: Optional[list[StrictStr]] = Field(default=None, min_length=1, max_length=1000)
    # После сохранения отчёта TLC поставить объяснение этого отчёта в очередь (LLM).
    explain: StrictBool = False


class ExplanationCreate(Contract):
    pass


class ErrorDetail(Contract):
    code: str
    message: str
    details: list[dict[str, Any]] = Field(default_factory=list)


class ErrorResponse(Contract):
    error: ErrorDetail


class Event(Contract):
    event_id: int = Field(ge=1)
    run_id: str
    session_id: str
    type: Literal[
        "message_delta", "tool_call", "clarification_requested", "model_proposed",
        "check_started", "check_finished", "file_written", "run_finished", "error",
        "dialogue_updated", "explanation_queued", "explanation_started", "explanation_ready",
    ]
    data: dict[str, Any]


class PendingView(Contract):
    source_id: str
    text: str
    question_id: Optional[str]
    run_id: Optional[str]
    # Состояние запуска, начавшего ход: running — ход ещё выполняется, failed/cancelled — можно повторить или отказаться.
    run_state: Optional[str]


class ModelRef(Contract):
    model_id: str
    version_id: str
    number: int
    spec_hash: str


class DialogueEntry(Contract):
    id: str
    sequence: int
    created_at: str
    kind: Literal["user", "assistant"]
    text: str
    source_id: Optional[str] = None
    question_id: Optional[str] = None
    status: Optional[Literal["processed", "pending", "discarded"]] = None
    questions: list[dict[str, Any]] = Field(default_factory=list)


class DialogueView(Contract):
    entries: list[DialogueEntry] = Field(default_factory=list)
    session_id: str
    status: Literal["not_started", "needs_clarification", "model_incomplete", "ready", "limit_reached"]
    round: Optional[int] = None
    max_rounds: Optional[int] = None
    reply: Optional[str] = None
    requirements: list[dict[str, Any]] = Field(default_factory=list)
    questions: list[dict[str, Any]] = Field(default_factory=list)
    open_question_ids: list[str] = Field(default_factory=list)
    corrections: list[dict[str, Any]] = Field(default_factory=list)
    analysis: Optional[dict[str, Any]] = None
    model: Optional[ModelRef] = None
    pending: Optional[PendingView] = None


class ExplanationView(Contract):
    state: Literal["not_requested", "queued", "running", "ready", "failed", "cancelled"]
    run_id: Optional[str] = None
    error_code: Optional[str] = None
    narrative: Optional[dict[str, Any]] = None
