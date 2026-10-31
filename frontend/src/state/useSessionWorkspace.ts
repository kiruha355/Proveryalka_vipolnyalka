import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import { newKey } from "../api/api";
import { ApiError, isAbort } from "../api/errors";
import type {
  CheckLimits, FileContextRef, DialogueView, ExplanationView, DocumentSource, ModelVersion, Question, Run, RunEvent, SessionDetail, VerificationResult,
} from "../api/types";
import { DEFAULT_LIMITS, isTerminal } from "../api/types";
import { parseHistory, publicHistory, type ParsedHistory } from "../domain/dialogue";
import { loadLocal, updateLocal, type AgentRunRecord, type CheckRunRecord, type Outbox } from "./persist";
import { mergeEvents, RunTracker, type StreamStatus } from "./runTracker";
import type { AgentRunView, CheckRunView, Loadable, ModelGroup, RunFailure } from "./types";

// ---------------------------------------------------------------- reducer

interface RunsState {
  agent: Record<string, AgentRunView>;
  agentOrder: string[];
  checks: Record<string, CheckRunView>;
  checkOrder: string[];
}

type Action =
  | { type: "agent/add"; view: AgentRunView }
  | { type: "agent/events"; runId: string; events: RunEvent[] }
  | { type: "agent/stream"; runId: string; stream: StreamStatus }
  | { type: "agent/run"; run: Run }
  | { type: "agent/cancel"; runId: string }
  | { type: "check/add"; view: CheckRunView }
  | { type: "check/events"; runId: string; events: RunEvent[] }
  | { type: "check/stream"; runId: string; stream: StreamStatus }
  | { type: "check/run"; run: Run }
  | { type: "check/results"; runId: string; results: VerificationResult[] | null; error: unknown | null; run?: Run; afterEntryId?: string }
  | { type: "check/explanation"; runId: string; explanation: ExplanationView }
  | { type: "check/artifacts"; runId: string; artifacts: CheckRunView["artifacts"] }
  | { type: "check/cancel"; runId: string };

const INITIAL: RunsState = { agent: {}, agentOrder: [], checks: {}, checkOrder: [] };

function failureOf(events: RunEvent[]): RunFailure | null {
  const error = [...events].reverse().find((e) => e.type === "error");
  if (!error) return null;
  return { code: String(error.data.code ?? "ERROR"), message: String(error.data.message ?? "") };
}

function applyAgentEvents(view: AgentRunView, events: RunEvent[]): AgentRunView {
  const merged = mergeEvents(view.events, events);
  if (merged === view.events) return view;
  const fresh = merged.slice(view.events.length);
  let { delta, questions, proposed } = view;
  let run = view.run;
  for (const event of fresh) {
    if (event.type === "message_delta" && typeof event.data.text === "string") delta += event.data.text;
    if (event.type === "clarification_requested") {
      const question = event.data as unknown as Question;
      if (!questions.some((q) => q.id === question.id)) questions = [...questions, question];
    }
    if (event.type === "model_proposed") {
      proposed = [...proposed, event.data as unknown as AgentRunView["proposed"][number]];
    }
    if (event.type === "run_finished" && run && typeof event.data.state === "string") {
      run = { ...run, state: event.data.state as Run["state"] };
    }
  }
  return { ...view, events: merged, delta, questions, proposed, run, failure: failureOf(merged) ?? view.failure };
}

function reducer(state: RunsState, action: Action): RunsState {
  switch (action.type) {
    case "agent/add":
      if (state.agent[action.view.runId]) return state;
      return { ...state, agent: { ...state.agent, [action.view.runId]: action.view }, agentOrder: [...state.agentOrder, action.view.runId] };
    case "agent/events": {
      const view = state.agent[action.runId];
      if (!view) return state;
      const next = applyAgentEvents(view, action.events);
      return next === view ? state : { ...state, agent: { ...state.agent, [action.runId]: next } };
    }
    case "agent/stream": {
      const view = state.agent[action.runId];
      return view ? { ...state, agent: { ...state.agent, [action.runId]: { ...view, stream: action.stream } } } : state;
    }
    case "agent/run": {
      const view = state.agent[action.run.run_id];
      if (!view) return state;
      const failure = action.run.error_code ? (view.failure ?? { code: action.run.error_code, message: "" }) : view.failure;
      return { ...state, agent: { ...state.agent, [action.run.run_id]: { ...view, run: action.run, failure } } };
    }
    case "agent/cancel": {
      const view = state.agent[action.runId];
      return view ? { ...state, agent: { ...state.agent, [action.runId]: { ...view, cancelRequested: true } } } : state;
    }
    case "check/add":
      if (state.checks[action.view.runId]) return state;
      return { ...state, checks: { ...state.checks, [action.view.runId]: action.view }, checkOrder: [...state.checkOrder, action.view.runId] };
    case "check/events": {
      const view = state.checks[action.runId];
      if (!view) return state;
      const failure = failureOf(action.events);
      return { ...state, checks: { ...state.checks, [action.runId]: { ...view, failure: failure ?? view.failure } } };
    }
    case "check/stream": {
      const view = state.checks[action.runId];
      return view ? { ...state, checks: { ...state.checks, [action.runId]: { ...view, stream: action.stream } } } : state;
    }
    case "check/run": {
      const view = state.checks[action.run.run_id];
      if (!view) return state;
      const failure = action.run.error_code && !view.failure ? { code: action.run.error_code, message: "" } : view.failure;
      return { ...state, checks: { ...state.checks, [action.run.run_id]: { ...view, run: action.run, failure } } };
    }
    case "check/results": {
      const view = state.checks[action.runId];
      if (!view) return state;
      const next: CheckRunView = {
        ...view,
        results: action.results ?? view.results,
        resultsError: action.error,
        run: action.run ?? view.run,
        afterEntryId: action.afterEntryId ?? view.afterEntryId,
      };
      if (action.run?.error_code && !next.failure) next.failure = { code: action.run.error_code, message: "" };
      return { ...state, checks: { ...state.checks, [action.runId]: next } };
    }
    case "check/explanation": {
      const view = state.checks[action.runId];
      return view ? {...state, checks: {...state.checks, [action.runId]: {...view, explanation: action.explanation}}} : state;
    }
    case "check/artifacts": {
      const view = state.checks[action.runId];
      return view ? { ...state, checks: { ...state.checks, [action.runId]: { ...view, artifacts: action.artifacts } } } : state;
    }
    case "check/cancel": {
      const view = state.checks[action.runId];
      return view ? { ...state, checks: { ...state.checks, [action.runId]: { ...view, cancelRequested: true } } } : state;
    }
  }
}

function agentView(record: AgentRunRecord, sessionId: string): AgentRunView {
  const known = record.state && isTerminal(record.state as Run["state"]);
  return {
    runId: record.runId, text: record.text, questionId: record.questionId, startedAt: record.startedAt,
    run: known
      ? { run_id: record.runId, session_id: sessionId, state: record.state as Run["state"], version_id: null, error_code: record.errorCode ?? null }
      : null, events: [], stream: { kind: "connecting" }, delta: "", questions: [], proposed: [],
    failure: record.errorCode ? { code: record.errorCode, message: "" } : null, cancelRequested: false,
  };
}

function checkView(record: CheckRunRecord | Omit<CheckRunRecord, "startedAt"> & { startedAt: string | null }): CheckRunView {
  return {
    ...record, run: null, results: null, resultsError: null, stream: { kind: "connecting" }, failure: null,
    artifacts: { data: null, error: null, loading: false }, cancelRequested: false,
  };
}

// ---------------------------------------------------------------- hook

export interface SendState {
  sending: boolean;
  /** An unsent message kept with its idempotency key for a safe retry. */
  outbox: Outbox | null;
  error: unknown | null;
}

export interface CheckStartState {
  starting: boolean;
  error: unknown | null;
  /** Retry reuses the key of the failed request. */
  retry: (() => void) | null;
}

export interface UploadState {
  uploading: string | null;
  error: unknown | null;
  documents: DocumentSource[];
}

export interface SessionWorkspace {
  detail: Loadable<SessionDetail>;
  dialogue: DialogueView | null;
  discardPending(): Promise<void>;
  analyzeDocument(document: DocumentSource): Promise<boolean>;
  retryExplanation(runId: string): Promise<void>;
  history: ParsedHistory | null;
  models: Loadable<ModelGroup[]>;
  versions: ModelVersion[];
  agentRuns: AgentRunView[];
  activeAgentRun: AgentRunView | null;
  /** Latest finished agent run, for the failure/cancel line under the pending message. */
  lastAgentRun: AgentRunView | null;
  checks: CheckRunView[];
  send: SendState;
  sendMessage(text: string, questionId: string | null, fileContext?: FileContextRef | null): Promise<boolean>;
  retryOutbox(): Promise<boolean>;
  discardOutbox(): void;
  retryPending(): Promise<boolean>;
  cancelAgent(): Promise<void>;
  checkStart: CheckStartState;
  startCheck(version: ModelVersion, propertyIds: string[] | null, limits: CheckLimits): Promise<string | null>;
  cancelCheck(runId: string): Promise<void>;
  reconnect(runId: string): void;
  approve(version: ModelVersion): Promise<void>;
  approveError: unknown | null;
  reloadDetail(): void;
  reloadModels(): Promise<void>;
  loadArtifacts(runId: string): void;
  upload: UploadState;
  uploadDocument(file: File): Promise<DocumentSource | null>;
}

export interface SessionWorkspaceOptions {
  api: ProveryalkaApi;
  capabilities: ApiCapabilities;
  sessionId: string;
  onModelProposed?: (proposal: { model_id: string; version_id: string; number: number }) => void;
}

export function useSessionWorkspace({ api, capabilities, sessionId, onModelProposed }: SessionWorkspaceOptions): SessionWorkspace {
  const [runs, dispatch] = useReducer(reducer, INITIAL);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [detail, setDetail] = useState<Loadable<SessionDetail>>({ data: null, error: null, loading: true });
  const [dialogue, setDialogue] = useState<DialogueView | null>(null);
  const [models, setModels] = useState<Loadable<ModelGroup[]>>({ data: null, error: null, loading: true });
  const [send, setSend] = useState<SendState>(() => ({ sending: false, outbox: loadLocal(api.id, sessionId).outbox, error: null }));
  const [checkStart, setCheckStart] = useState<CheckStartState>({ starting: false, error: null, retry: null });
  const [approveError, setApproveError] = useState<unknown | null>(null);
  const [upload, setUpload] = useState<UploadState>({ uploading: null, error: null, documents: [] });

  const root = useRef<AbortController>(new AbortController());
  const trackers = useRef(new Map<string, RunTracker>());
  const sendingRef = useRef(false);
  const startingRef = useRef(false);
  const uploadingRef = useRef(false);
  const explainingRef = useRef(new Set<string>());
  const detailSeq = useRef(0);
  const modelsSeq = useRef(0);
  const proposedRef = useRef(onModelProposed);
  proposedRef.current = onModelProposed;
  const addCheckRef = useRef<(record: Parameters<typeof checkView>[0]) => void>(() => undefined);

  // ---- loading

  const reloadDetail = useCallback(() => {
    const seq = ++detailSeq.current;
    setDetail((d) => ({ ...d, loading: true }));
    const signal = root.current.signal;
    Promise.all([api.getSession(sessionId, signal), capabilities.dialogue && api.getDialogue ? api.getDialogue(sessionId, signal) : Promise.resolve(null)]).then(
      ([data, publicView]) => {
        if (signal.aborted || seq !== detailSeq.current) return;
        setDetail({ data, error: null, loading: false }); setDialogue(publicView);
        setUpload(u => ({...u, documents: (data.documents ?? []).map(d => ({id: d.source_id, session_id: sessionId,
          filename: d.filename, media_type: d.media_type, size: d.size_bytes, status: "extracted" as const,
          text: data.sources.find(source => source.id === d.source_id)?.text ?? null, error: null}))}));
      },
      (error: unknown) => { if (!isAbort(error) && seq === detailSeq.current) setDetail((d) => ({ data: d.data, error, loading: false })); },
    );
  }, [api, sessionId, capabilities.dialogue]);

  const discoverChecks = useCallback(async (groups: ModelGroup[]) => {
    if (!capabilities.checkDiscovery || !api.listCheckRuns) return;
    for (const group of groups) {
      for (const version of group.versions) {
        try {
          const ids = await api.listCheckRuns(version.id, root.current.signal);
          for (const runId of ids) addCheckRef.current({ runId, versionId: version.id, modelId: group.model.id, number: version.number, propertyIds: null, startedAt: null });
        } catch (error) {
          if (isAbort(error)) return;
        }
      }
    }
  }, [api, capabilities.checkDiscovery]);

  const reloadModels = useCallback(() => {
    const seq = ++modelsSeq.current;
    setModels((m) => ({ ...m, loading: true }));
    const signal = root.current.signal;
    return (async () => {
      const list = await api.listModels(sessionId, root.current.signal);
      const groups = await Promise.all(list.map(async (model) => ({ model, versions: await api.listVersions(model.id, root.current.signal) })));
      return groups;
    })().then(
      (groups) => {
        if (signal.aborted || seq !== modelsSeq.current) return;
        setModels({ data: groups, error: null, loading: false });
        void discoverChecks(groups);
      },
      (error: unknown) => { if (!isAbort(error) && seq === modelsSeq.current) setModels((m) => ({ data: m.data, error, loading: false })); },
    );
  }, [api, sessionId, discoverChecks]);

  // ---- run tracking

  const checkRequestSeq = useRef(new Map<string, number>());
  const fetchCheckRef = useRef<(id: string) => void>(() => undefined);
  const followExplanation = useCallback((checkId: string, explanation?: ExplanationView) => {
    if (!explanation) return;
    dispatch({type: "check/explanation", runId: checkId, explanation});
    if (!["queued", "running"].includes(explanation.state) || !explanation.run_id) return;
    const id = explanation.run_id;
    if (trackers.current.has(id) || root.current.signal.aborted) return;
    const tracker = new RunTracker({api, runId: id,
      onStatus: status => { if (status.kind === "lost") dispatch({type: "check/explanation", runId: checkId,
        explanation: {...explanation, state: "failed", error_code: "CONNECTION_LOST"}}); },
      onEvent: event => { if (event.type === "run_finished" || event.type === "explanation_ready") fetchCheckRef.current(checkId); },
    });
    trackers.current.set(id, tracker); tracker.start();
  }, [api]);

  const fetchCheck = useCallback((runId: string) => {
    const sequence = (checkRequestSeq.current.get(runId) ?? 0) + 1;
    checkRequestSeq.current.set(runId, sequence);
    const signal = root.current.signal;
    api.getCheck(runId, signal).then(
      (check) => {
        if (signal.aborted || checkRequestSeq.current.get(runId) !== sequence) return;
        dispatch({ type: "check/results", runId, results: check.results, error: null, run: check.run, afterEntryId: check.after_entry_id });
        followExplanation(runId, check.explanation);
      },
      (error: unknown) => { if (!isAbort(error)) dispatch({ type: "check/results", runId, results: null, error }); },
    );
  }, [api, followExplanation]);
  fetchCheckRef.current = fetchCheck;

  const loadArtifacts = useCallback((runId: string) => {
    if (!capabilities.artifacts) return;
    dispatch({ type: "check/artifacts", runId, artifacts: { data: null, error: null, loading: true } });
    api.listArtifacts(runId, root.current.signal).then(
      (data) => dispatch({ type: "check/artifacts", runId, artifacts: { data, error: null, loading: false } }),
      (error: unknown) => { if (!isAbort(error)) dispatch({ type: "check/artifacts", runId, artifacts: { data: null, error, loading: false } }); },
    );
  }, [api, capabilities.artifacts]);

  const refreshRun = useCallback(async (runId: string, kind: "agent" | "check") => {
    try {
      const run = await api.getRun(runId, root.current.signal);
      dispatch({ type: kind === "agent" ? "agent/run" : "check/run", run });
      return run;
    } catch {
      return null;
    }
  }, [api]);

  const persistAgentOutcome = useCallback((runId: string, run: Run | null) => {
    if (!run) return;
    updateLocal(api.id, sessionId, (local) => ({
      ...local,
      agentRuns: local.agentRuns.map((r) => (r.runId === runId ? { ...r, state: run.state, errorCode: run.error_code } : r)),
    }));
  }, [api.id, sessionId]);

  const track = useCallback((kind: "agent" | "check", runId: string) => {
    if (trackers.current.has(runId) || root.current.signal.aborted) return;
    const tracker = new RunTracker({
      api,
      runId,
      onStatus: (stream) => dispatch({ type: kind === "agent" ? "agent/stream" : "check/stream", runId, stream }),
      onEvent: (event) => {
        if (kind === "agent") {
          dispatch({ type: "agent/events", runId, events: [event] });
          if (event.type === "model_proposed") {
            reloadModels();
            proposedRef.current?.(event.data as { model_id: string; version_id: string; number: number });
          }
          if (event.type === "run_finished") {
            void refreshRun(runId, "agent").then((run) => persistAgentOutcome(runId, run));
            reloadDetail();
            reloadModels();
          }
        } else {
          dispatch({ type: "check/events", runId, events: [event] });
          if (event.type === "check_finished") fetchCheck(runId);
          if (event.type === "run_finished") {
            fetchCheck(runId);
            void refreshRun(runId, "check").then((run) => { if (run?.state === "completed") loadArtifacts(runId); });
          }
        }
      },
    });
    trackers.current.set(runId, tracker);
    tracker.start();
  }, [api, fetchCheck, loadArtifacts, persistAgentOutcome, refreshRun, reloadDetail, reloadModels]);

  const addCheck = useCallback((record: Parameters<typeof checkView>[0]) => {
    if (runsRef.current.checks[record.runId]) return;
    dispatch({ type: "check/add", view: checkView(record) });
    api.getCheck(record.runId, root.current.signal).then(
      (check) => {
        if (root.current.signal.aborted) return;
        dispatch({ type: "check/results", runId: record.runId, results: check.results, error: null, run: check.run, afterEntryId: check.after_entry_id });
        followExplanation(record.runId, check.explanation);
        if (!isTerminal(check.run.state)) track("check", record.runId);
        else {
          dispatch({ type: "check/stream", runId: record.runId, stream: { kind: "closed" } });
          if (check.run.state === "completed") loadArtifacts(record.runId);
        }
      },
      (error: unknown) => {
        if (isAbort(error)) return;
        dispatch({ type: "check/results", runId: record.runId, results: null, error });
        dispatch({ type: "check/stream", runId: record.runId, stream: { kind: "lost", error } });
      },
    );
  }, [api, loadArtifacts, track, followExplanation]);
  addCheckRef.current = addCheck;

  // ---- mount / unmount

  useEffect(() => {
    root.current = new AbortController();
    const map = trackers.current;
    reloadDetail();
    reloadModels();
    const local = loadLocal(api.id, sessionId);
    const latest = local.agentRuns[local.agentRuns.length - 1];
    if (latest) {
      dispatch({ type: "agent/add", view: agentView(latest, sessionId) });
      if (!latest.state || !isTerminal(latest.state as Run["state"])) {
        void refreshRun(latest.runId, "agent").then((run) => {
          if (root.current.signal.aborted) return;
          if (!run) {
            dispatch({ type: "agent/stream", runId: latest.runId, stream: { kind: "lost", error: new ApiError("network", "Состояние запуска неизвестно") } });
          } else if (!isTerminal(run.state)) {
            track("agent", latest.runId);
          } else {
            dispatch({ type: "agent/stream", runId: latest.runId, stream: { kind: "closed" } });
            persistAgentOutcome(latest.runId, run);
          }
        });
      } else {
        dispatch({ type: "agent/stream", runId: latest.runId, stream: { kind: "closed" } });
      }
    }
    for (const record of local.checkRuns) addCheck(record);
    return () => {
      root.current.abort();
      for (const tracker of map.values()) tracker.stop();
      map.clear();
    };
    // Mount-only: the owning component is keyed by session id.
  }, []);

  useEffect(() => {
    const pending = dialogue?.pending;
    if (!pending?.run_id || !pending.run_state || isTerminal(pending.run_state) || runsRef.current.agent[pending.run_id]) return;
    const record = {runId: pending.run_id, text: pending.text, questionId: pending.question_id, startedAt: ""};
    dispatch({type: "agent/add", view: {...agentView(record, sessionId), run: {run_id: pending.run_id,
      session_id: sessionId, state: pending.run_state, version_id: null, error_code: null}}});
    track("agent", pending.run_id);
  }, [dialogue, sessionId, track]);

  // ---- sending

  const dispatchSend = useCallback(async (outbox: Outbox): Promise<boolean> => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    updateLocal(api.id, sessionId, (local) => ({ ...local, outbox }));
    setSend({ sending: true, outbox, error: null });
    try {
      const body = outbox.fileContext ? {text: outbox.text, file_context: {generation_id:outbox.fileContext.generation_id, version_id:outbox.fileContext.version_id, path:outbox.fileContext.path, sha256:outbox.fileContext.sha256}} : outbox.sourceId ? {source_id: outbox.sourceId} : outbox.questionId ? { text: outbox.text, question_id: outbox.questionId } : { text: outbox.text };
      const run = outbox.pendingRetry && api.retryPending
        ? await api.retryPending(sessionId, outbox.key, root.current.signal)
        : await api.sendMessage(sessionId, body, outbox.key, root.current.signal);
      if (root.current.signal.aborted) return false;
      const record: AgentRunRecord = { runId: run.run_id, text: outbox.text, questionId: outbox.questionId, startedAt: new Date().toISOString() };
      updateLocal(api.id, sessionId, (local) => ({
        ...local, outbox: null, draft: "",
        agentRuns: local.agentRuns.some((r) => r.runId === run.run_id) ? local.agentRuns : [...local.agentRuns, record],
      }));
      dispatch({ type: "agent/add", view: { ...agentView(record, sessionId), run } });
      if (isTerminal(run.state)) {
        // A replayed key can return a run that already finished; read its events once.
        void refreshRun(run.run_id, "agent");
      }
      track("agent", run.run_id);
      setSend({ sending: false, outbox: null, error: null });
      return true;
    } catch (error) {
      if (isAbort(error)) return false;
      const keep = error instanceof ApiError && error.retryable;
      const kept = keep ? { ...outbox, autoSend: false } : null;
      updateLocal(api.id, sessionId, (local) => ({ ...local, outbox: kept }));
      setSend({ sending: false, outbox: kept, error });
      return false;
    } finally {
      sendingRef.current = false;
    }
  }, [api, refreshRun, sessionId, track]);

  const sendMessage = useCallback((text: string, questionId: string | null, fileContext: FileContextRef | null = null) => {
    const current = send.outbox;
    if (current && (current.text !== text || current.questionId !== questionId || JSON.stringify(current.fileContext ?? null) !== JSON.stringify(fileContext))) return Promise.resolve(false);
    // Same text and target as the unsent message: reuse its key so a lost response cannot duplicate the run.
    const outbox = current && current.text === text && current.questionId === questionId
      ? current
      : { text, questionId, fileContext, key: newKey() };
    return dispatchSend(outbox);
  }, [dispatchSend, send.outbox]);

  const retryOutbox = useCallback(() => (send.outbox ? dispatchSend(send.outbox) : Promise.resolve(false)), [dispatchSend, send.outbox]);

  const discardOutbox = useCallback(() => {
    updateLocal(api.id, sessionId, (local) => ({ ...local, outbox: null }));
    setSend({ sending: false, outbox: null, error: null });
  }, [api.id, sessionId]);

  // Message composed before the session existed (new chat): send it once.
  // Deferred so a StrictMode mount/unmount/mount cycle schedules one request.
  useEffect(() => {
    const timer = setTimeout(() => {
      const local = loadLocal(api.id, sessionId);
      if (local.outbox?.autoSend) void dispatchSend(local.outbox);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const history = useMemo(() => detail.data ? (capabilities.dialogue ? (dialogue ? publicHistory(dialogue, detail.data) : null) : parseHistory(detail.data.messages)) : null, [detail.data, dialogue, capabilities.dialogue]);

  const retryPending = useCallback(() => {
    const pending = history?.pending;
    if (!pending) return Promise.resolve(false);
    // The server resumes an unfinished turn only for the same text and a new key.
    return dispatchSend({ text: pending.text, questionId: pending.questionId, key: newKey(), pendingRetry: capabilities.dialogue });
  }, [dispatchSend, history?.pending, capabilities.dialogue]);

  const discardPending = useCallback(async () => {
    if (!api.discardPending) return;
    try { setDialogue(await api.discardPending(sessionId, root.current.signal)); reloadDetail(); }
    catch (error) { if (!isAbort(error)) setSend(s => ({...s, error})); }
  }, [api, sessionId, reloadDetail]);
  const analyzeDocument = useCallback((document: DocumentSource) => dispatchSend({text: document.text ?? document.filename,
    questionId: null, sourceId: document.id, key: newKey()}), [dispatchSend]);
  const retryExplanation = useCallback(async (runId: string) => {
    if (!api.retryExplanation || explainingRef.current.has(runId)) return;
    explainingRef.current.add(runId);
    try {
      const run = await api.retryExplanation(runId, newKey(), root.current.signal);
      followExplanation(runId, {state: "queued", run_id: run.run_id, error_code: null, narrative: null});
    } catch (error) { if (!isAbort(error)) dispatch({type: "check/explanation", runId,
      explanation: {state: "failed", run_id: null, error_code: error instanceof ApiError ? error.code ?? error.message : String(error), narrative: null}}); }
    finally { explainingRef.current.delete(runId); }
  }, [api, followExplanation]);

  const agentRuns = runs.agentOrder.map((id) => runs.agent[id]).filter((v): v is AgentRunView => Boolean(v));
  const activeAgentRun = [...agentRuns].reverse().find((v) => !v.run || !isTerminal(v.run.state)) ?? null;
  const lastAgentRun = agentRuns[agentRuns.length - 1] ?? null;

  const cancelAgent = useCallback(async () => {
    const view = activeAgentRun;
    if (!view) return;
    dispatch({ type: "agent/cancel", runId: view.runId });
    try {
      const run = await api.cancelRun(view.runId, root.current.signal);
      dispatch({ type: "agent/run", run });
    } catch (error) {
      if (!isAbort(error)) setSend((s) => ({ ...s, error }));
    }
  }, [activeAgentRun, api]);

  // ---- checks

  const startCheck = useCallback(async (version: ModelVersion, propertyIds: string[] | null, limits: CheckLimits) => {
    if (startingRef.current) return null;
    startingRef.current = true;
    const key = newKey();
    const custom = limits.timeout_seconds !== DEFAULT_LIMITS.timeout_seconds || limits.max_states !== DEFAULT_LIMITS.max_states || limits.max_depth !== DEFAULT_LIMITS.max_depth;
    const body = { property_ids: propertyIds, ...(custom ? { limits } : {}), ...(capabilities.explanations ? {explain: true} : {}) };
    let inFlight = false;
    const attempt = async (): Promise<string | null> => {
      if (inFlight) return null;
      inFlight = true;
      startingRef.current = true;
      setCheckStart({ starting: true, error: null, retry: null });
      try {
        const signal = root.current.signal;
        const run = await api.createCheck(version.model_id, version.number, body, key, signal);
        if (signal.aborted) return null;
        const record: CheckRunRecord = {
          runId: run.run_id, versionId: version.id, modelId: version.model_id, number: version.number,
          propertyIds, startedAt: new Date().toISOString(),
        };
        updateLocal(api.id, sessionId, (local) => ({
          ...local, checkRuns: local.checkRuns.some((r) => r.runId === run.run_id) ? local.checkRuns : [...local.checkRuns, record],
        }));
        dispatch({ type: "check/add", view: { ...checkView(record), run, results: [] } });
        track("check", run.run_id);
        setCheckStart({ starting: false, error: null, retry: null });
        return run.run_id;
      } catch (error) {
        if (isAbort(error)) return null;
        const retryable = error instanceof ApiError && error.retryable;
        setCheckStart({ starting: false, error, retry: retryable ? () => { void attempt(); } : null });
        return null;
      } finally {
        startingRef.current = false;
        inFlight = false;
      }
    };
    return attempt();
  }, [api, sessionId, track, capabilities.explanations]);

  const cancelCheck = useCallback(async (runId: string) => {
    dispatch({ type: "check/cancel", runId });
    try {
      const run = await api.cancelRun(runId, root.current.signal);
      dispatch({ type: "check/run", run });
    } catch (error) {
      if (!isAbort(error)) dispatch({ type: "check/results", runId, results: null, error });
    }
  }, [api]);

  const reconnect = useCallback((runId: string) => {
    const tracker = trackers.current.get(runId);
    if (tracker) tracker.reconnect();
    else track(runs.agent[runId] ? "agent" : "check", runId);
  }, [runs.agent, track]);

  const approve = useCallback(async (version: ModelVersion) => {
    setApproveError(null);
    try {
      const updated = await api.approveVersion(version.model_id, version.number, root.current.signal);
      setModels((m) => (m.data ? {
        ...m,
        data: m.data.map((g) => ({ ...g, versions: g.versions.map((v) => (v.id === updated.id ? updated : v)) })),
      } : m));
    } catch (error) {
      if (!isAbort(error)) setApproveError(error);
    }
  }, [api]);

  const uploadDocument = useCallback(async (file: File) => {
    if (!capabilities.documents || !api.uploadDocument || uploadingRef.current) return null;
    uploadingRef.current = true;
    setUpload((u) => ({ ...u, uploading: file.name, error: null }));
    try {
      const document = await api.uploadDocument(sessionId, file, newKey(), root.current.signal);
      setUpload((u) => ({ uploading: null, error: null, documents: [...u.documents.filter((d) => d.id !== document.id), document] }));
      reloadDetail();
      return document;
    } catch (error) {
      if (!isAbort(error)) setUpload((u) => ({ ...u, uploading: null, error }));
      return null;
    }
    finally { uploadingRef.current = false; }
  }, [api, capabilities.documents, reloadDetail, sessionId]);

  const versions = useMemo(() => (models.data ?? []).flatMap((g) => g.versions), [models.data]);
  const checks = runs.checkOrder.map((id) => runs.checks[id]).filter((v): v is CheckRunView => Boolean(v)).reverse();

  return {
    detail, dialogue, discardPending, analyzeDocument, retryExplanation, history, models, versions, agentRuns, activeAgentRun, lastAgentRun, checks,
    send, sendMessage, retryOutbox, discardOutbox, retryPending, cancelAgent,
    checkStart, startCheck, cancelCheck, reconnect, approve, approveError,
    reloadDetail, reloadModels, loadArtifacts, upload, uploadDocument,
  };
}
