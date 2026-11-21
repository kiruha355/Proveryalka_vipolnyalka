import type {FileContextRef} from "../api/types";
import type {ProveryalkaApi} from "../api/api";
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
  fileContext?: FileContextRef | null;
  sourceId?: string;
  imageAnalysis?: { sourceId: string; analysisId: string };
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
  openImageId?: string | null;
  draftQuestionId?: string | null;
  draftFileContext?: FileContextRef | null;
  agentRuns: AgentRunRecord[];
  checkRuns: CheckRunRecord[];
  draft: string;
  outbox: Outbox | null;
}

const EMPTY: SessionLocal = { agentRuns: [], checkRuns: [], draft: "", outbox: null };
const LIMIT = 40;

type StorageScope = string | Pick<ProveryalkaApi, "id" | "ownerId">;

function sourceId(scope: StorageScope) {
  return typeof scope === "string" ? scope : scope.id;
}

function isAnonymous(scope: StorageScope) {
  return typeof scope === "string" || !scope.ownerId;
}

function prefix(scope: StorageScope) {
  const owner = typeof scope !== "string" && scope.ownerId ? `user:${encodeURIComponent(scope.ownerId)}` : "anonymous";
  return `proveryalka:v2:${owner}:${encodeURIComponent(sourceId(scope))}`;
}

function storageKey(scope: StorageScope, sessionId: string) {
  return `${prefix(scope)}:session:${encodeURIComponent(sessionId)}`;
}

function legacyKey(scope: StorageScope, sessionId: string) {
  return `proveryalka:v1:${sourceId(scope)}:session:${sessionId}`;
}

export function loadLocal(scope: StorageScope, sessionId: string): SessionLocal {
  try {
    const raw = localStorage.getItem(storageKey(scope, sessionId))
      ?? (isAnonymous(scope) ? localStorage.getItem(legacyKey(scope, sessionId)) : null);
    if (!raw) return { ...EMPTY };
    const value = JSON.parse(raw) as Partial<SessionLocal>;
    return {
      agentRuns: Array.isArray(value.agentRuns) ? value.agentRuns : [],
      checkRuns: Array.isArray(value.checkRuns) ? value.checkRuns : [],
      draftFileContext: value.draftFileContext ?? null,
      openImageId: typeof value.openImageId === "string" ? value.openImageId : null,
      draftQuestionId: typeof value.draftQuestionId === "string" ? value.draftQuestionId : null,
      draft: typeof value.draft === "string" ? value.draft : "",
      outbox: value.outbox && typeof value.outbox.key === "string" ? value.outbox : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function updateLocal(scope: StorageScope, sessionId: string, change: (current: SessionLocal) => SessionLocal): SessionLocal {
  const next = change(loadLocal(scope, sessionId));
  next.agentRuns = next.agentRuns.slice(-LIMIT);
  next.checkRuns = next.checkRuns.slice(-LIMIT);
  try {
    localStorage.setItem(storageKey(scope, sessionId), JSON.stringify(next));
  } catch {
    // Storage full or disabled: the session still works, only reload recovery is lost.
  }
  return next;
}

export function moveLocal(scope: StorageScope, from: string, to: string) {
  const value = loadLocal(scope, from);
  updateLocal(scope, to, () => value);
  try {
    if (isAnonymous(scope)) localStorage.removeItem(legacyKey(scope, from));
    localStorage.removeItem(storageKey(scope, from));
  } catch {
    // ignore
  }
}

const PREFS = "proveryalka:v1:prefs";

export interface Prefs {
  adapter: "http" | "demo";
  baseUrl: string;
  sidebarOpen: boolean;
}

function legacyPrefs(): Partial<Prefs> & { lastSession?: Record<string, string> } {
  return JSON.parse(localStorage.getItem(PREFS) ?? "{}");
}

export function loadLastSession(scope: StorageScope): string | null {
  try {
    return localStorage.getItem(`${prefix(scope)}:lastSession`)
      ?? (isAnonymous(scope) ? legacyPrefs().lastSession?.[sourceId(scope)] ?? null : null);
  } catch {
    return null;
  }
}

export function saveLastSession(scope: StorageScope, sessionId: string) {
  try {
    localStorage.setItem(`${prefix(scope)}:lastSession`, sessionId);
  } catch {
    // ignore
  }
}

export function loadPrefs(defaults: Prefs): Prefs {
  try {
    const { adapter = defaults.adapter, baseUrl = defaults.baseUrl, sidebarOpen = defaults.sidebarOpen } = legacyPrefs();
    return { adapter, baseUrl, sidebarOpen };
  } catch {
    return defaults;
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    for (const [id, sessionId] of Object.entries(legacyPrefs().lastSession ?? {})) {
      const key = `${prefix(id)}:lastSession`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, sessionId);
    }
    localStorage.setItem(PREFS, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
