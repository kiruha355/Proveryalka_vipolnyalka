import { useCallback, useMemo, useState } from "react";
import type { ModelVersionsPort } from "../api/http";
import type { ModelVersion, Value } from "../contracts/model";
import { normalizeSpec } from "../dsl/normalize";
import { formatExpression } from "../dsl/expression-text";
import { ProjectFilesView } from "../files/components/ProjectFilesView";
import type { ModelElementRef } from "../files/contract";
import { StateGraphWorkspace } from "../graph/components/StateGraphWorkspace";
import type { GraphSelection } from "../graph/flow-elements";
import { defaultProjection, nodeKey, projectModel } from "../graph/projection";
import { pickTraceResult } from "../graph/trace";
import { FolderIcon, GraphIcon } from "../ui/icons";
import type {
  HostElementRef,
  HostInspectorSection,
  HostModelVersion,
  HostViewProps,
  HostWorkspaceContext,
  HostWorkspaceView,
} from "./contract";

/** Модель ядра в полной форме сервера: те же значения по умолчанию, что подставляет Pydantic. */
export function normalizeVersion(version: HostModelVersion): ModelVersion {
  return { ...version, spec: normalizeSpec(version.spec) };
}
import {
  cachedManifest,
  manifestForVersion,
  implementationLinks,
  projectFilesSource,
  rememberManifest,
  setProjectFocus,
  useProjectFilesState,
} from "./project-files";

export const DIAGRAM_VIEW_ID = "diagram";
export const FILES_VIEW_ID = "files";

/** Последняя проекция диаграммы: секция инспектора «Этапы» описывает те же этапы. */
let lastProjection: { versionId: string; ids: string[] } | null = null;

function projectionFor(context: HostWorkspaceContext): string[] {
  const version = context.version;
  if (!version) return [];
  if (lastProjection?.versionId === version.id) return lastProjection.ids;
  return defaultProjection(normalizeSpec(version.spec));
}

function hostVersionsPort(
  context: HostWorkspaceContext,
): ModelVersionsPort | null {
  const create =
    context.createVersion ?? context.api.createVersion?.bind(context.api);
  if (!create) return null;
  return {
    async listVersions() {
      return context.versions.map(normalizeVersion);
    },
    createVersion: async (modelId, body, key) =>
      normalizeVersion(await create(modelId, body, key)),
  };
}

/** Вкладка «Диаграмма»: этапы выбранной версии, выбор и шаг трассы общие с ядром. */
export function DiagramView({ context }: HostViewProps) {
  const version = context.version;
  const versions = useMemo(
    () =>
      version
        ? context.versions
            .filter((item) => item.model_id === version.model_id)
            .map(normalizeVersion)
        : [],
    [context.versions, version],
  );
  const [projection, setProjection] = useState<string[]>(() =>
    projectionFor(context),
  );
  const [edge, setEdge] = useState<{
    transitionId: string;
    edgeId: string | null;
  } | null>(null);
  const [localNode, setLocalNode] = useState<string | null>(null);

  // Трасса: выбранная в ядре; иначе первое нарушение последней проверки этой версии.
  const latest =
    [...context.checks]
      .reverse()
      .find(
        (check) =>
          check.versionId === version?.id &&
          check.results &&
          check.results.length > 0,
      ) ?? null;
  const results = context.trace
    ? [context.trace.result]
    : (latest?.results ?? []);
  const autoResult = context.trace ? null : pickTraceResult(results);

  const element = context.selection.element;
  const selection: GraphSelection | null = useMemo(() => {
    if (element?.kind === "transition") {
      return {
        kind: "transition",
        transitionId: element.id,
        edgeId: edge?.transitionId === element.id ? edge.edgeId : null,
      };
    }
    if (
      element?.kind === "value" &&
      projection.length === 1 &&
      projection[0] === element.variable
    ) {
      return {
        kind: "node",
        nodeId: nodeKey({ [element.variable]: element.value }, projection),
      };
    }
    if (!element && localNode) return { kind: "node", nodeId: localNode };
    return null;
  }, [element, edge, projection, localNode]);

  const onSelectionChange = useCallback(
    (next: GraphSelection | null) => {
      setLocalNode(null);
      if (!next) {
        context.select(null);
        return;
      }
      if (next.kind === "transition") {
        setEdge({ transitionId: next.transitionId, edgeId: next.edgeId });
        context.select({ kind: "transition", id: next.transitionId });
        return;
      }
      const values = JSON.parse(next.nodeId) as Value[];
      if (
        projection.length === 1 &&
        Array.isArray(values) &&
        values.length === 1
      ) {
        context.select({
          kind: "value",
          variable: projection[0]!,
          value: values[0]!,
        });
      } else {
        // Этап из нескольких переменных не выражается одним ElementRef ядра.
        context.select(null);
        setLocalNode(next.nodeId);
      }
    },
    [context, projection],
  );

  const onTraceStepChange = useCallback(
    (index: number) => {
      if (context.trace) context.setTraceStep(index);
      else if (latest && autoResult)
        context.focusTrace({
          checkRunId: latest.runId,
          propertyId: autoResult.property_id,
          step: index,
        });
    },
    [context, latest, autoResult],
  );

  const port = useMemo(() => hostVersionsPort(context), [context]);
  if (!version) return null;
  return (
    <StateGraphWorkspace
      versions={versions}
      selectedVersionId={version.id}
      onSelectVersion={context.selectVersion}
      results={results}
      propertyId={context.trace?.result.property_id ?? null}
      onPropertyChange={(propertyId) =>
        latest && context.focusTrace({ checkRunId: latest.runId, propertyId })
      }
      versionsPort={port}
      readOnlyReason="Создание версий не подключено в этом клиенте"
      onVersionCreated={(created) => {
        // context.createVersion обновляет список и выбирает версию сам; api.createVersion — нет.
        if (!context.createVersion) context.selectVersion(created.id);
      }}
      selection={selection}
      onSelectionChange={onSelectionChange}
      traceStep={context.trace ? context.trace.step : undefined}
      onTraceStepChange={onTraceStepChange}
      showVersionPicker={false}
      showStatus={false}
      inspector="edit-only"
      onProjectionChange={(ids) => {
        setProjection(ids);
        lastProjection = { versionId: version.id, ids };
      }}
    />
  );
}

function ruleToElement(ref: ModelElementRef): HostElementRef {
  return { kind: ref.kind, id: ref.id };
}

/** Вкладка «Файлы»: сгенерированный проект выбранной версии. */
export function FilesView({ context }: HostViewProps) {
  const source = projectFilesSource();
  const { focus } = useProjectFilesState();

  if (!source) return null;
  return (
    <ProjectFilesView
      provider={source.provider}
      currentVersion={context.version}
      focus={focus}
      onRuleSelect={(ref) => {
        context.select(ruleToElement(ref));
        if (ref.kind === "transition") context.openView(DIAGRAM_VIEW_ID);
      }}
      onManifestLoaded={(manifest) =>
        rememberManifest({ projectId: manifest.generation_id }, manifest)
      }
    />
  );
}

/** Секция инспектора «Этапы»: где на диаграмме выбранный переход или этап. */
export function StageSection({ context }: HostViewProps) {
  const version = context.version;
  const element = context.selection.element;
  if (!version || !element) return null;
  const ids = projectionFor(context);
  const spec = normalizeSpec(version.spec);
  const result = projectModel(spec, ids);
  if (!result.ok) return <p className="pv-note">{result.reason}</p>;
  const projection = result.projection;
  const labels = new Map(projection.nodes.map((node) => [node.id, node.label]));
  const names = new Map(
    spec.transitions.map((transition) => [transition.id, transition.name]),
  );

  if (element.kind === "transition") {
    const edges = projection.edges.filter(
      (item) => item.transitionId === element.id,
    );
    if (edges.length === 0) {
      return (
        <p className="pv-note pv-root">
          Условие ложно на каждом этапе {ids.join(" × ") || ""}: на диаграмме
          стрелки нет.
        </p>
      );
    }
    const sources = new Set(edges.map((item) => item.source));
    const everywhere = projection.nodes
      .filter((node) => !node.outOfDomain)
      .every((node) => sources.has(node.id));
    return (
      <div className="pv-root pv-stage-section">
        {everywhere && ids.length > 0 && (
          <p className="pv-note">
            Срабатывает на любом этапе: условие не зависит от {ids.join(", ")}.
          </p>
        )}
        <ul>
          {edges.map((item) => (
            <li key={item.id}>
              {labels.get(item.source)} →{" "}
              {item.selfLoop ? "тот же этап" : labels.get(item.target)}
              {item.guardResidual && (
                <>
                  , если <code>{formatExpression(item.guardResidual)}</code>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (
    element.kind === "value" &&
    ids.length === 1 &&
    ids[0] === element.variable
  ) {
    const nodeId = nodeKey({ [element.variable]: element.value }, ids);
    const outgoing = projection.edges.filter((item) => item.source === nodeId);
    const incoming = projection.edges.filter(
      (item) => item.target === nodeId && !item.selfLoop,
    );
    const describe = (transitionId: string) =>
      names.get(transitionId) ?? transitionId;
    return (
      <div className="pv-root pv-stage-section">
        <dl className="pv-rows">
          <div className="pv-row">
            <dt>Выходы</dt>
            <dd>
              {outgoing.length === 0
                ? "нет"
                : outgoing
                    .map(
                      (item) =>
                        `${describe(item.transitionId)} → ${item.selfLoop ? "тот же этап" : labels.get(item.target)}${item.guardResidual ? ` (если ${formatExpression(item.guardResidual)})` : ""}`,
                    )
                    .join("; ")}
            </dd>
          </div>
          <div className="pv-row">
            <dt>Входы</dt>
            <dd>
              {incoming.length === 0
                ? "нет"
                : incoming
                    .map(
                      (item) =>
                        `${describe(item.transitionId)} ← ${labels.get(item.source)}`,
                    )
                    .join("; ")}
            </dd>
          </div>
          {projection.hiddenVariables.length > 0 && (
            <div className="pv-row">
              <dt>Не зафиксированы</dt>
              <dd>
                {projection.hiddenVariables
                  .map((variable) => variable.id)
                  .join(", ")}
              </dd>
            </div>
          )}
        </dl>
      </div>
    );
  }
  return null;
}

/** Секция инспектора «Где реализовано»: строки сгенерированного проекта для элемента модели. */
export function ImplementationSection({ context }: HostViewProps) {
  const element = context.selection.element;
  const source = projectFilesSource();
  const manifest = context.version
    ? manifestForVersion(context.version.id, context.version.spec_hash)
    : null;
  if (!element || !manifest) return null;
  const links = implementationLinks(manifest, element);
  return (
    <ul className="pv-root pv-impl-links">
      {links.map((link) => (
        <li key={`${link.path}:${link.lines?.start ?? 0}`}>
          <button
            type="button"
            className="pv-link-button"
            onClick={() => {
              setProjectFocus({
                path: link.path,
                lines: link.lines,
                generationId: manifest.generation_id,
              });
              context.openView(FILES_VIEW_ID);
            }}
          >
            {link.path}
            {link.lines
              ? `:${link.lines.start}${link.lines.end !== link.lines.start ? `–${link.lines.end}` : ""}`
              : ""}
          </button>
        </li>
      ))}
    </ul>
  );
}

const DiagramTabIcon = ({ size = 16 }: { size?: number }) => (
  <GraphIcon size={size} />
);
const FilesTabIcon = ({ size = 16 }: { size?: number }) => (
  <FolderIcon size={size} />
);

export const workspaceViews: HostWorkspaceView[] = [
  {
    id: DIAGRAM_VIEW_ID,
    label: "Диаграмма",
    icon: DiagramTabIcon,
    order: 40,
    component: DiagramView,
    available: (context) => context.version !== null,
  },
  {
    id: FILES_VIEW_ID,
    label: "Файлы",
    icon: FilesTabIcon,
    order: 50,
    component: FilesView,
    available: (context) =>
      context.version !== null && projectFilesSource() !== null,
  },
];

export const inspectorSections: HostInspectorSection[] = [
  {
    id: "diagram-stages",
    label: "Этапы",
    order: 40,
    matches: (context) => {
      const element = context.selection.element;
      if (!context.version || !element) return false;
      if (element.kind === "transition") return true;
      const ids = projectionFor(context);
      return (
        element.kind === "value" &&
        ids.length === 1 &&
        ids[0] === element.variable
      );
    },
    component: StageSection,
  },
  {
    id: "implementation",
    label: "Где реализовано",
    order: 50,
    matches: (context) => {
      const element = context.selection.element;
      const manifest = context.version
        ? manifestForVersion(context.version.id, context.version.spec_hash)
        : null;
      return Boolean(
        element &&
          manifest &&
          implementationLinks(manifest, element).length > 0,
      );
    },
    component: ImplementationSection,
  },
];
