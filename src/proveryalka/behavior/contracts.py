from typing import Literal, Union

from pydantic import Field, StrictInt, StrictStr, model_validator

from ..contracts import Contract, ExtractedRequirement, Source, SourceRef
from .expressions import Expression, Identifier, Value


class BooleanDomain(Contract):
    kind: Literal["boolean"]


class IntegerDomain(Contract):
    kind: Literal["integer"]
    minimum: StrictInt
    maximum: StrictInt

    @model_validator(mode="after")
    def ordered(self):
        if self.minimum > self.maximum:
            raise ValueError("Нижняя граница области больше верхней")
        return self


class EnumDomain(Contract):
    kind: Literal["enum"]
    values: list[StrictStr] = Field(min_length=1)

    @model_validator(mode="after")
    def distinct(self):
        if len(set(self.values)) != len(self.values) or any(not item.strip() for item in self.values):
            raise ValueError("Значения enum должны быть непустыми и различимыми")
        return self


Domain = Union[BooleanDomain, IntegerDomain, EnumDomain]


class LinkedElement(Contract):
    id: Identifier
    name: str = Field(min_length=1)
    requirement_ids: list[str] = Field(min_length=1)


class Variable(LinkedElement):
    domain: Domain
    initial_value: Value


class Assignment(Contract):
    variable: Identifier
    value: Expression


class Transition(LinkedElement):
    guard: Expression
    effects: list[Assignment]


class Property(LinkedElement):
    kind: Literal["invariant", "forbidden_state", "reachable", "deadlock_free"]
    predicate: Expression
    explanation: str = Field(min_length=1)
    origin: Literal["requirement", "proposal"] = "requirement"
    approved_by: SourceRef | None = None


class BehavioralModel(Contract):
    schema_version: Literal["1.0"]
    name: str = Field(min_length=1)
    sources: list[Source] = Field(min_length=1)
    requirements: list[ExtractedRequirement]
    variables: list[Variable] = Field(min_length=1)
    transitions: list[Transition]
    properties: list[Property]

    @model_validator(mode="after")
    def consistent(self):
        from .validation import validate_model

        validate_model(self)
        return self
