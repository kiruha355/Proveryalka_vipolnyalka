#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
PYTHON="${PROVERYALKA_PYTHON:-.venv/bin/python}"
exec "$PYTHON" -m proveryalka.deployment "$@"
