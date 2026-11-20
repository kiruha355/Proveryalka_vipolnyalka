"""HTTP DTO генерации кода и запусков тестов. Неизвестные значения — null, а не ноль."""
from typing import Literal, Optional

from pydantic import Field, StrictBool, StrictFloat, StrictInt, StrictStr

from ..contracts import Contract


VerificationState = Literal["holds", "violated", "inconclusive", "not_checked"]
TestRunStatus = Literal["queued", "running", "passed", "failed", "timeout", "engine_unavailable", "cancelled", "error"]


class TechnicalConditionsInput(Contract):
    language: StrictStr | None = Field(None, max_length=64)
    platform: StrictStr | None = Field(None, max_length=64)
    api_prefix: StrictStr | None = Field(None, max_length=64)
    storage: StrictStr | None = Field(None, max_length=64)
    integrations: list[StrictStr] | None = Field(None, max_length=16)


class GenerationCreate(Contract):
    target: Literal["python-fastapi"] = "python-fastapi"
    # Нужен, если TLC не подтвердил все свойства версии: violated, inconclusive или not_checked.
    allow_unverified: StrictBool = False
    technical_conditions: TechnicalConditionsInput | None = None
    application_mode: Literal["template", "agent"] = "template"


class TestRunCreate(Contract):
    __test__ = False  # не тестовый класс для pytest

    timeout_seconds: Optional[StrictFloat | StrictInt] = Field(default=None, gt=0, le=1800)


class CandidateAdapter(Contract):
    kind: Literal["fastapi-evaluate-v1"]
    module: StrictStr = Field(max_length=128, pattern=r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
    api_prefix: StrictStr = Field(max_length=64, pattern=r"^(?:/[A-Za-z0-9_-]+)*$")


class SnapshotCandidate(Contract):
    snapshot_id: StrictStr = Field(min_length=1, max_length=128)
    manifest_sha256: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    adapter: CandidateAdapter


class ComparisonCreate(SnapshotCandidate):
    timeout_seconds: Optional[StrictFloat | StrictInt] = Field(default=None, gt=0, le=1800)
    reference_code_hash: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")


class ComparisonDifference(Contract):
    scenario_id: str
    transition_id: str | None
    requirement_ids: list[str]
    message: str | None


class CandidateComparison(Contract):
    status: Literal["pending", "matches", "mismatch", "incompatible_adapter", "execution_error"]
    snapshot_id: str
    commit_sha: str
    manifest_sha256: str
    reference_code_hash: str
    code_hash: str
    tests_hash: str
    adapter: CandidateAdapter
    differences: list[ComparisonDifference]


class FileElement(Contract):
    kind: Literal["requirement", "variable", "transition"]
    id: str
    name: str
    requirement_ids: list[str]
    start_line: int
    end_line: int


class GeneratedFileEntry(Contract):
    path: str
    size: int
    sha256: str
    role: Literal["source", "test", "test_data", "config", "doc", "model", "manifest"]
    media_type: str
    explanation: str
    requirement_ids: list[str]
    elements: list[FileElement]


class PropertyVerification(Contract):
    property_id: str
    status: Optional[str]
    check_run_id: Optional[str]


class Verification(Contract):
    state: VerificationState
    acknowledged: bool
    properties: list[PropertyVerification]


class Coverage(Contract):
    reachable_states: int
    exhaustive: bool
    boundary_states: int
    conformance_cases: int
    invalid_state_cases: int
    trace_replays: int


class GeneratorInfo(Contract):
    name: str
    version: str


class Generation(Contract):
    generation_id: str
    session_id: str
    model_id: str
    version_id: str
    version_number: int
    spec_hash: str
    code_hash: str
    status: Literal["completed"]
    target: str
    generator: GeneratorInfo
    technical_conditions: dict[str, str | list[str]]
    application_mode: Literal["template", "agent"] = "template"
    project_name: str
    verification: Verification
    coverage: Coverage
    file_count: int
    total_bytes: int
    created_at: str
    files: list[GeneratedFileEntry]


class TestCounts(Contract):
    __test__ = False  # не тестовый класс для pytest

    total: Optional[int]
    passed: Optional[int]
    failed: Optional[int]
    errors: Optional[int]
    skipped: Optional[int]


class TestCase(Contract):
    __test__ = False  # не тестовый класс для pytest

    name: str
    classname: str
    outcome: Literal["passed", "failed", "error", "skipped"]
    duration_seconds: Optional[float]
    message: Optional[str]


class SandboxInfo(Contract):
    engine: str
    image: str
    network: str
    read_only_root: bool
    user: str
    capabilities: list[str]
    no_new_privileges: bool
    memory_mb: int
    swap_mb: int
    cpus: float
    pids_limit: int
    tmpfs_mb: int
    project_mount: str
    engine_version: Optional[str] = None
    image_id: Optional[str] = None
    container_exit_code: Optional[int] = None
    oom_killed: Optional[bool] = None


class TestRun(Contract):
    __test__ = False  # не тестовый класс для pytest

    test_run_id: str
    generation_id: str
    session_id: str
    version_id: str
    spec_hash: str
    code_hash: str
    status: TestRunStatus
    error_code: Optional[str]
    message: Optional[str]
    cancel_requested: bool
    timeout_seconds: float
    created_at: str
    started_at: Optional[str]
    finished_at: Optional[str]
    duration_seconds: Optional[float]
    exit_code: Optional[int]
    counts: TestCounts
    cases: list[TestCase]
    sandbox: Optional[SandboxInfo]
    log_available: bool
    log_truncated: Optional[bool]
    comparison: CandidateComparison | None = None


class CodegenStatus(Contract):
    target: str
    generator: GeneratorInfo
    technical_conditions: dict[str, str]
    supported_conditions: dict[str, list[str]]
    limits: dict[str, StrictInt]
    sandbox_status: Literal["ready", "engine_unavailable"]
    sandbox_reason: Optional[str]
    sandbox: SandboxInfo
    default_timeout_seconds: float
    max_timeout_seconds: float
