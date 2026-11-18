#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
PYTHON="${PROVERYALKA_PYTHON:-.venv/bin/python}"
"$PYTHON" -m proveryalka.runtime
exec "$PYTHON" -m uvicorn proveryalka.api.app:app --env-file .env --host 127.0.0.1 --port "${PORT:-8000}" --workers 1 --timeout-graceful-shutdown 15
