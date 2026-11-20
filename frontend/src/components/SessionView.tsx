import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import type { CheckLimits, FileContextRef, ModelVersion, Session } from "../api/types";
import { DEFAULT_LIMITS } from "../api/types";
import {loadLocal, updateLocal} from "../state/persist";
import {focusGeneratedFile} from "../extensions/load";
import { CoreContext, type CoreActions } from "../app/core";
import type { Route } from "../app/route";
import { WorkspaceContext, type ElementRef, type TraceFocus, type WorkspaceContextValue } from "../app/workspace";
import { indexRequirements } from "../domain/requirements";
import { traceRole } from "../domain/status";
import { buildSteps, focusIndex } from "../domain/trace";
import { useSessionWorkspace } from "../state/useSessionWorkspace";
import type { Loadable, ModelGroup } from "../state/types";
import { ChatPanel } from "./chat/ChatPanel";
import type { ComposerHandle } from "./chat/Composer";
import { ErrorNotice, QuietStatus } from "./Notice";
import { PaneSeparator, usePaneWidth } from "./PaneSeparator";
import { WorkspacePanel } from "./workspace/WorkspacePanel";

interface Props {
  api: ProveryalkaApi;
  capabilities: ApiCapabilities;
  sessionId: string;
  listed: Session | undefined;
  route: Route;
  navigate(route: Route, options?: { replace?: boolean }): void;
  onReturnToChats?: () => void;
}

export type VersionResolution =
  | { status: "loading"; version: null }
  | { status: "error"; version: null }
  | { status: "missing"; version: null; requestedModelId?: string; requestedVersion?: number }
  | { status: "ready"; version: ModelVersion | null };

export function defaultVersion(groups: ModelGroup[]): ModelVersion | null {
  const group = groups.find((g) => g.versions.length > 0);
  return group ? group.versions[group.versions.length - 1] ?? null : null;
}

export function resolveVersionState(
  route: Route,
  models: Loadable<ModelGroup[]>,
  versions: ModelVersion[],
): VersionResolution {
  const groups = models.data ?? [];
  const hasExplicitTarget = Boolean(route.modelId) || route.version !== undefined;

  if (!hasExplicitTarget) {
    if (models.loading && !models.data) return { status: "loading", version: null };
    if (models.error !== null && !models.data) return { status: "error", version: null };
    return { status: "ready", version: defaultVersion(groups) };
  }

  let matched: ModelVersion | undefined;
  if (route.modelId && route.version !== undefined) {
    matched = versions.find((v) => v.model_id === route.modelId && v.number === route.version);
  } else if (route.modelId) {
    const group = groups.find((g) => g.model.id === route.modelId);
    matched = group && group.versions.length > 0 ? group.versions[group.versions.length - 1] : undefined;
  } else if (route.version !== undefined) {
    const matches = versions.filter((v) => v.number === route.version);
    matched = matches.length === 1 ? matches[0] : undefined;
  }

  if (matched) return { status: "ready", version: matched };
  if (models.loading) return { status: "loading", version: null };
  if (models.error !== null && !models.data) return { status: "error", version: null };
  return {
    status: "missing",
    version: null,
    requestedModelId: route.modelId,
    requestedVersion: route.version,
  };
}

export function resolveTrace(version: ModelVersion | null, checks: WorkspaceContextValue["checks"], route: Route): TraceFocus | null {
  if (!version || !route.check || !route.property) return null;
  const check = checks.find((c) => c.runId === route.check);
  // Only a result produced for this exact version and model hash is shown as its trace.
  const result = check?.results?.find((r) => r.property_id === route.property && r.version_id === version.id && r.spec_hash === version.spec_hash);
  if (!check || !result) return null;
  const property = version.spec.properties.find((p) => p.id === result.property_id);
  const role = traceRole(result, property?.kind);
  const steps = buildSteps(result, version.spec, property);
  const focus = focusIndex(steps, property, role);
  const wanted = route.step ?? focus ?? 0;
  const step = Math.max(0, Math.min(wanted, Math.max(0, steps.length - 1)));
  return { check, result, property, role, steps, step, focus };
}

export function SessionView({ api, capabilities, sessionId, listed, route, navigate, onReturnToChats }: Props) {
  const chatPane = usePaneWidth("proveryalka:chat-width", .36, 250, 390, .65);
  const lifetime = useRef(new AbortController());
  useEffect(() => {const controller = new AbortController(); lifetime.current = controller; return () => controller.abort();}, []);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [pane, setPane] = useState<"chat" | "workspace">("chat");
  const [element, setElement] = useState<ElementRef | null>(null);
  const [fileContext, setFileContext] = useState<FileContextRef | null>(()=>loadLocal(api.id,sessionId).draftFileContext ?? null);
  const fileReply = (ref: FileContextRef | null) => {setFileContext(ref); updateLocal(api.id, sessionId, local=>({...local,draftFileContext:ref}));};
  const [reply, setReplyState] = useState<string | null>(()=>loadLocal(api.id,sessionId).draftQuestionId ?? null);
  const setReply = (questionId: string | null) => {
    setReplyState(questionId);
    updateLocal(api.id,sessionId,local=>({...local,draftQuestionId:questionId}));
    if (questionId) fileReply(null);
  };
  const [selectedByVersion, setSelectedByVersion] = useState<Record<string, string[]>>({});
  const [limits, setLimits] = useState<CheckLimits>(DEFAULT_LIMITS);
  const composer = useRef<ComposerHandle>(null);

  const go = useCallback((patch: Partial<Route>) => {
    const next: Route = { ...routeRef.current, ...patch, sessionId, error: undefined };
    routeRef.current = next;
    navigate(next, { replace: true });
  }, [navigate, sessionId]);

  const workspace = useSessionWorkspace({
    api, capabilities, sessionId,
    onModelProposed: (proposal) => { setElement(null); go({ modelId: proposal.model_id, version: proposal.number, check: undefined, property: undefined, step: undefined }); },
  });

  const groups = workspace.models.data ?? [];
  const versionState = useMemo(
    () => resolveVersionState(route, workspace.models, workspace.versions),
    [route, workspace.models, workspace.versions],
  );
  const version = versionState.version;
  const fallbackVersion = useMemo(() => defaultVersion(groups), [groups]);

  useEffect(() => {
    if (versionState.status === "missing") setPane("workspace");
  }, [versionState.status]);

  const openFallback = useCallback(() => {
    if (!fallbackVersion) return;
    setElement(null);
    go({
      modelId: fallbackVersion.model_id,
      version: fallbackVersion.number,
      check: undefined,
      property: undefined,
      step: undefined,
    });
    setPane("workspace");
  }, [fallbackVersion, go]);

  const returnToChats = useCallback(() => {
    if (onReturnToChats) onReturnToChats();
    else navigate({ sessionId: null });
  }, [onReturnToChats, navigate]);

  const session: Session | undefined = workspace.detail.data ?? listed;
  const checks = useMemo(() => (version ? workspace.checks.filter((c) => c.versionId === version.id) : []), [version, workspace.checks]);
  const trace = resolveTrace(version, checks, route);
  const requirements = useMemo(() => (version ? indexRequirements(version.spec.requirements, version.spec.sources) : null), [version]);
  const allProps = version?.spec.properties.map((p) => p.id) ?? [];
  const selectedProperties = version ? selectedByVersion[version.id] ?? allProps : [];

  const context = useMemo<WorkspaceContextValue | null>(() => {
    if (!session) return null;
    return {
      api, capabilities, session,
      versions: workspace.versions,
      version,
      requirements,
      checks,
      trace,
      selection: {
        versionId: version?.id ?? null,
        element,
        trace: trace
          ? { checkRunId: trace.check.runId, propertyId: trace.result.property_id, step: trace.step }
          : (route.check ? { checkRunId: route.check, propertyId: route.property ?? "", step: route.step ?? 0 } : null),
      },
      select: (next) => {
        setElement(next);
        if (next) setPane("workspace");
      },
      focusTrace: (target) => {
        if (!target) go({ check: undefined, property: undefined, step: undefined });
        else go({ check: target.checkRunId, property: target.propertyId || undefined, step: target.step });
      },
      setTraceStep: (step) => {
        if (!trace) return;
        go({ step: Math.max(0, Math.min(step, trace.steps.length - 1)) });
      },
      createVersion: capabilities.adapter === "http" && api.createVersion ? async (modelId, body, key) => {
        const signal = lifetime.current.signal;
        const created = await api.createVersion!(modelId, body, key, signal);
        if (signal.aborted) throw new DOMException("Session changed", "AbortError");
        await workspace.reloadModels();
        if (signal.aborted) throw new DOMException("Session changed", "AbortError");
        setElement(null);
        go({modelId: created.model_id, version: created.number, check: undefined, property: undefined, step: undefined});
        return created;
      } : undefined,
      selectVersion: (versionId) => {
        const target = workspace.versions.find((v) => v.id === versionId);
        if (!target || target.id === version?.id) return;
        setElement(null);
        go({ modelId: target.model_id, version: target.number, check: undefined, property: undefined, step: undefined });
      },
      discussFile: capabilities.agent && capabilities.fileDialogue ? (ref) => {
        fileReply(ref); setReply(null); setPane("chat");
        requestAnimationFrame(()=>composer.current?.prefill(`Объясни файл ${ref.path} из генерации ${ref.generation_id}, версия ${ref.version_number ?? ref.version_id}. Как в нём реализованы правила этой модели? Ничего не изменяй.`));
      } : undefined,
      openGeneratedFile: (ref) => {
        const target=workspace.versions.find(v=>v.id===ref.version_id);
        if (!target) return;
        if (target.id !== version?.id) setElement(null);
        focusGeneratedFile(ref); go({modelId:target.model_id,version:target.number,view:"files",check:undefined,property:undefined,step:undefined});setPane("workspace");
      },
      openView: (viewId) => {
        go({ view: viewId });
        setPane("workspace");
      },
      openLocation: (target) => {
        const nextVersion = target.modelId && target.version !== undefined
          ? workspace.versions.find((v) => v.model_id === target.modelId && v.number === target.version)
          : undefined;
        if (nextVersion && nextVersion.id !== version?.id) {
          setElement(null);
        }
        const patch: Partial<Route> = {};
        if ("modelId" in target) patch.modelId = target.modelId;
        if ("version" in target) patch.version = target.version;
        if ("view" in target) patch.view = target.view;
        if ("check" in target) patch.check = target.check;
        if ("property" in target) patch.property = target.property;
        if ("step" in target) patch.step = target.step;
        go(patch);
        setPane("workspace");
      },
    };
  }, [api, capabilities, session, workspace.versions, version, requirements, checks, trace, element, route.check, route.property, route.step, go]);

  const core = useMemo<CoreActions>(() => ({
    workspace,
    history: workspace.history,
    selectedProperties,
    setSelectedProperties: (ids) => { if (version) setSelectedByVersion((s) => ({ ...s, [version.id]: ids })); },
    limits,
    setLimits,
    runCheck: () => {
      if (!version || selectedProperties.length === 0) return;
      void workspace.startCheck(version, null, DEFAULT_LIMITS).then((runId) => {
        if (runId) go({ modelId: version.model_id, version: version.number, view: "check", check: runId, property: undefined, step: undefined });
      });
      setPane("workspace");
    },
    composeMessage: (text) => {
      setReply(null);
      setPane("chat");
      requestAnimationFrame(() => composer.current?.prefill(text));
    },
    replyTo: (questionId) => {
      setReply(capabilities.questionId ? questionId : null);
      setPane("chat");
      requestAnimationFrame(() => composer.current?.focus());
    },
  }), [workspace, selectedProperties, version, limits, go, capabilities.questionId]);

  if (!context) {
    return (
      <div className="session session--loading">
        {workspace.detail.error !== null
          ? <ErrorNotice error={workspace.detail.error} title="Сессия не загружена"
              action={
                <>
                  <button type="button" className="button button--small" onClick={workspace.reloadDetail}>Повторить</button>
                  <button type="button" className="button button--small button--ghost" onClick={returnToChats}>Вернуться к чатам</button>
                </>
              } />
          : <QuietStatus busy>Загрузка сессии</QuietStatus>}
      </div>
    );
  }

  return (
    <CoreContext.Provider value={core}>
      <WorkspaceContext.Provider value={context}>
        <div ref={chatPane.container} style={chatPane.style} className={`session session--${pane}`}>
          <div className="pane-switch" role="group" aria-label="Панель">
            <button type="button" aria-pressed={pane === "chat"} onClick={() => setPane("chat")}>Чат</button>
            <button type="button" aria-pressed={pane === "workspace"} onClick={() => setPane("workspace")}>Модель и проверка</button>
          </div>
          <ChatPanel fileContext={fileContext} onClearFile={()=>fileReply(null)} context={context} replyQuestionId={reply} onReply={setReply} composerRef={composer} />
          <PaneSeparator pane={chatPane} label="Ширина чата"/>
          <WorkspacePanel
            context={context}
            viewId={route.view}
            versionState={versionState}
            fallbackVersion={fallbackVersion}
            onOpenFallback={openFallback}
            onReturnToChats={returnToChats}
          />
        </div>
      </WorkspaceContext.Provider>
    </CoreContext.Provider>
  );
}
