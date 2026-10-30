#!/usr/bin/env sh
# Загружает закреплённую сборку tla2tools.jar и проверяет sha256.
# Версию меняют только здесь: TLA_VERSION + TLA_SHA256 (digest ассета на странице релиза).
set -eu

TLA_VERSION="v1.8.0"
TLA_SHA256="fc6878c603f0fdc18b9fe3e5bf51860cb90ab5b1154e3c371660c036d6bdd63e"
URL="https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar"
DEST="${1:-tools/tla2tools.jar}"

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ -f "$DEST" ] && [ "$(sha256 "$DEST")" = "$TLA_SHA256" ]; then
    echo "tla2tools.jar ${TLA_VERSION} уже на месте: $DEST"
    exit 0
fi
mkdir -p "$(dirname "$DEST")"
curl -fsSL --retry 3 -o "$DEST.part" "$URL"
ACTUAL="$(sha256 "$DEST.part")"
if [ "$ACTUAL" != "$TLA_SHA256" ]; then
    rm -f "$DEST.part"
    echo "sha256 не совпадает: ожидался $TLA_SHA256, получен $ACTUAL. Ассет релиза ${TLA_VERSION} заменён — обновите закрепление осознанно." >&2
    exit 1
fi
mv "$DEST.part" "$DEST"
echo "tla2tools.jar ${TLA_VERSION} загружен: $DEST"
