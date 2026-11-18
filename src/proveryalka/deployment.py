"""Native single-process delivery: built Vite UI and API on one loopback origin.

The existing API owns SQLite, TLC and worker lifecycle. No subscription credentials
are read or copied by the delivery layer; the local app-server authenticates itself.
"""
import argparse
import asyncio
import json
import os
import re
import tempfile
from pathlib import Path

from fastapi.responses import JSONResponse
from starlette.staticfiles import StaticFiles

from .api.app import create_app
from .config import Settings
from .runtime import diagnose


def check_frontend(directory: Path):
    index = directory / "index.html"
    if not index.is_file() or not (directory / "assets").is_dir():
        raise ValueError(f"Vite build missing in {directory}; run npm --prefix frontend run build")
    references = re.findall(r'(?:src|href)=["\']/?(assets/[^"\']+)["\']', index.read_text(encoding="utf-8"))
    if not references or any(not (directory / asset).is_file() for asset in references):
        raise ValueError("Vite build has missing entry assets; rebuild frontend")


def create_deployment(settings=None, frontend_dist=None, **api_options):
    settings = settings or Settings.from_env()
    directory = Path(frontend_dist or "frontend/dist").resolve()
    check_frontend(directory)
    app = create_app(settings, **api_options)

    @app.middleware("http")
    async def delivery_readiness(request, call_next):
        response = await call_next(request)
        if request.url.path == "/ready" and response.status_code == 200:
            try:
                check_frontend(directory)
                # Recheck disk access without contacting an LLM or revealing settings.
                with tempfile.TemporaryFile(dir=settings.artifacts_path) as probe:
                    probe.write(b"ready")
            except (OSError, ValueError):
                return JSONResponse(status_code=503, content={"error": {
                    "code": "DELIVERY_UNAVAILABLE", "message": "Frontend build or artifacts directory unavailable", "details": []}})
        return response

    # API routes are registered first. StaticFiles confines paths to this build;
    # data/, .env, home and repository files are never mounted.
    app.mount("/", StaticFiles(directory=directory, html=True), name="frontend")
    return app


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--data-dir", type=Path, help="Override SQLite, artifacts and cache paths together")
    parser.add_argument("--frontend-dist", type=Path, default=Path("frontend/dist"))
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=False)
    if args.data_dir is not None:
        data = args.data_dir.resolve()
        os.environ.update({"PROVERYALKA_DATABASE_PATH": str(data / "proveryalka.sqlite3"),
                           "PROVERYALKA_ARTIFACTS_PATH": str(data / "artifacts"),
                           "PROVERYALKA_CHECK_CACHE": str(data / "check-cache")})
    try:
        check_frontend(args.frontend_dist)
        settings = Settings.from_env()
        result = asyncio.run(diagnose(settings))
        app = create_deployment(settings, args.frontend_dist)
    except Exception as error:
        # Exception messages can contain external settings; keep startup output bounded.
        print(json.dumps({"status": "not_ready", "error_type": type(error).__name__,
                          "action": "Check Vite build, SQLite/artifacts permissions and Java/TLC; see reports/runtime-runbook.md"}))
        return 1
    print(json.dumps({"status": "ready", **result}), flush=True)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, workers=1, timeout_graceful_shutdown=15)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
