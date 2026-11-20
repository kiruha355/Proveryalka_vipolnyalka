#!/bin/sh
# Проверяет, что модуль расширений присваивается типу ExtensionModule ядра и что
# WorkspaceContextValue ядра подходит под HostWorkspaceContext расширения.
# Использование: scripts/check-host-types.sh <путь-к-frontend-ядра>
set -eu
CORE="$(cd "${1:?путь к frontend/}" && pwd)"
EXT="$(cd "$(dirname "$0")/.." && pwd)"
CHK="$(mktemp -d /tmp/pv-hostcheck-XXXXXX)"
trap 'rm -rf "$CHK"' EXIT
cat > "$CHK/check.ts" <<TS
import type { ExtensionModule, WorkspaceContextValue } from "$CORE/src/public";
import * as extension from "$EXT/src/index";
import type { HostWorkspaceContext } from "$EXT/src/host/contract";

export const asModule: ExtensionModule = extension;
export const contextFits = (value: WorkspaceContextValue): HostWorkspaceContext => value;
TS
cat > "$CHK/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext", "moduleResolution": "Bundler",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "noEmit": true, "resolveJsonModule": true,
    "types": [], "typeRoots": ["$EXT/node_modules/@types"],
    "paths": {
      "react": ["$EXT/node_modules/@types/react"],
      "react/jsx-runtime": ["$EXT/node_modules/@types/react/jsx-runtime"],
      "@proveryalka/ui": ["$CORE/src/public.ts"]
    }
  },
  "files": ["check.ts", "$EXT/src/env.d.ts"]
}
JSON
"$EXT/node_modules/.bin/tsc" -p "$CHK/tsconfig.json"
echo "host types: OK ($CORE)"
