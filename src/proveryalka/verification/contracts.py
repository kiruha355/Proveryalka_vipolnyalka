from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictFloat, StrictInt, model_validator

from ..behavior import BehavioralModel
from ..behavior.expressions import Identifier, Value
from ..contracts import Contract


VerificationStatus = Literal[
    "PROPERTY_HOLDS", "PROPERTY_VIOLATED", "MODEL_INVALID",
    "TIMEOUT", "STATE_LIMIT_REACHED", "ENGINE_ERROR",
]
ElapsedSeconds = Annotated[StrictFloat, Field(ge=0, allow_inf_nan=False)]


# TLC сравнивает лимиты как 32-битные целые; глубина в спецификации записывается как max_depth + 1.
TLC_MAX_INT = 2_147_483_647


class CheckLimits(Contract):
    timeout_seconds: StrictFloat = Field(default=30.0, gt=0, le=3600)
    max_states: StrictInt = Field(default=100_000, gt=0, le=TLC_MAX_INT)
    max_depth: StrictInt | None = Field(default=None, ge=0, le=TLC_MAX_INT - 1)


class VerificationRequest(Contract):
    schema_version: Literal["1.0"] = "1.0"
    model: BehavioralModel
    version_id: str | None = Field(default=None, min_length=1)
    property_ids: list[Identifier] = Field(min_length=1)
    limits: CheckLimits = Field(default_factory=CheckLimits)

    @model_validator(mode="after")
    def valid_selection(self):
        ids = {prop.id for prop in self.model.properties}
        if len(set(self.property_ids)) != len(self.property_ids) or set(self.property_ids) - ids:
            raise ValueError("Нужно выбрать существующие неповторяющиеся свойства")
        return self


class EngineInfo(Contract):
    name: str = Field(min_length=1)
    version: str = Field(min_length=1)


class CheckStatistics(Contract):
    states_generated: StrictInt | None = Field(default=None, ge=0)
    distinct_states: StrictInt | None = Field(default=None, ge=0)
    depth: StrictInt | None = Field(default=None, ge=0)
    elapsed_seconds: ElapsedSeconds | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.states_generated is not None and self.distinct_states is not None and self.distinct_states > self.states_generated:
            raise ValueError("Число различных состояний больше числа сгенерированных")
        return self


class TraceStep(Contract):
    number: StrictInt = Field(ge=0)
    transition_id: Identifier | None
    state: dict[str, Value]


class VerificationMetadata(Contract):
    schema_version: Literal["1.0"] = "1.0"
    spec_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    version_id: str | None = Field(default=None, min_length=1)
    mode: Literal["engine", "test"]
    executed: StrictBool
    engine: EngineInfo | None
    limits: CheckLimits


class VerificationResult(VerificationMetadata):
    property_id: Identifier
    status: VerificationStatus
    conclusive: StrictBool
    message: str = Field(min_length=1)
    trace: list[TraceStep] = Field(default_factory=list)
    statistics: CheckStatistics = Field(default_factory=CheckStatistics)
    related_requirements: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def consistent(self):
        definitive = self.status in {"PROPERTY_HOLDS", "PROPERTY_VIOLATED"}
        if self.conclusive != definitive:
            raise ValueError("Только завершённая проверка даёт окончательный результат свойства")
        if not definitive and self.trace:
            raise ValueError("Незавершённая проверка не содержит доказательной трассы")
        if definitive and (not self.executed or self.engine is None):
            raise ValueError("Окончательный результат требует выполненной проверки и сведений о движке")
        if not self.executed and self.engine is not None:
            raise ValueError("Невыполненной проверке нельзя приписывать движок")
        if not self.executed and self.status not in {"ENGINE_ERROR", "MODEL_INVALID"}:
            raise ValueError("Статус требует фактического вызова проверяющего адаптера")
        return self


class VerificationReport(Contract):
    schema_version: Literal["1.0"] = "1.0"
    results: list[VerificationResult] = Field(min_length=1)

    @property
    def spec_hash(self):
        return self.results[0].spec_hash

    @property
    def version_id(self):
        return self.results[0].version_id

    @property
    def mode(self):
        return self.results[0].mode

    @property
    def executed(self):
        return self.results[0].executed

    @property
    def engine(self):
        return self.results[0].engine

    @property
    def limits(self):
        return self.results[0].limits

    @model_validator(mode="after")
    def consistent(self):
        ids = [result.property_id for result in self.results]
        if len(set(ids)) != len(ids):
            raise ValueError("Свойство проверено несколько раз в одном отчёте")
        fields = set(VerificationMetadata.model_fields)
        first = self.results[0].model_dump(include=fields)
        if any(result.model_dump(include=fields) != first for result in self.results[1:]):
            raise ValueError("В одном отчёте смешаны разные модели, движки или лимиты")
        return self


class VerificationEvent(Contract):
    event: Literal["tool_started", "tool_finished", "tool_failed"]
    check_id: str
    version_id: str | None
    spec_hash: str
    property_ids: list[str]
    report: VerificationReport | None = None
    error: str | None = None
