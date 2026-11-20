#!/usr/bin/env sh
# Загружает закреплённую сборку tla2tools.jar и проверяет sha256.
# Сборка model-checker-hardening опубликована отдельным тегом с SHA коммита TLC.
# У тега v1.8.0 содержимое JAR меняется при обновлении предварительного релиза.
set -eu

TLA_VERSION="20261023-2ef2af8c767b"
TLA_SHA256="49c05a29439167a25c952023a58e339ed1cbc56ece33369fbf601aaf984ccfb6"
URL="https://github.com/tlaplus/model-checker-hardening/releases/download/tlc-${TLA_VERSION}/tla2tools-${TLA_VERSION}.jar"
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
