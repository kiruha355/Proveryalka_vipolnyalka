import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_path: Path = Path("data/proveryalka.sqlite3")
    artifacts_path: Path = Path("data/artifacts")

    @classmethod
    def from_env(cls):
        return cls(
            database_path=Path(os.getenv("PROVERYALKA_DATABASE_PATH", "data/proveryalka.sqlite3")),
            artifacts_path=Path(os.getenv("PROVERYALKA_ARTIFACTS_PATH", "data/artifacts")),
        )
