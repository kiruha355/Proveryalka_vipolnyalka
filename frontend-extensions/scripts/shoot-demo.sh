#!/bin/sh
# Снимки демо-страниц через headless Chromium (Playwright) с временным профилем.
# Использование: scripts/shoot-demo.sh [ширина] ; результат в demo-dist/shots/.
set -eu
WIDTH="${1:-1240}"
BIN="${CHROME_HEADLESS:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$(mktemp -d /tmp/pv-shot-XXXXXX)"
trap 'rm -rf "$PROFILE"' EXIT
mkdir -p "$DIR/demo-dist/shots"
for page in graph files; do
  "$BIN" --headless --disable-gpu --no-first-run --user-data-dir="$PROFILE" --hide-scrollbars \
    --window-size="$WIDTH,1900" --virtual-time-budget=4000 \
    --screenshot="$DIR/demo-dist/shots/$page-$WIDTH.png" "file://$DIR/demo-dist/$page.html" >/dev/null 2>&1
  echo "demo-dist/shots/$page-$WIDTH.png"
done
