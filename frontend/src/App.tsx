import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "./api/api";
import { DemoApi } from "./api/demo";
import { isAbort } from "./api/errors";
import { HttpApi } from "./api/http";
import type { ReadyInfo, Session } from "./api/types";
import { useRoute } from "./app/route";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { NewChat } from "./components/NewChat";
import { ErrorNotice, QuietStatus } from "./components/Notice";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { loadPrefs, savePrefs, type Prefs } from "./state/persist";
import type { Loadable } from "./state/types";

const DEFAULT_PREFS: Prefs = {
  adapter: import.meta.env.VITE_PROVERYALKA_ADAPTER === "demo" ? "demo" : "http",
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
  lastSession: {},
  sidebarOpen: true,
};

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    load(controller.signal).then(
      (data) => setState({ data, error: null, loading: false }),
      (error: unknown) => { if (!isAbort(error) && !controller.signal.aborted) setState((s) => ({ data: s.data, error, loading: false })); },
    );
    return () => controller.abort();
  }, [...deps, tick]);
  return [state, useCallback(() => setTick((t) => t + 1), [])];
}

export function App({ initialApi }: { initialApi?: ProveryalkaApi } = {}) {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(DEFAULT_PREFS));
  const api = useMemo<ProveryalkaApi>(
    () => initialApi ?? (prefs.adapter === "demo" ? new DemoApi() : new HttpApi(prefs.baseUrl)),
    [initialApi, prefs.adapter, prefs.baseUrl],
  );
  const [route, navigate] = useRoute();
  // On narrow screens the session list is an overlay: closed by default, closed after a choice.
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 900px)").matches ?? false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 900px)");
    if (!query) return;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const sidebarOpen = narrow ? overlayOpen : prefs.sidebarOpen;
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [capabilities, retryCapabilities] = useLoad<ApiCapabilities>((signal) => api.capabilities(signal), [api]);
  const [sessions, reloadSessions] = useLoad<Session[]>((signal) => api.listSessions(signal), [api]);
  const [ready, recheckReady] = useLoad<ReadyInfo>((signal) => api.ready(signal), [api]);

  const update = (patch: Partial<Prefs>) => setPrefs((p) => {
    const next = { ...p, ...patch };
    savePrefs(next);
    return next;
  });

  // Reopen the last session of this adapter when the URL names none.
  useEffect(() => {
    if (window.location.hash) return;
    const last = prefs.lastSession[api.id];
    if (last) navigate({ sessionId: last }, { replace: true });
    else navigate({ sessionId: null }, { replace: true });
  }, [api.id]);

  useEffect(() => {
    if (route.sessionId && prefs.lastSession[api.id] !== route.sessionId) {
      update({ lastSession: { ...prefs.lastSession, [api.id]: route.sessionId } });
    }
  }, [route.sessionId, api.id]);

  const caps = capabilities.data;
  const tone = prefs.adapter === "demo" ? "demo" : capabilities.error !== null ? "error" : caps ? "ok" : "pending";
  const connectionLabel = prefs.adapter === "demo" ? "Демо: записанные данные"
    : capabilities.error !== null ? "Сервер недоступен"
      : caps ? `Сервер ${prefs.baseUrl || "через proxy"}` : "Подключение…";

  let main;
  if (!caps) {
    main = (
      <div className="session session--loading">
        {capabilities.error !== null ? (
          <ErrorNotice error={capabilities.error} title="Сервер Проверялки недоступен"
            action={
              <>
                <button type="button" className="button button--small" onClick={() => { retryCapabilities(); reloadSessions(); }}>Повторить</button>
                <button type="button" className="button button--small button--ghost" onClick={() => setConnectionOpen(true)}>Подключение</button>
              </>
            } />
        ) : <QuietStatus busy>Подключение к серверу</QuietStatus>}
      </div>
    );
  } else if (route.sessionId) {
    main = (
      <SessionView key={`${api.id}:${route.sessionId}`} api={api} capabilities={caps} sessionId={route.sessionId}
        listed={sessions.data?.find((s) => s.id === route.sessionId)} route={route} navigate={navigate} />
    );
  } else {
    main = (
      <NewChat key={api.id} api={api} capabilities={caps}
        onCreated={(session) => { reloadSessions(); navigate({ sessionId: session.id }); }} />
    );
  }

  return (
    <div className={`app${sidebarOpen ? " app--sidebar" : ""}${prefs.adapter === "demo" ? " app--demo" : ""}`}>
      <Sidebar open={sidebarOpen} onToggle={() => (narrow ? setOverlayOpen((v) => !v) : update({ sidebarOpen: !prefs.sidebarOpen }))}
        sessions={sessions} currentId={route.sessionId} onRetry={reloadSessions}
        onSelect={(id) => { setOverlayOpen(false); navigate({ sessionId: id }); }}
        onNew={() => { setOverlayOpen(false); navigate({ sessionId: null }); }}
        connectionLabel={connectionLabel} connectionTone={tone} onConnection={() => setConnectionOpen(true)} />
      <main className="main">{main}</main>
      {connectionOpen && (
        <ConnectionDialog adapter={prefs.adapter} baseUrl={prefs.baseUrl} ready={ready} onCheckReady={recheckReady}
          onClose={() => setConnectionOpen(false)}
          onApply={(adapter, baseUrl) => {
            setConnectionOpen(false);
            update({ adapter, baseUrl });
            navigate({ sessionId: prefs.lastSession[adapter === "demo" ? "demo" : `http:${baseUrl.replace(/\/+$/, "") || "same-origin"}`] ?? null }, { replace: true });
          }} />
      )}
    </div>
  );
}
