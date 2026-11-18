import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_path: Path = Path("data/proveryalka.sqlite3")
    artifacts_path: Path = Path("data/artifacts")
    max_pending_runs: int = 32
    agent_parallel: int = 2
    check_parallel: int = 2
    agent_timeout_seconds: float = 630.0
    max_input_chars: int = 100_000
    java_path: str = "java"
    tla_jar: Path = Path("tools/tla2tools.jar")
    tlc_heap_mb: int = 512
    tlc_parallel: int = 2
    check_cache_path: Path | None = Path("data/check-cache")

    def __post_init__(self):
        if min(self.max_pending_runs, self.agent_parallel, self.check_parallel, self.max_input_chars, self.tlc_heap_mb, self.tlc_parallel) < 1 or not 0 < self.agent_timeout_seconds <= 3600:
            raise ValueError("Resource limits must be positive and agent timeout <= 3600")

    @classmethod
    def from_env(cls):
        cache = os.getenv("PROVERYALKA_CHECK_CACHE", "data/check-cache")
        return cls(
            max_pending_runs=int(os.getenv("PROVERYALKA_MAX_PENDING_RUNS", "32")),
            agent_parallel=int(os.getenv("PROVERYALKA_AGENT_PARALLEL", "2")),
            check_parallel=int(os.getenv("PROVERYALKA_CHECK_PARALLEL", "2")),
            agent_timeout_seconds=float(os.getenv("PROVERYALKA_AGENT_TIMEOUT", "630")),
            max_input_chars=int(os.getenv("PROVERYALKA_MAX_INPUT_CHARS", "100000")),
            database_path=Path(os.getenv("PROVERYALKA_DATABASE_PATH", "data/proveryalka.sqlite3")),
            artifacts_path=Path(os.getenv("PROVERYALKA_ARTIFACTS_PATH", "data/artifacts")),
            java_path=os.getenv("PROVERYALKA_JAVA", "java"),
            tla_jar=Path(os.getenv("PROVERYALKA_TLA_JAR", "tools/tla2tools.jar")),
            tlc_heap_mb=int(os.getenv("PROVERYALKA_TLC_HEAP_MB", "512")),
            tlc_parallel=int(os.getenv("PROVERYALKA_TLC_PARALLEL", "2")),
            check_cache_path=Path(cache) if cache else None,
        )
