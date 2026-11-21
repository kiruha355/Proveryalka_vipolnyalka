import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "./api/api";
import { DemoApi } from "./api/demo";
import { isAbort } from "./api/errors";
import { HttpApi } from "./api/http";
import type { ReadyInfo, Session } from "./api/types";
import { configureFilesForAdapter } from "./extensions/load";
import { AuthGate, type WorkspaceAccount } from "./app/AuthGate";
import { useRoute } from "./app/route";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { NewChat } from "./components/NewChat";
import { ErrorNotice, QuietStatus } from "./components/Notice";
import { SessionView } from "./components/SessionView";
import { PaneSeparator, usePaneWidth } from "./components/PaneSeparator";
import { Sidebar } from "./components/Sidebar";
import { loadLastSession, loadPrefs, saveLastSession, savePrefs, type Prefs } from "./state/persist";
import type { Loadable } from "./state/types";

const DEFAULT_PREFS: Prefs = {
  adapter: import.meta.env.VITE_PROVERYALKA_ADAPTER === "demo" ? "demo" : "http",
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
  sidebarOpen: true,
};

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    load(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ data, error: null, loading: false }); },
      (error: unknown) => { if (!isAbort(error) && !controller.signal.aborted) setState((s) => ({ data: s.data, error, loading: false })); },
    );
    return () => controller.abort();
  }, [...deps, tick]);
  return [state, useCallback(() => setTick((t) => t + 1), [])];
}

function readRecovery() {
  const { hash, pathname } = window.location;
  if (pathname !== "/reset-password" && !hash.startsWith("#token=")) return null;
  const token = new URLSearchParams(hash.slice(1)).get("token");
  return { token: token && token.length >= 32 && token.length <= 128 ? token : null };
}

export function App({ initialApi }: { initialApi?: ProveryalkaApi } = {}) {
  const [recovery, setRecovery] = useState(readRecovery);
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const saved = loadPrefs(DEFAULT_PREFS);
    return recovery ? { ...saved, adapter: "http", baseUrl: "" } : saved;
  });
  const transport = useMemo(
    () => prefs.adapter === "http" ? new HttpApi(prefs.baseUrl) : new DemoApi(),
    [prefs.adapter, prefs.baseUrl],
  );
  const api = initialApi ?? transport;
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [ready, recheckReady] = useLoad<ReadyInfo>((signal) => api.ready(signal), [api]);

  useLayoutEffect(() => {
    if (recovery) {
      window.history.replaceState(null, "", "/" + window.location.search);
      savePrefs(prefs);
      setRecovery(null);
    }
  }, [recovery, prefs]);

  const update = (patch: Partial<Prefs>) => setPrefs((p) => {
    const next = { ...p, ...patch };
    savePrefs(next);
    return next;
  });
  const openConnection = useCallback(() => setConnectionOpen(true), []);
  const closeConnection = useCallback(() => setConnectionOpen(false), []);
  const applyConnection = (adapter: Prefs["adapter"], baseUrl: string) => {
    setConnectionOpen(false);
    if (adapter === prefs.adapter && baseUrl === prefs.baseUrl) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    update({ adapter, baseUrl });
  };
  const renderWorkspace = (workspace: ProveryalkaApi, account?: WorkspaceAccount, resume = 0) => (
    <Workspace key={JSON.stringify([workspace.ownerId, workspace.id])} api={workspace} prefs={prefs}
      account={account} resume={resume} ready={ready} onConnection={openConnection}
      onToggleSidebar={() => update({ sidebarOpen: !prefs.sidebarOpen })} />
  );

  return <>
    {!initialApi && transport instanceof HttpApi ? (
      <AuthGate key={prefs.baseUrl} transport={transport} baseUrl={prefs.baseUrl} recovery={recovery}
        onDemo={() => applyConnection("demo", prefs.baseUrl)} onConnection={openConnection}>
        {renderWorkspace}
      </AuthGate>
    ) : renderWorkspace(api)}
    {connectionOpen && (
      <ConnectionDialog adapter={prefs.adapter} baseUrl={prefs.baseUrl} ready={ready} onCheckReady={recheckReady}
        onClose={closeConnection} onApply={applyConnection} />
    )}
  </>;
}

interface WorkspaceProps {
  api: ProveryalkaApi;
  prefs: Prefs;
  account?: WorkspaceAccount;
  resume: number;
  ready: Loadable<ReadyInfo>;
  onConnection(): void;
  onToggleSidebar(): void;
}

function Workspace({ api, prefs, account, resume, ready, onConnection, onToggleSidebar }: WorkspaceProps) {
  const sidebarPane = usePaneWidth("proveryalka:sidebar-width", .18, 170, 660, .32);
  useLayoutEffect(() => {
    configureFilesForAdapter(api.id === "demo" ? "demo" : "http", prefs.baseUrl, api instanceof HttpApi ? api.fetchWithSession : undefined);
    return () => configureFilesForAdapter("demo");
  }, [api, prefs.baseUrl]);
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
  const [capabilities, retryCapabilities] = useLoad<ApiCapabilities>((signal) => api.capabilities(signal), [api]);
  const [sessions, reloadSessions] = useLoad<Session[]>((signal) => api.listSessions(signal), [api, resume]);

  // Reopen only this owner's last session when there is no explicit route.
  useEffect(() => {
    if (window.location.hash) return;
    navigate({ sessionId: loadLastSession(api) }, { replace: true });
  }, [api, navigate]);

  const knownSession = sessions.data?.some((session) => session.id === route.sessionId);
  useEffect(() => {
    if (route.sessionId && (knownSession || !api.ownerId)) saveLastSession(api, route.sessionId);
  }, [route.sessionId, api, knownSession]);

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
                <button type="button" className="button button--small button--ghost" onClick={onConnection}>Подключение</button>
              </>
            } />
        ) : <QuietStatus busy>Подключение к серверу</QuietStatus>}
      </div>
    );
  } else if (route.sessionId) {
    main = (
      <SessionView key={`${api.id}:${route.sessionId}`} api={api} capabilities={{...caps, agent: caps.agent && ready.data?.agent_configured !== false}} sessionId={route.sessionId} resume={resume}
        listed={sessions.data?.find((s) => s.id === route.sessionId)} route={route} navigate={navigate} />
    );
  } else {
    main = (
      <NewChat key={api.id} api={api} capabilities={{...caps, agent: caps.agent && ready.data?.agent_configured !== false}}
        onCreated={(session) => { saveLastSession(api, session.id); reloadSessions(); navigate({ sessionId: session.id }); }} />
    );
  }

  return (
    <div ref={sidebarPane.container} style={sidebarPane.style} className={`app${sidebarOpen ? " app--sidebar" : ""}${prefs.adapter === "demo" ? " app--demo" : ""}`}>
      <Sidebar open={sidebarOpen} onToggle={() => (narrow ? setOverlayOpen((v) => !v) : onToggleSidebar())}
        sessions={sessions} currentId={route.sessionId} onRetry={reloadSessions}
        onSelect={(id) => { setOverlayOpen(false); navigate({ sessionId: id }); }}
        onNew={() => { setOverlayOpen(false); navigate({ sessionId: null }); }}
        connectionLabel={connectionLabel} connectionTone={tone} onConnection={onConnection} account={account} />
      {sidebarOpen && <PaneSeparator pane={sidebarPane} label="Ширина списка сессий"/>}
      <main className="main">{main}</main>
    </div>
  );
}
