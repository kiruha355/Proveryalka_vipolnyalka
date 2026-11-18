"""Optional factual operation observer, isolated per asynchronous run.

Never receives prompts, provider output, or private reasoning. Observability
failures cannot cause another provider request or change dialogue semantics.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import logging

_observer = ContextVar("agent_activity_observer", default=None)
logger = logging.getLogger(__name__)


@contextmanager
def observe_activity(callback):
    token = _observer.set(callback)
    try:
        yield
    finally:
        _observer.reset(token)


async def activity(phase, **facts):
    callback = _observer.get()
    if callback is not None:
        try:
            await callback(phase, facts)
        except Exception:
            logger.warning("agent_activity_unavailable phase=%s", phase)
