import hashlib
import json
from pathlib import Path

from ..verification.contracts import VerificationResult
from .artifacts import write_json
from .spec import COMPILER_VERSION


CACHE_MARK = "[из кэша]"


def cache_key(spec_hash, property_id, engine_version):
    """Ключ: канонический spec, свойство, точная сборка движка и версия перевода в TLA+."""
    data = json.dumps({
        "schema": "1.0", "spec_hash": spec_hash, "property_id": property_id,
        "engine": engine_version, "compiler": COMPILER_VERSION,
    }, sort_keys=True)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def sufficient(result, limits):
    """Переиспользуем только завершённый результат, который те же лимиты получили бы снова.

    BFS TLC детерминирован при одном воркере: если прежний прогон уложился в новые max_states
    и max_depth, повторный прогон пройдёт тот же путь. Таймаут на завершённый результат не влияет.
    """
    stats = result.statistics
    if not result.conclusive or stats.distinct_states is None or stats.depth is None:
        return False
    if stats.distinct_states > limits.max_states:
        return False
    return limits.max_depth is None or stats.depth <= limits.max_depth


class ResultCache:
    def __init__(self, root):
        self.root = Path(root)

    def path(self, key):
        return self.root / key[:2] / f"{key}.json"

    def get(self, request, property_id, engine_version, spec_hash):
        path = self.path(cache_key(spec_hash, property_id, engine_version))
        try:
            result = VerificationResult.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if result.spec_hash != spec_hash or result.property_id != property_id or result.engine is None or result.engine.version != engine_version:
            return None
        if not sufficient(result, request.limits):
            return None
        message = result.message if result.message.startswith(CACHE_MARK) else f"{CACHE_MARK} {result.message}"
        return result.model_copy(update={"limits": request.limits, "version_id": request.version_id, "message": message})

    def put(self, result):
        if not result.conclusive or result.mode != "engine" or result.engine is None:
            return
        write_json(self.path(cache_key(result.spec_hash, result.property_id, result.engine.version)), result.model_dump(mode="json"))
