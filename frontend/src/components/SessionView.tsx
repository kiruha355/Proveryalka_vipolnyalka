import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import type { CheckLimits, ModelVersion, Session } from "../api/types";
import { DEFAULT_LIMITS } from "../api/types";
import { CoreContext, type CoreActions } from "../app/core";
import type { Route } from "../app/route";
import { WorkspaceContext, type ElementRef, type TraceFocus, type WorkspaceContextValue } from "../app/workspace";
import { indexRequirements } from "../domain/requirements";
import { traceRole } from "../domain/status";
import { buildSteps, focusIndex } from "../domain/trace";
import { useSessionWorkspace } from "../state/useSessionWorkspace";
import type { ModelGroup } from "../state/types";
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
}

export function defaultVersion(groups: ModelGroup[]): ModelVersion | null {
  const group = groups.find((g) => g.versions.length > 0);
  return group ? group.versions[group.versions.length - 1] ?? null : null;
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

export function SessionView({ api, capabilities, sessionId, listed, route, navigate }: Props) {
  const chatPane = usePaneWidth("proveryalka:chat-width", .36, 250, 390, .65);
  const lifetime = useRef(new AbortController());
  useEffect(() => {const controller = new AbortController(); lifetime.current = controller; return () => controller.abort();}, []);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [pane, setPane] = useState<"chat" | "workspace">("chat");
  const [element, setElement] = useState<ElementRef | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [selectedByVersion, setSelectedByVersion] = useState<Record<string, string[]>>({});
  const [limits, setLimits] = useState<CheckLimits>(DEFAULT_LIMITS);
  const composer = useRef<ComposerHandle>(null);

  const go = useCallback((patch: Partial<Route>) => {
    navigate({ ...routeRef.current, ...patch, sessionId }, { replace: true });
  }, [navigate, sessionId]);

  const workspace = useSessionWorkspace({
    api, capabilities, sessionId,
    onModelProposed: (proposal) => { setElement(null); go({ modelId: proposal.model_id, version: proposal.number, check: undefined, property: undefined, step: undefined }); },
  });

  const groups = workspace.models.data ?? [];
  const routed = route.modelId && route.version !== undefined
    ? workspace.versions.find((v) => v.model_id === route.modelId && v.number === route.version)
    : undefined;
  const version = routed ?? defaultVersion(groups);
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
        trace: trace ? { checkRunId: trace.check.runId, propertyId: trace.result.property_id, step: trace.step } : (route.check && route.property ? { checkRunId: route.check, propertyId: route.property, step: route.step ?? 0 } : null),
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
      openView: (viewId) => {
        go({ view: viewId });
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
              action={<button type="button" className="button button--small" onClick={workspace.reloadDetail}>Повторить</button>} />
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
          <ChatPanel context={context} replyQuestionId={reply} onReply={setReply} composerRef={composer} />
          <PaneSeparator pane={chatPane} label="Ширина чата"/>
          <WorkspacePanel context={context} viewId={route.view} />
        </div>
      </WorkspaceContext.Provider>
    </CoreContext.Provider>
  );
}
