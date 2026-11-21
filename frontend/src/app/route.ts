import { useCallback, useEffect, useState } from "react";

// #/s/<sessionId>?m=<modelId>&v=<number>&view=<id>&check=<runId>&p=<propertyId>&step=<k>
// #/new — new chat. The route is the selection that must survive a reload.

export interface RouteError {
  code: "invalid_encoding" | "invalid_param" | "invalid_path";
  message: string;
}

export interface Route {
  sessionId: string | null;
  modelId?: string;
  version?: number;
  view?: string;
  check?: string;
  property?: string;
  step?: number;
  snapshotId?: string;
  error?: RouteError;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function hasInvalidQueryEncoding(query: string): boolean {
  if (!query) return false;
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const val = eq === -1 ? "" : part.slice(eq + 1);
    if (safeDecode(key.replace(/\+/g, " ")) === null) return true;
    if (safeDecode(val.replace(/\+/g, " ")) === null) return true;
  }
  return false;
}

function parseIntParam(
  params: URLSearchParams,
  name: string,
  min: number,
): { ok: true; value: number | undefined } | { ok: false; raw: string } {
  if (!params.has(name)) return { ok: true, value: undefined };
  const raw = params.get(name) ?? "";
  if (!/^\d+$/.test(raw)) return { ok: false, raw };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) return { ok: false, raw };
  return { ok: true, value };
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const qIndex = raw.indexOf("?");
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = qIndex === -1 ? "" : raw.slice(qIndex + 1);

  if (!path || path === "/" || path === "/new") {
    if (hasInvalidQueryEncoding(query)) {
      return {
        sessionId: null,
        error: {
          code: "invalid_encoding",
          message: "Некорректная кодировка параметров ссылки (ошибка percent-encoding).",
        },
      };
    }
    return { sessionId: null };
  }

  const match = /^\/s\/([^/]+)$/.exec(path);
  if (!match) {
    return {
      sessionId: null,
      error: {
        code: "invalid_path",
        message: "Некорректный адрес ссылки. Ожидается адрес вида #/s/<id> или #/new.",
      },
    };
  }

  const sessionId = safeDecode(match[1] ?? "");
  if (sessionId === null) {
    return {
      sessionId: null,
      error: {
        code: "invalid_encoding",
        message: "Некорректная кодировка адреса сессии в ссылке (ошибка percent-encoding).",
      },
    };
  }
  if (!sessionId.trim()) {
    return {
      sessionId: null,
      error: {
        code: "invalid_path",
        message: "Идентификатор сессии в ссылке пуст.",
      },
    };
  }

  if (hasInvalidQueryEncoding(query)) {
    return {
      sessionId,
      error: {
        code: "invalid_encoding",
        message: "Некорректная кодировка параметров ссылки (ошибка percent-encoding).",
      },
    };
  }

  const params = new URLSearchParams(query);
  const versionParam = parseIntParam(params, "v", 1);
  if (!versionParam.ok) {
    return {
      sessionId,
      error: {
        code: "invalid_param",
        message: `Недопустимый номер версии «${versionParam.raw}»: ожидается целое число больше 0.`,
      },
    };
  }

  const stepParam = parseIntParam(params, "step", 0);
  if (!stepParam.ok) {
    return {
      sessionId,
      error: {
        code: "invalid_param",
        message: `Недопустимый номер шага «${stepParam.raw}»: ожидается целое число не меньше 0.`,
      },
    };
  }

  const str = (name: string) => {
    const val = params.get(name);
    return val !== null && val !== "" ? val : undefined;
  };
  return {
    sessionId,
    modelId: str("m"),
    version: versionParam.value,
    view: str("view"),
    check: str("check"),
    property: str("p"),
    step: stepParam.value,
    snapshotId: str("repo"),
  };
}

export function formatRoute(route: Route): string {
  if (!route.sessionId) return "#/new";
  const params = new URLSearchParams();
  if (route.modelId) params.set("m", route.modelId);
  if (route.version !== undefined) params.set("v", String(route.version));
  if (route.view) params.set("view", route.view);
  if (route.check) params.set("check", route.check);
  if (route.property) params.set("p", route.property);
  if (route.step !== undefined) params.set("step", String(route.step));
  if (route.snapshotId) params.set("repo", route.snapshotId);
  const query = params.toString();
  return `#/s/${encodeURIComponent(route.sessionId)}${query ? `?${query}` : ""}`;
}

export function useRoute(): [Route, (next: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = formatRoute(next);
    if (hash === window.location.hash) {
      setRoute((current) => (current.error ? parseRoute(hash) : current));
      return;
    }
    if (options.replace) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
    setRoute(parseRoute(hash));
  }, []);
  return [route, navigate];
}
