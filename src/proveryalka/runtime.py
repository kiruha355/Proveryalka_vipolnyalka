"""Preflight checks for the documented local deployment, without an LLM request."""
import asyncio
import json
import os
import tempfile
from pathlib import Path

from .checker.runner import detect_engine
from .config import Settings
from .storage.sqlite import SQLiteStore


async def diagnose(settings=None):
    settings = settings or Settings.from_env()
    store = SQLiteStore(settings.database_path)
    store.initialize()
    store.list_sessions(limit=1)
    settings.artifacts_path.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=settings.artifacts_path) as test:
        test.write(b"ready")
    engine = await detect_engine(settings.java_path, settings.tla_jar)
    return {"sqlite":"ready", "artifacts":"ready", "java_major":engine.java_version,
            "tlc":engine.tlc_version, "jar_sha256":engine.jar_sha256,
            "agent_configured":bool(os.getenv("OPENAI_API_KEY") and os.getenv("OPENAI_BASE_URL"))}


def main():
    from dotenv import load_dotenv
    load_dotenv()
    try:
        result = asyncio.run(diagnose())
    except Exception as error:
        print(json.dumps({"status":"not_ready","reason":str(error)},ensure_ascii=False))
        return 1
    print(json.dumps({"status":"ready",**result},ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
