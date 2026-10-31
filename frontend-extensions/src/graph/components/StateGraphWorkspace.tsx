import { Panel } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BehavioralModel,
  ModelVersion,
  VerificationResult,
} from "../../contracts/model";
import { ApiError, describeApiError } from "../../api/http";
import type { ModelVersionsPort } from "../../api/http";
import { computeSpecHash } from "../../dsl/spec-hash";
import { validateModel } from "../../dsl/validate";
import { cx } from "../../ui/cx";
import {
  AlertIcon,
  BackIcon,
  GraphIcon,
  ListIcon,
  PencilIcon,
  ResetIcon,
  StepIcon,
} from "../../ui/icons";
import {
  applyDraftAction,
  diffModels,
  draftIdempotencyKey,
  DraftError,
  enumValueUsages,
  transitionTemplate,
  versionCreateBody,
} from "../draft";
import type { DraftAction, ModelChange } from "../draft";
import type { GraphSelection, TraceView } from "../flow-elements";
import { layoutProjection } from "../layout";
import {
  DEFAULT_MAX_PROJECTION_NODES,
  defaultProjection,
  projectionCandidates,
  projectModel,
} from "../projection";
import { analyzeTrace, bindReportToVersion, pickTraceResult } from "../trace";
import {
  domainText,
  NodeInspector,
  StepState,
  TransitionInspector,
} from "./Inspector";
import { StateGraphCanvas } from "./StateGraphCanvas";
import { TransitionEditor } from "./TransitionEditor";
import { TransitionTable } from "./TransitionTable";

export type StateGraphWorkspaceProps = {
  /** Версии одной модели (GET /api/models/{id}/versions). */
  versions: ModelVersion[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
  /**
   * Результаты проверки (GET /api/checks/{run_id}).results. Могут относиться к любой
   * версии: трасса показывается только на версии с тем же version_id и spec_hash.
   */
  results?: VerificationResult[];
  /** Свойство, трассу которого показать; по умолчанию первое нарушенное с трассой. */
  propertyId?: string | null;
  onPropertyChange?: (propertyId: string) => void;
  /** Порт создания версий. Без него правка недоступна, причина — в readOnlyReason. */
  versionsPort?: ModelVersionsPort | null;
  readOnlyReason?: string;
  onVersionCreated?: (version: ModelVersion) => void;
  onRequirementSelect?: (requirementId: string) => void;
  /** Выбрать элемент извне: ссылка из чата или из файла проекта на переход или этап. */
  focus?: GraphSelection | null;
  /** Управляемый выбор: если передан (в том числе null), выбор хранит хост. */
  selection?: GraphSelection | null;
  onSelectionChange?: (selection: GraphSelection | null) => void;
  /** Управляемый шаг трассы (индекс, 0 — начальное состояние), общий с таблицей трассы хоста. */
  traceStep?: number;
  onTraceStepChange?: (index: number) => void;
  /** Внутри рабочей области ядра версия выбирается в её заголовке. */
  showVersionPicker?: boolean;
  /** Статус свойства ядро показывает своим StatusBadge. */
  showStatus?: boolean;
  /**
   * full — свой инспектор этапов, переходов и шага трассы; edit-only — только формы
   * правки, а сведения о выбранном элементе показывает инспектор хоста.
   */
  inspector?: "full" | "edit-only";
  /** Сообщает переменные текущей проекции — хост сопоставляет с ними выбранный этап. */
  onProjectionChange?: (variableIds: string[]) => void;
  maxNodes?: number;
  className?: string;
};

type Draft = { base: ModelVersion; spec: BehavioralModel; revision: number };
type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "error"; title: string; details: string[] };

function changeText(change: ModelChange): string {
  switch (change.kind) {
    case "transition_added":
      return `Новый переход ${change.id}`;
    case "transition_removed":
      return `Удалён переход ${change.id}`;
    case "guard_changed":
      return `${change.id}: условие ${change.before} → ${change.after}`;
    case "effects_changed":
      return `${change.id}: эффекты ${change.before} → ${change.after}`;
    case "transition_renamed":
      return `${change.id}: название «${change.before}» → «${change.after}»`;
    case "transition_requirements_changed":
      return `${change.id}: требования ${change.before.join(", ")} → ${change.after.join(", ")}`;
    case "enum_values_changed":
      return [
        change.added.length
          ? `${change.id}: новые значения ${change.added.join(", ")}`
          : "",
        change.removed.length
          ? `${change.id}: удалены ${change.removed.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; ");
    case "other":
      return `Изменён раздел ${change.path}`;
  }
}

function statusLabel(result: VerificationResult, propertyName: string): string {
  switch (result.status) {
    case "PROPERTY_VIOLATED":
      return `Нарушено: ${propertyName}`;
    case "PROPERTY_HOLDS":
      return `Выполняется: ${propertyName}`;
    case "TIMEOUT":
      return `Время вышло: ${propertyName}`;
    case "STATE_LIMIT_REACHED":
      return `Предел состояний: ${propertyName}`;
    case "MODEL_INVALID":
      return `Модель некорректна: ${propertyName}`;
    case "ENGINE_ERROR":
      return `Ошибка движка: ${propertyName}`;
  }
}

/**
 * Рабочая область диаграммы этапов: выбор версии и проекции, граф или таблица,
 * трасса проверки, инспектор и правка с созданием новой версии.
 */
export function StateGraphWorkspace({
  versions,
  selectedVersionId,
  onSelectVersion,
  results = [],
  propertyId = null,
  onPropertyChange,
  versionsPort = null,
  readOnlyReason = "Создание версий не подключено",
  onVersionCreated,
  onRequirementSelect,
  focus = null,
  selection: selectionProp,
  onSelectionChange,
  traceStep: traceStepProp,
  onTraceStepChange,
  showVersionPicker = true,
  showStatus = true,
  inspector = "full",
  onProjectionChange,
  maxNodes = DEFAULT_MAX_PROJECTION_NODES,
  className,
}: StateGraphWorkspaceProps) {
  const version =
    versions.find((item) => item.id === selectedVersionId) ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const [draftError, setDraftError] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<GraphSelection | null>(
    focus,
  );
  const selection =
    selectionProp !== undefined ? selectionProp : localSelection;
  const [editingTransition, setEditingTransition] = useState<string | null>(
    null,
  );
  const [view, setView] = useState<"graph" | "table">("graph");
  const [showConditional, setShowConditional] = useState(true);
  const [positionsByKey, setPositionsByKey] = useState<
    Record<string, Record<string, { x: number; y: number }>>
  >({});
  const [localTraceIndex, setLocalTraceIndex] = useState(0);
  const [newStage, setNewStage] = useState("");
  const [newTransitionId, setNewTransitionId] = useState("");
  const saveController = useRef<AbortController | null>(null);

  useEffect(() => () => saveController.current?.abort(), []);

  const spec = draft?.spec ?? version?.spec ?? null;

  const [projectionIds, setProjectionIds] = useState<string[]>(() =>
    spec ? defaultProjection(spec, maxNodes) : [],
  );
  const variableSignature =
    spec?.variables.map((variable) => variable.id).join("|") ?? "";
  useEffect(() => {
    if (!spec) return;
    setProjectionIds((current) => {
      const valid = current.filter((id) =>
        spec.variables.some((variable) => variable.id === id),
      );
      return valid.length > 0 ? valid : defaultProjection(spec, maxNodes);
    });
    // Пересчитываем только при смене набора переменных, а не при каждой правке.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variableSignature, maxNodes]);

  const setSelection = useCallback(
    (next: GraphSelection | null) => {
      setLocalSelection(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  useEffect(() => {
    saveController.current?.abort();
    setDraft(null);
    setSave({ phase: "idle" });
    setDraftError(null);
    setLocalSelection(focus);
    setEditingTransition(null);
    setLocalTraceIndex(0);
    // focus применяется при смене версии и при его собственном изменении (эффект ниже).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId]);

  useEffect(() => {
    if (focus) setLocalSelection(focus);
  }, [focus]);

  const projectionKey = projectionIds.join("|");
  useEffect(() => {
    onProjectionChange?.(projectionKey ? projectionKey.split("|") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectionKey]);

  const hashMismatch = useMemo(
    () =>
      version ? computeSpecHash(version.spec) !== version.spec_hash : false,
    [version],
  );

  const projectionResult = useMemo(
    () => (spec ? projectModel(spec, projectionIds, maxNodes) : null),
    [spec, projectionIds, maxNodes],
  );
  const projection = projectionResult?.ok ? projectionResult.projection : null;
  const layout = useMemo(
    () => (projection ? layoutProjection(projection) : null),
    [projection],
  );
  const positionsKey = `${version?.model_id ?? ""}|${projectionIds.join("+")}`;
  const positions = positionsByKey[positionsKey] ?? {};

  const numberById = useCallback(
    (id: string) => versions.find((item) => item.id === id)?.number,
    [versions],
  );
  const traceResult = useMemo(
    () => pickTraceResult(results, propertyId),
    [results, propertyId],
  );
  const binding =
    traceResult && version
      ? bindReportToVersion(traceResult, version, numberById)
      : null;
  const analysis = useMemo(() => {
    if (!traceResult || !version || draft || hashMismatch || !binding?.applies)
      return null;
    return analyzeTrace(version.spec, traceResult, projection);
  }, [traceResult, version, draft, hashMismatch, binding?.applies, projection]);

  useEffect(() => {
    setLocalTraceIndex(
      analysis?.focusIndex ?? (analysis ? analysis.steps.length - 1 : 0),
    );
  }, [analysis]);

  const stepCount = analysis?.steps.length ?? 0;
  const traceIndex = Math.max(
    0,
    Math.min(stepCount - 1, traceStepProp ?? localTraceIndex),
  );
  const setTraceIndex = (update: number | ((index: number) => number)) => {
    const next = typeof update === "function" ? update(traceIndex) : update;
    setLocalTraceIndex(next);
    onTraceStepChange?.(next);
  };
  const trace: TraceView | null =
    analysis && analysis.steps.length > 0
      ? { analysis, currentIndex: traceIndex }
      : null;
  const versionResults = useMemo(
    () =>
      version
        ? results.filter(
            (result) => bindReportToVersion(result, version).applies,
          )
        : [],
    [results, version],
  );

  const editable = Boolean(versionsPort) && version !== null && !hashMismatch;
  const changes = useMemo(
    () => (draft ? diffModels(draft.base.spec, draft.spec) : []),
    [draft],
  );
  const issues = useMemo(
    () => (draft ? validateModel(draft.spec) : []),
    [draft],
  );

  const startDraft = () => {
    if (!version) return;
    setDraft({ base: version, spec: version.spec, revision: 0 });
    setSave({ phase: "idle" });
    setDraftError(null);
  };
  const discardDraft = () => {
    saveController.current?.abort();
    setDraft(null);
    setEditingTransition(null);
    setSave({ phase: "idle" });
    setDraftError(null);
  };
  const apply = (actions: DraftAction[]) => {
    if (!draft) return;
    try {
      const next = actions.reduce(applyDraftAction, draft.spec);
      setDraft({ ...draft, spec: next, revision: draft.revision + 1 });
      setDraftError(null);
      return true;
    } catch (error) {
      setDraftError(
        error instanceof DraftError ? error.message : String(error),
      );
      return false;
    }
  };

  const createVersion = async () => {
    if (!draft || !versionsPort || issues.length > 0 || changes.length === 0)
      return;
    const controller = new AbortController();
    saveController.current = controller;
    setSave({ phase: "saving" });
    try {
      const created = await versionsPort.createVersion(
        draft.base.model_id,
        versionCreateBody(draft.base, draft.spec),
        draftIdempotencyKey(draft.base.id, draft.spec),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        created.parent_id !== draft.base.id ||
        created.model_id !== draft.base.model_id ||
        created.spec_hash !== computeSpecHash(draft.spec) ||
        computeSpecHash(created.spec) !== created.spec_hash
      ) {
        throw new ApiError(
          0,
          "UNEXPECTED_PARENT",
          `Сервер создал версию ${created.number} от другой родительской версии`,
        );
      }
      setDraft(null);
      setEditingTransition(null);
      setSave({ phase: "idle" });
      onVersionCreated?.(created);
      onSelectVersion(created.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSave({ phase: "error", ...describeApiError(error) });
    }
  };

  const select = useCallback(
    (next: GraphSelection | null) => {
      setSelection(next);
      if (next?.kind !== "transition") setEditingTransition(null);
    },
    [setSelection],
  );

  if (versions.length === 0 || !version || !spec) {
    return (
      <div className={cx("pv-root", "pv-workspace", "pv-empty", className)}>
        <GraphIcon size={40} />
        <p className="pv-empty__title">
          {versions.length === 0 ? "Модели пока нет" : "Выберите версию модели"}
        </p>
      </div>
    );
  }

  const selectedTransition =
    selection?.kind === "transition"
      ? (spec.transitions.find(
          (transition) => transition.id === selection.transitionId,
        ) ?? null)
      : null;
  const singleEnum =
    projection &&
    projection.variables.length === 1 &&
    projection.variables[0]!.domain.kind === "enum"
      ? projection.variables[0]!
      : null;
  const traceSteps = trace?.analysis.steps.length ?? 0;
  const traceProperty = traceResult
    ? spec.properties.find(
        (property) => property.id === traceResult.property_id,
      )
    : undefined;
  const sortedVersions = [...versions].sort((a, b) => a.number - b.number);

  const traceBar = trace && traceSteps > 0 && (
    <Panel position="bottom-left">
      <div className="pv-tracebar" role="group" aria-label="Шаги трассы">
        <button
          type="button"
          className="pv-button"
          onClick={() => setTraceIndex((index) => Math.max(0, index - 1))}
          disabled={traceIndex === 0}
        >
          <BackIcon /> Назад
        </button>
        <button
          type="button"
          className="pv-button"
          onClick={() =>
            setTraceIndex((index) => Math.min(traceSteps - 1, index + 1))
          }
          disabled={traceIndex >= traceSteps - 1}
        >
          <StepIcon /> Шаг
        </button>
        <button
          type="button"
          className="pv-button"
          onClick={() => setTraceIndex(0)}
          disabled={traceIndex === 0}
        >
          <ResetIcon /> Сбросить
        </button>
        <span className="pv-tracebar__pos" aria-live="polite">
          Шаг {traceIndex} из {traceSteps - 1}
        </span>
      </div>
    </Panel>
  );

  const inspectorContent = (() => {
    if (
      draft &&
      selectedTransition &&
      editingTransition === selectedTransition.id
    ) {
      return (
        <TransitionEditor
          key={`${selectedTransition.id}:${draft.revision}`}
          spec={draft.spec}
          transition={selectedTransition}
          onApply={(actions) => {
            if (apply(actions)) setEditingTransition(null);
          }}
          onRemove={() => {
            if (
              apply([
                {
                  type: "remove_transition",
                  transitionId: selectedTransition.id,
                },
              ])
            ) {
              setSelection(null);
              setEditingTransition(null);
            }
          }}
          onClose={() => setEditingTransition(null)}
        />
      );
    }
    if (selectedTransition && inspector === "edit-only") {
      // Сведения о переходе показывает инспектор хоста; здесь только вход в правку.
      return draft ? (
        <section
          className="pv-inspector__card pv-edit-entry"
          aria-label={`Правка ${selectedTransition.name}`}
        >
          <span>
            Переход «{selectedTransition.name}»{" "}
            <span className="pv-muted pv-mono">{selectedTransition.id}</span>
          </span>
          <button
            type="button"
            className="pv-button"
            onClick={() => setEditingTransition(selectedTransition.id)}
          >
            <PencilIcon /> Изменить guard и effects
          </button>
        </section>
      ) : null;
    }
    if (selectedTransition) {
      return (
        <TransitionInspector
          model={spec}
          projection={projection}
          transition={selectedTransition}
          edgeId={selection?.kind === "transition" ? selection.edgeId : null}
          trace={trace?.analysis ?? null}
          onClose={() => select(null)}
          onEdit={
            draft
              ? () => setEditingTransition(selectedTransition.id)
              : undefined
          }
          onRequirementSelect={onRequirementSelect}
        />
      );
    }
    if (selection?.kind === "node" && projection) {
      const node = projection.nodes.find(
        (item) => item.id === selection.nodeId,
      );
      const value =
        singleEnum && node && !node.outOfDomain
          ? (node.values[singleEnum.id] as string)
          : null;
      const usages =
        draft && singleEnum && value !== null
          ? enumValueUsages(draft.spec, singleEnum.id, value)
          : [];
      if (inspector === "edit-only" && !draft) return null;
      return (
        <NodeInspector
          model={spec}
          projection={projection}
          nodeId={selection.nodeId}
          onSelect={select}
          onClose={() => select(null)}
          onRequirementSelect={onRequirementSelect}
          editSlot={
            draft && node && !node.outOfDomain ? (
              <div className="pv-edit-slot">
                <form
                  className="pv-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const requirement = spec.requirements[0]?.id;
                    if (!requirement) {
                      setDraftError(
                        "В модели нет требований, на которые может сослаться переход",
                      );
                      return;
                    }
                    const template = transitionTemplate(
                      draft.spec,
                      node.values,
                      requirement,
                    );
                    const id = newTransitionId.trim() || template.id;
                    if (
                      apply([
                        {
                          type: "add_transition",
                          transition: {
                            ...template,
                            id,
                            name: id === template.id ? template.name : id,
                          },
                        },
                      ])
                    ) {
                      setNewTransitionId("");
                      setSelection({
                        kind: "transition",
                        transitionId: id,
                        edgeId: null,
                      });
                      setEditingTransition(id);
                    }
                  }}
                >
                  <label>
                    <span>Новый переход отсюда, ID</span>
                    <input
                      className="pv-mono"
                      value={newTransitionId}
                      placeholder={
                        transitionTemplate(draft.spec, node.values, "R").id
                      }
                      onChange={(event) =>
                        setNewTransitionId(event.target.value)
                      }
                    />
                  </label>
                  <button type="submit" className="pv-button">
                    Добавить
                  </button>
                </form>
                {singleEnum && value !== null && (
                  <button
                    type="button"
                    className="pv-button pv-button--danger"
                    disabled={usages.length > 0}
                    title={
                      usages.length > 0
                        ? `Используется: ${usages.join(", ")}`
                        : undefined
                    }
                    onClick={() => {
                      if (
                        apply([
                          {
                            type: "remove_enum_value",
                            variableId: singleEnum.id,
                            value,
                          },
                        ])
                      )
                        setSelection(null);
                    }}
                  >
                    Удалить этап
                  </button>
                )}
                {usages.length > 0 && (
                  <p className="pv-field-help">
                    Этап используется в {usages.length} местах модели, удалить
                    нельзя.
                  </p>
                )}
              </div>
            ) : undefined
          }
        />
      );
    }
    if (draft && singleEnum) {
      return (
        <section className="pv-inspector__card" aria-label="Новый этап">
          <form
            className="pv-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                apply([
                  {
                    type: "add_enum_value",
                    variableId: singleEnum.id,
                    value: newStage.trim(),
                  },
                ])
              )
                setNewStage("");
            }}
          >
            <label>
              <span>Новый этап ({singleEnum.id})</span>
              <input
                value={newStage}
                onChange={(event) => setNewStage(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="pv-button"
              disabled={!newStage.trim()}
            >
              Добавить
            </button>
          </form>
        </section>
      );
    }
    return null;
  })();

  const stepCard =
    inspector === "full" && trace && trace.analysis.steps[traceIndex] ? (
      <StepState
        model={spec}
        analysis={trace.analysis}
        step={trace.analysis.steps[traceIndex]!}
        total={traceSteps - 1}
      />
    ) : null;

  return (
    <div className={cx("pv-root", "pv-workspace", className)}>
      <div className="pv-toolbar" role="toolbar" aria-label="Диаграмма">
        {showVersionPicker && (
          <label className="pv-select">
            <span className="pv-visually-hidden">Версия модели</span>
            <select
              value={version.id}
              onChange={(event) => onSelectVersion(event.target.value)}
              disabled={draft !== null}
              title={
                draft
                  ? "Сначала создайте версию или отмените черновик"
                  : undefined
              }
            >
              {sortedVersions.map((item) => (
                <option key={item.id} value={item.id}>
                  Версия {item.number}
                  {item.approved ? " · согласована" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {showVersionPicker && version.parent_id && (
          <span className="pv-muted pv-toolbar__note">
            от версии {numberById(version.parent_id) ?? "?"}
          </span>
        )}

        <details className="pv-popover">
          <summary className="pv-button">
            Этапы:{" "}
            {projectionIds.length ? projectionIds.join(" × ") : "все состояния"}
          </summary>
          <div
            className="pv-popover__body"
            role="group"
            aria-label="Переменные, задающие этапы"
          >
            {projectionCandidates(spec, maxNodes).map((candidate) => {
              const checked = projectionIds.includes(candidate.variable.id);
              return (
                <label
                  key={candidate.variable.id}
                  className={cx(
                    "pv-check",
                    !candidate.allowed && "is-disabled",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!candidate.allowed && !checked}
                    onChange={() =>
                      setProjectionIds((current) =>
                        checked
                          ? current.filter((id) => id !== candidate.variable.id)
                          : [...current, candidate.variable.id],
                      )
                    }
                  />
                  <code>{candidate.variable.id}</code>
                  <span className="pv-muted">
                    {domainText(candidate.variable)}
                    {!candidate.allowed && ` — больше ${maxNodes} значений`}
                  </span>
                </label>
              );
            })}
            <button
              type="button"
              className="pv-button pv-button--quiet"
              onClick={() =>
                setProjectionIds(defaultProjection(spec, maxNodes))
              }
            >
              По умолчанию
            </button>
          </div>
        </details>

        <div className="pv-segmented" role="group" aria-label="Вид">
          <button
            type="button"
            aria-pressed={view === "graph"}
            onClick={() => setView("graph")}
          >
            <GraphIcon /> Граф
          </button>
          <button
            type="button"
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            <ListIcon /> Таблица
          </button>
        </div>
        {view === "graph" && (
          <label className="pv-check">
            <input
              type="checkbox"
              checked={showConditional}
              onChange={(event) => setShowConditional(event.target.checked)}
            />
            Условные переходы
          </label>
        )}

        <span className="pv-toolbar__spacer" />

        {showStatus &&
          traceResult &&
          traceProperty &&
          binding?.applies &&
          !draft && (
            <span
              className={cx(
                "pv-status",
                traceResult.status === "PROPERTY_VIOLATED"
                  ? "is-violation"
                  : "is-neutral",
              )}
            >
              {traceResult.status === "PROPERTY_VIOLATED" && <AlertIcon />}
              {statusLabel(traceResult, traceProperty.name)}
            </span>
          )}
        {versionResults.filter((result) => result.trace.length > 0).length >
          1 &&
          !draft && (
            <label className="pv-select">
              <span className="pv-visually-hidden">Свойство трассы</span>
              <select
                value={traceResult?.property_id ?? ""}
                onChange={(event) => onPropertyChange?.(event.target.value)}
                disabled={!onPropertyChange}
              >
                {versionResults
                  .filter((result) => result.trace.length > 0)
                  .map((result) => (
                    <option key={result.property_id} value={result.property_id}>
                      {result.property_id}
                    </option>
                  ))}
              </select>
            </label>
          )}
        {!draft && (
          <button
            type="button"
            className="pv-button"
            onClick={startDraft}
            disabled={!editable}
            title={editable ? undefined : readOnlyReason}
          >
            <PencilIcon /> Изменить
          </button>
        )}
      </div>

      {draft && (
        <div className="pv-draftbar" role="region" aria-label="Черновик">
          <span>
            Черновик от версии {draft.base.number}
            {changes.length > 0 ? ` · изменений: ${changes.length}` : ""}
          </span>
          {changes.length > 0 && (
            <details className="pv-popover">
              <summary className="pv-button pv-button--quiet">
                Что изменится
              </summary>
              <ul className="pv-popover__body pv-changes">
                {changes.map((change, index) => (
                  <li key={index}>{changeText(change)}</li>
                ))}
              </ul>
            </details>
          )}
          {issues.length > 0 && (
            <details className="pv-popover">
              <summary className="pv-button pv-button--quiet pv-issue-count">
                Ошибок: {issues.length}
              </summary>
              <ul className="pv-popover__body pv-issues">
                {issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    <code>{issue.path}</code> {issue.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <span className="pv-toolbar__spacer" />
          <button type="button" className="pv-button" onClick={discardDraft}>
            Отменить правки
          </button>
          <button
            type="button"
            className="pv-button pv-button--primary"
            onClick={createVersion}
            disabled={
              save.phase === "saving" ||
              issues.length > 0 ||
              changes.length === 0
            }
          >
            {save.phase === "saving" ? "Создаётся…" : "Создать версию"}
          </button>
        </div>
      )}

      {(draftError || save.phase === "error") && (
        <div className="pv-alert" role="alert">
          <AlertIcon />
          <div>
            <p>{draftError ?? (save.phase === "error" ? save.title : "")}</p>
            {save.phase === "error" && save.details.length > 0 && (
              <ul>
                {save.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {hashMismatch && (
        <div className="pv-alert" role="alert">
          <AlertIcon />
          <p>
            Модель версии не совпадает с её spec_hash: граф может отличаться от
            проверенной спецификации.
          </p>
        </div>
      )}
      {binding && !binding.applies && !draft && (
        <p className="pv-note">
          {binding.message}; трасса на этой версии не показана.
        </p>
      )}
      {analysis && !analysis.consistent && (
        <div className="pv-alert" role="alert">
          <AlertIcon />
          <p>
            Трасса расходится с моделью версии на шаге {analysis.firstMismatch}:{" "}
            {(() => {
              const replay = analysis.steps[analysis.firstMismatch!]!.replay;
              return replay.ok ? "" : replay.message;
            })()}
            . На графе показаны только шаги до расхождения.
          </p>
        </div>
      )}

      <div className="pv-stage-area">
        {view === "table" ? (
          <TransitionTable
            model={spec}
            projection={projection}
            selection={selection}
            trace={trace?.analysis ?? null}
            onSelect={select}
          />
        ) : !projectionResult?.ok ? (
          <div className="pv-empty">
            <p className="pv-empty__title">Проекция не построена</p>
            <p>
              {projectionResult && !projectionResult.ok
                ? projectionResult.reason
                : ""}
            </p>
            <button
              type="button"
              className="pv-button"
              onClick={() => setView("table")}
            >
              Открыть таблицу переходов
            </button>
          </div>
        ) : (
          projection &&
          layout && (
            <StateGraphCanvas
              projection={projection}
              layout={layout}
              transitions={spec.transitions}
              selection={selection}
              onSelect={select}
              trace={trace}
              showConditional={showConditional}
              positions={positions}
              onPositionsChange={(next) =>
                setPositionsByKey((current) => ({
                  ...current,
                  [positionsKey]: next,
                }))
              }
              fitToken={`${version.id}|${projectionIds.join("+")}|${draft ? "draft" : "version"}`}
              ariaLabel={`Диаграмма этапов модели ${spec.name}, версия ${version.number}`}
            >
              {traceBar}
              {projection && (
                <Panel position="top-left">
                  <div className="pv-legend" aria-label="Обозначения">
                    <span className="pv-legend__item">
                      <svg width="26" height="8" aria-hidden="true">
                        <path d="M1 4h24" className="pv-legend__solid" />
                      </svg>
                      условие задаёт этап
                    </span>
                    {projection.hiddenVariables.length > 0 && (
                      <span className="pv-legend__item">
                        <svg width="26" height="8" aria-hidden="true">
                          <path d="M1 4h24" className="pv-legend__dashed" />
                        </svg>
                        зависит от{" "}
                        {projection.hiddenVariables
                          .map((variable) => variable.id)
                          .join(", ")}
                      </span>
                    )}
                    {Object.keys(positions).length > 0 && (
                      <button
                        type="button"
                        className="pv-link-button"
                        onClick={() =>
                          setPositionsByKey((current) => {
                            const next = { ...current };
                            delete next[positionsKey];
                            return next;
                          })
                        }
                      >
                        Вернуть раскладку
                      </button>
                    )}
                  </div>
                </Panel>
              )}
            </StateGraphCanvas>
          )
        )}
      </div>

      {projection && projection.neverEnabled.length > 0 && (
        <p className="pv-note">
          Не срабатывают ни на одном этапе:{" "}
          {projection.neverEnabled
            .map(
              (id) =>
                spec.transitions.find((item) => item.id === id)?.name ?? id,
            )
            .join(", ")}
        </p>
      )}

      {(inspectorContent || stepCard) && (
        <div
          className={cx(
            "pv-inspector",
            inspectorContent && stepCard && "has-two",
          )}
        >
          {inspectorContent}
          {stepCard}
        </div>
      )}
    </div>
  );
}
