import { useCallback, useEffect, useState } from "react";

// #/s/<sessionId>?m=<modelId>&v=<number>&view=<id>&check=<runId>&p=<propertyId>&step=<k>
// #/new — new chat. The route is the selection that must survive a reload.

export interface Route {
  sessionId: string | null;
  modelId?: string;
  version?: number;
  view?: string;
  check?: string;
  property?: string;
  step?: number;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?");
  const match = /^\/s\/([^/]+)$/.exec(path);
  if (!match) return { sessionId: null };
  const params = new URLSearchParams(query);
  const int = (name: string) => {
    const value = params.get(name);
    if (value === null || !/^\d+$/.test(value)) return undefined;
    return Number(value);
  };
  const str = (name: string) => params.get(name) ?? undefined;
  return {
    sessionId: decodeURIComponent(match[1] ?? ""),
    modelId: str("m"),
    version: int("v"),
    view: str("view"),
    check: str("check"),
    property: str("p"),
    step: int("step"),
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
    if (hash === window.location.hash) return;
    if (options.replace) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
    setRoute(parseRoute(hash));
  }, []);
  return [route, navigate];
}
