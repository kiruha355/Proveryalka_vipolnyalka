from typing import Any, Protocol


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(message)


class Backend(Protocol):
    """Synchronous adapter. FastAPI runs routes in its worker thread pool.

    Long-running operations must return a durable Run immediately, and execute
    outside the request. An adapter owns idempotency and entity membership.
    """

    def call(self, operation: str, **arguments: Any) -> Any: ...


class UnavailableBackend:
    def call(self, operation: str, **arguments: Any) -> Any:
        raise ServiceError(503, "COMPONENT_UNAVAILABLE", f"Component for {operation} is not connected")
