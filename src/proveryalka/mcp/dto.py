"""Версионированные MCP DTO; не меняют HTTP/behavior contracts."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from ..verification.contracts import CheckLimits


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelSelector(Contract):
    model_id: StrictStr = Field(min_length=1, max_length=128)
    version_number: StrictInt = Field(ge=1)


class ModelRef(ModelSelector):
    version_id: StrictStr = Field(min_length=1, max_length=128)
    spec_hash: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")


class GetModel(Contract):
    contract_version: Literal["1.0"] = "1.0"
    model: ModelSelector


class MCPLimits(CheckLimits):
    timeout_seconds: float = Field(default=30.0, gt=0, le=60, strict=True, allow_inf_nan=False)
    max_states: StrictInt = Field(default=100_000, gt=0, le=100_000)
    max_depth: StrictInt | None = Field(default=None, ge=0, le=10_000)


class CheckBehavior(Contract):
    contract_version: Literal["1.0"] = "1.0"
    model: ModelRef
    property_ids: list[StrictStr] | None = Field(default=None, min_length=1, max_length=32)
    limits: MCPLimits = Field(default_factory=MCPLimits)


class GetTests(Contract):
    contract_version: Literal["1.0"] = "1.0"
    model: ModelRef
    generation_id: StrictStr = Field(min_length=1, max_length=128)
    code_hash: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")


class CompareWithCode(GetTests):
    # Значение вне stored_generation возвращает unsupported, а не предположение о соответствии.
    mode: StrictStr = Field(default="stored_generation", max_length=64)
    timeout_seconds: float = Field(default=120.0, gt=0, le=120, strict=True, allow_inf_nan=False)


class ToolResult(Contract):
    contract_version: Literal["1.0"] = "1.0"
    model_ref: ModelRef | None
    status: Literal["completed", "unsupported", "error"]
    data: dict = Field(default_factory=dict)
    error: dict | None = None
    limits: dict
