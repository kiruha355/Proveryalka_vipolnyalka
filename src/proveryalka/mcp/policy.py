"""Локальная политика одного оператора, не multi-tenant authorization."""
import os
import math
from dataclasses import dataclass, field


TOOLS = frozenset({"get_model", "check_behavior", "get_tests", "compare_with_code"})


@dataclass(frozen=True)
class LocalAccessPolicy:
    # Fail closed: оператор явно выбирает модели и разрешает дорогие операции.
    model_ids: frozenset[str] = frozenset()
    tools: frozenset[str] = frozenset({"get_model", "get_tests"})
    bearer_token: str | None = field(default=None, repr=False)
    hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")
    origins: tuple[str, ...] = ()
    max_body_bytes: int = 64 * 1024
    max_result_bytes: int = 512 * 1024
    parallel: int = 2
    max_http_requests: int = 32
    request_seconds: float = 180.0
    body_seconds: float = 10.0
    max_sessions: int = 16
    session_idle_seconds: float = 300.0

    def __post_init__(self):
        if not self.tools <= TOOLS or not self.hosts or any("*" in v for v in self.hosts + self.origins):
            raise ValueError("Use explicit hosts, origins and known tools")
        if self.max_result_bytes < 1024:
            raise ValueError("Result limit must accommodate the error envelope (at least 1024 bytes)")
        if self.bearer_token is not None and not self.bearer_token.strip():
            raise ValueError("Bearer token cannot be empty")
        if any(type(v) is not int or v <= 0 for v in (self.max_body_bytes, self.max_result_bytes, self.parallel,
                                                      self.max_http_requests, self.max_sessions)):
            raise ValueError("Limits must be positive integers")
        if any(not math.isfinite(v) or v <= 0 for v in (self.request_seconds, self.session_idle_seconds, self.body_seconds)):
            raise ValueError("Deadlines must be positive and finite")

    @classmethod
    def from_env(cls):
        """Читает только явно выделенные PROVERYALKA_MCP_* параметры, не профили клиентов."""
        def items(name, default=""):
            return frozenset(v.strip() for v in os.getenv(name, default).split(",") if v.strip())
        return cls(model_ids=items("PROVERYALKA_MCP_MODEL_IDS"),
                   tools=items("PROVERYALKA_MCP_TOOLS", "get_model,get_tests"),
                   bearer_token=os.getenv("PROVERYALKA_MCP_BEARER_TOKEN"))

    def public_limits(self):
        return {"request_bytes": self.max_body_bytes, "result_bytes": self.max_result_bytes,
                "parallel_tools": self.parallel, "body_seconds": self.body_seconds, "request_seconds": self.request_seconds,
                "check_timeout_seconds": 60, "test_timeout_seconds": 120,
                "max_states": 100_000, "max_properties": 32}
