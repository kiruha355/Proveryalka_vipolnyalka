"""HTTP DTO генерации кода и запусков тестов. Неизвестные значения — null, а не ноль."""
from typing import Literal, Optional

from pydantic import Field, StrictBool, StrictFloat, StrictInt

from ..contracts import Contract


VerificationState = Literal["holds", "violated", "inconclusive", "not_checked"]
TestRunStatus = Literal["queued", "running", "passed", "failed", "timeout", "engine_unavailable", "cancelled", "error"]


class GenerationCreate(Contract):
    target: Literal["python-fastapi"] = "python-fastapi"
    # Нужен, если TLC не подтвердил все свойства версии: violated, inconclusive или not_checked.
    allow_unverified: StrictBool = False


class TestRunCreate(Contract):
    __test__ = False  # не тестовый класс для pytest

    timeout_seconds: Optional[StrictFloat | StrictInt] = Field(default=None, gt=0, le=1800)


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
    technical_conditions: dict[str, str]
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


class CodegenStatus(Contract):
    target: str
    generator: GeneratorInfo
    technical_conditions: dict[str, str]
    limits: dict[str, StrictInt]
    sandbox_status: Literal["ready", "engine_unavailable"]
    sandbox_reason: Optional[str]
    sandbox: SandboxInfo
    default_timeout_seconds: float
    max_timeout_seconds: float
