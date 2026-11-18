from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr


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


class SessionDetail(Session):
    messages: list[Message] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    requirements: list[Requirement] = Field(default_factory=list)


class MessageCreate(Contract):
    text: StrictStr = Field(min_length=1, max_length=100_000)


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
    ]
    data: dict[str, Any]
