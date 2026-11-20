import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path


IMAGE_DIR = Path(__file__).with_name("sandbox_image")
IMAGE_FILES = ("Dockerfile", "requirements.lock", "runner.py")
IMAGE_REPOSITORY = "proveryalka-codegen-sandbox"


def image_definition_hash():
    digest = hashlib.sha256()
    for name in IMAGE_FILES:
        data = (IMAGE_DIR / name).read_bytes()
        digest.update(f"{name}\0{len(data)}\0".encode())
        digest.update(data)
    return digest.hexdigest()


def default_image():
    """Тег привязан к содержимому определения образа: изменённый Dockerfile/lock требует новой сборки."""
    return f"{IMAGE_REPOSITORY}:{image_definition_hash()[:16]}"


@dataclass(frozen=True)
class CodegenSettings:
    docker: str = "docker"
    image: str = field(default_factory=default_image)
    test_timeout_seconds: float = 120.0
    max_test_timeout_seconds: float = 600.0
    memory_mb: int = 512
    cpus: float = 1.0
    pids_limit: int = 128
    tmpfs_mb: int = 64
    parallel: int = 1
    max_pending: int = 8
    log_limit_bytes: int = 256 * 1024
    output_limit_bytes: int = 4 * 1024 * 1024

    def __post_init__(self):
        if not (0 < self.test_timeout_seconds <= self.max_test_timeout_seconds <= 1800):
            raise ValueError("Test timeout must be positive and at most 1800 seconds")
        if not (64 <= self.memory_mb <= 4096 and 0.1 <= self.cpus <= 4 and 16 <= self.pids_limit <= 1024
                and 8 <= self.tmpfs_mb <= 1024 and self.parallel >= 1 and self.max_pending >= 1
                and 4096 <= self.log_limit_bytes <= self.output_limit_bytes <= 64 * 1024 * 1024):
            raise ValueError("Sandbox limits are outside the supported range")

    @classmethod
    def from_env(cls):
        env = os.getenv
        return cls(
            docker=env("PROVERYALKA_CODEGEN_DOCKER", "docker"),
            image=env("PROVERYALKA_CODEGEN_IMAGE") or default_image(),
            test_timeout_seconds=float(env("PROVERYALKA_CODEGEN_TEST_TIMEOUT", "120")),
            max_test_timeout_seconds=float(env("PROVERYALKA_CODEGEN_MAX_TEST_TIMEOUT", "600")),
            memory_mb=int(env("PROVERYALKA_CODEGEN_MEMORY_MB", "512")),
            cpus=float(env("PROVERYALKA_CODEGEN_CPUS", "1")),
            pids_limit=int(env("PROVERYALKA_CODEGEN_PIDS", "128")),
            tmpfs_mb=int(env("PROVERYALKA_CODEGEN_TMPFS_MB", "64")),
            parallel=int(env("PROVERYALKA_CODEGEN_PARALLEL", "1")),
            max_pending=int(env("PROVERYALKA_CODEGEN_MAX_PENDING", "8")),
        )
