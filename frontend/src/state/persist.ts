// Client-side records the backend has no listing endpoint for: run ids of a
// session, an unsent message with its idempotency key, and the draft text.

export interface AgentRunRecord {
  runId: string;
  text: string;
  questionId: string | null;
  startedAt: string;
  /** Final state once known, so a failure reason survives a reload. */
  state?: string;
  errorCode?: string | null;
}

export interface CheckRunRecord {
  runId: string;
  versionId: string;
  modelId: string;
  number: number;
  propertyIds: string[] | null;
  startedAt: string;
}

export interface Outbox {
  sourceId?: string;
  pendingRetry?: boolean;
  text: string;
  questionId: string | null;
  /** Reused on retry so a lost response cannot start a second run. */
  key: string;
  /** For a message that also creates its session. */
  sessionTitle?: string;
  sessionKey?: string;
  /** Send automatically once the session exists. */
  autoSend?: boolean;
}

export interface SessionLocal {
  agentRuns: AgentRunRecord[];
  checkRuns: CheckRunRecord[];
  draft: string;
  outbox: Outbox | null;
}

const EMPTY: SessionLocal = { agentRuns: [], checkRuns: [], draft: "", outbox: null };
const LIMIT = 40;

function storageKey(apiId: string, sessionId: string) {
  return `proveryalka:v1:${apiId}:session:${sessionId}`;
}

export function loadLocal(apiId: string, sessionId: string): SessionLocal {
  try {
    const raw = localStorage.getItem(storageKey(apiId, sessionId));
    if (!raw) return { ...EMPTY };
    const value = JSON.parse(raw) as Partial<SessionLocal>;
    return {
      agentRuns: Array.isArray(value.agentRuns) ? value.agentRuns : [],
      checkRuns: Array.isArray(value.checkRuns) ? value.checkRuns : [],
      draft: typeof value.draft === "string" ? value.draft : "",
      outbox: value.outbox && typeof value.outbox.key === "string" ? value.outbox : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function updateLocal(apiId: string, sessionId: string, change: (current: SessionLocal) => SessionLocal): SessionLocal {
  const next = change(loadLocal(apiId, sessionId));
  next.agentRuns = next.agentRuns.slice(-LIMIT);
  next.checkRuns = next.checkRuns.slice(-LIMIT);
  try {
    localStorage.setItem(storageKey(apiId, sessionId), JSON.stringify(next));
  } catch {
    // Storage full or disabled: the session still works, only reload recovery is lost.
  }
  return next;
}

export function moveLocal(apiId: string, from: string, to: string) {
  const value = loadLocal(apiId, from);
  updateLocal(apiId, to, () => value);
  try {
    localStorage.removeItem(storageKey(apiId, from));
  } catch {
    // ignore
  }
}

const PREFS = "proveryalka:v1:prefs";

export interface Prefs {
  adapter: "http" | "demo";
  baseUrl: string;
  lastSession: Record<string, string>;
  sidebarOpen: boolean;
}

export function loadPrefs(defaults: Prefs): Prefs {
  try {
    const raw = localStorage.getItem(PREFS);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) } : defaults;
  } catch {
    return defaults;
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
