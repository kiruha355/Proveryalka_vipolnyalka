import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_path: Path = Path("data/proveryalka.sqlite3")
    artifacts_path: Path = Path("data/artifacts")
    java_path: str = "java"
    tla_jar: Path = Path("tools/tla2tools.jar")
    tlc_heap_mb: int = 512
    tlc_parallel: int = 2
    check_cache_path: Path | None = Path("data/check-cache")

    @classmethod
    def from_env(cls):
        cache = os.getenv("PROVERYALKA_CHECK_CACHE", "data/check-cache")
        return cls(
            database_path=Path(os.getenv("PROVERYALKA_DATABASE_PATH", "data/proveryalka.sqlite3")),
            artifacts_path=Path(os.getenv("PROVERYALKA_ARTIFACTS_PATH", "data/artifacts")),
            java_path=os.getenv("PROVERYALKA_JAVA", "java"),
            tla_jar=Path(os.getenv("PROVERYALKA_TLA_JAR", "tools/tla2tools.jar")),
            tlc_heap_mb=int(os.getenv("PROVERYALKA_TLC_HEAP_MB", "512")),
            tlc_parallel=int(os.getenv("PROVERYALKA_TLC_PARALLEL", "2")),
            check_cache_path=Path(cache) if cache else None,
        )
