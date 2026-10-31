import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import type { EdgeProps, NodeChange, NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
} from "react";
import {useExpandedGraph} from "./useExpandedGraph";
import type { Transition } from "../../contracts/model";
import { cx } from "../../ui/cx";
import { FitIcon, MinusIcon, PlusIcon } from "../../ui/icons";
import { buildFlowElements } from "../flow-elements";
import type {
  EdgeChip,
  GraphSelection,
  StageFlowNode,
  TraceView,
  TransitionFlowEdge,
} from "../flow-elements";
import type { GraphLayout } from "../layout";
import type { StateProjection } from "../projection";

type CanvasActions = {
  selectChip: (chip: EdgeChip) => void;
  markerPrefix: string;
};

const CanvasContext = createContext<CanvasActions | null>(null);

const HANDLE_IDS: Array<[string, "source" | "target", Position]> = [
  ["l", "target", Position.Left],
  ["r", "source", Position.Right],
  ["ts", "source", Position.Top],
  ["tt", "target", Position.Top],
  ["bs", "source", Position.Bottom],
  ["bt", "target", Position.Bottom],
];

const HANDLE_OFFSET: Record<string, string | undefined> = {
  ts: "62%",
  tt: "38%",
  bs: "62%",
  bt: "38%",
};

export const StageNode = memo(function StageNode({
  data,
}: NodeProps<StageFlowNode>) {
  return (
    <div
      className={cx(
        "pv-stage",
        data.initial && "is-initial",
        data.selected && "is-selected",
        data.current && "is-current",
        data.violation && "is-violation",
        data.dimmed && "is-dimmed",
        data.outOfDomain && "is-invalid",
      )}
    >
      {HANDLE_IDS.map(([id, type, position]) => (
        <Handle
          key={id}
          id={id}
          type={type}
          position={position}
          isConnectable={false}
          className="pv-handle"
          style={HANDLE_OFFSET[id] ? { left: HANDLE_OFFSET[id] } : undefined}
        />
      ))}
      <span className="pv-stage__dot" aria-hidden="true" />
      <span className="pv-stage__label">{data.label}</span>
      {data.traceSteps.length > 0 && (
        <span className="pv-stage__steps" aria-hidden="true">
          {data.traceSteps.join(", ")}
        </span>
      )}
    </div>
  );
});

function edgePath(props: EdgeProps<TransitionFlowEdge>): {
  path: string;
  labelX: number;
  labelY: number;
} {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
  } = props;
  const route = data?.route ?? "forward";
  if (route === "loop") {
    const lift = 58;
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX + 30} ${sourceY - lift}, ${targetX - 30} ${targetY - lift}, ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: Math.min(sourceY, targetY) - lift * 0.78,
    };
  }
  if ((route === "back" || route === "skip") && data?.arcY != null) {
    // У кубической кривой с контрольными точками на высоте c крайняя точка
    // проходит на 3/4 пути к c, поэтому c выносится дальше arcY.
    const toControl = (from: number) => from + (data.arcY! - from) / 0.75;
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX} ${toControl(sourceY)}, ${targetX} ${toControl(targetY)}, ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: data.arcY,
    };
  }
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return { path, labelX, labelY };
}

export const TransitionEdge = memo(function TransitionEdge(
  props: EdgeProps<TransitionFlowEdge>,
) {
  const actions = useContext(CanvasContext);
  const data = props.data;
  const { path, labelX, labelY } = edgePath(props);
  if (!data || !actions) return null;
  const tone = data.violation
    ? "violation"
    : data.inTrace
      ? "trace"
      : data.selected
        ? "selected"
        : "plain";
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={`url(#${actions.markerPrefix}-${tone})`}
        className={cx(
          "pv-edge",
          data.dashed && "is-dashed",
          data.inTrace && "is-trace",
          data.current && "is-current",
          data.violation && "is-violation",
          data.selected && "is-selected",
          data.dimmed && "is-dimmed",
        )}
        interactionWidth={0}
      />
      <EdgeLabelRenderer>
        <div
          className={cx(
            "pv-edge-label",
            "nodrag",
            "nopan",
            data.dimmed && "is-dimmed",
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {data.chips.map((chip) => (
            <button
              key={chip.edgeId}
              type="button"
              className={cx(
                "pv-chip",
                `is-${chip.kind}`,
                chip.selected && "is-selected",
                chip.traceSteps.length > 0 && "is-trace",
                chip.current && "is-current",
                chip.violation && "is-violation",
              )}
              aria-label={chip.description}
              aria-pressed={chip.selected}
              title={chip.description}
              onClick={(event) => {
                event.stopPropagation();
                actions.selectChip(chip);
              }}
            >
              {chip.violation && (
                <span className="pv-chip__blocked" aria-hidden="true" />
              )}
              <span>{chip.name}</span>
              {chip.traceSteps.length > 0 && (
                <span className="pv-chip__step">
                  {chip.traceSteps.join(", ")}
                </span>
              )}
            </button>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

const nodeTypes = { stage: StageNode };
const edgeTypes = { transitions: TransitionEdge };

const ARIA_LABELS = {
  "node.a11yDescription.default":
    "Enter или пробел — выбрать этап, стрелки — переместить.",
  "node.a11yDescription.keyboardDisabled": "Enter или пробел — выбрать этап.",
  "node.a11yDescription.ariaLiveMessage": ({
    direction,
    x,
    y,
  }: {
    direction: string;
    x: number;
    y: number;
  }) => `Этап перемещён ${direction}: ${x}, ${y}`,
  "edge.a11yDescription.default": "Переход",
  "controls.ariaLabel": "Масштаб",
  "controls.zoomIn.ariaLabel": "Приблизить",
  "controls.zoomOut.ariaLabel": "Отдалить",
  "controls.fitView.ariaLabel": "Вписать граф",
  "controls.interactive.ariaLabel": "Блокировка",
  "minimap.ariaLabel": "Миникарта",
  "handle.ariaLabel": "Точка соединения",
};

function ZoomControls() {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="pv-zoom" role="group" aria-label="Масштаб">
      <button
        type="button"
        className="pv-icon-button"
        onClick={() => flow.zoomOut({ duration: 120 })}
        aria-label="Отдалить"
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        className="pv-zoom__value"
        onClick={() => flow.zoomTo(1, { duration: 120 })}
        aria-label={`Масштаб ${Math.round(zoom * 100)}%, сбросить до 100%`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className="pv-icon-button"
        onClick={() => flow.zoomIn({ duration: 120 })}
        aria-label="Приблизить"
      >
        <PlusIcon />
      </button>
      <button
        type="button"
        className="pv-icon-button"
        onClick={() => flow.fitView({ duration: 160, padding: 0.2 })}
        aria-label="Вписать граф"
      >
        <FitIcon />
      </button>
    </div>
  );
}

function FitOnChange({ token }: { token: string }) {
  const flow = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void flow.fitView({ padding: 0.2, maxZoom: 1.1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, token]);
  return null;
}

export type StateGraphCanvasProps = {
  projection: StateProjection;
  layout: GraphLayout;
  transitions: Transition[];
  selection: GraphSelection | null;
  onSelect: (selection: GraphSelection | null) => void;
  trace?: TraceView | null;
  showConditional?: boolean;
  positions?: Record<string, { x: number; y: number }>;
  onPositionsChange?: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  /** Меняется при смене версии или проекции — граф заново вписывается в окно. */
  fitToken?: string;
  ariaLabel?: string;
  /** Controls in the reserved footer, outside the React Flow pane. */
  footer?: ReactNode;
  /** Дополнительные элементы поверх холста (легенда). */
  children?: ReactNode;
};

function CanvasInner(props: StateGraphCanvasProps) {
  const {
    projection,
    layout,
    transitions,
    selection,
    onSelect,
    trace = null,
    showConditional = true,
    positions = {},
    onPositionsChange,
    fitToken = "",
    ariaLabel = "Диаграмма этапов",
    children, footer,
  } = props;
  const markerPrefix = `pv-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { nodes, edges } = useMemo(
    () =>
      buildFlowElements(projection, layout, transitions, {
        positions,
        selection,
        trace,
        showConditional,
      }),
    [
      projection,
      layout,
      transitions,
      positions,
      selection,
      trace,
      showConditional,
    ],
  );

  const selectChip = useCallback(
    (chip: EdgeChip) =>
      onSelect({
        kind: "transition",
        transitionId: chip.transitionId,
        edgeId: chip.edgeId,
      }),
    [onSelect],
  );
  const actions = useMemo(
    () => ({ selectChip, markerPrefix }),
    [selectChip, markerPrefix],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StageFlowNode>[]) => {
      let moved: Record<string, { x: number; y: number }> | null = null;
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moved ??= { ...positions };
          moved[change.id] = { x: change.position.x, y: change.position.y };
        }
        if (change.type === "select" && change.selected)
          onSelect({ kind: "node", nodeId: change.id });
      }
      if (moved && onPositionsChange) onPositionsChange(moved);
    },
    [positions, onPositionsChange, onSelect],
  );

  return (
    <CanvasContext.Provider value={actions}>
      <div className="pv-canvas">
      <ReactFlow<StageFlowNode, TransitionFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelect({ kind: "node", nodeId: node.id })}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={Boolean(onPositionsChange)}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.15}
        maxZoom={2.5}
        ariaLabelConfig={ARIA_LABELS}
        aria-label={ariaLabel}
        proOptions={{ hideAttribution: false }}
        attributionPosition="top-right"
      >
        <svg className="pv-markers" aria-hidden="true">
          <defs>
            {(["plain", "selected", "trace", "violation"] as const).map(
              (tone) => (
                <marker
                  key={tone}
                  id={`${markerPrefix}-${tone}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 0 L 10 5 L 0 10 z"
                    className={`pv-marker pv-marker--${tone}`}
                  />
                </marker>
              ),
            )}
          </defs>
        </svg>
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1.2}
          className="pv-canvas-bg"
        />
        <FitOnChange token={fitToken} />
        {children}
      </ReactFlow>
      <div className="pv-canvas-controls" role="toolbar" aria-label="Управление диаграммой">
        {footer}
        <ZoomControls />
      </div>
      </div>
    </CanvasContext.Provider>
  );
}

/** Холст React Flow для проекции модели. Положение узлов — только раскладка, не часть модели. */
export function StateGraphCanvas(props: StateGraphCanvasProps) {
  const full = useExpandedGraph();
  const titleId = useId();
  return (
    <div ref={full.shell} className={cx("pv-canvas-shell", full.expanded && "is-expanded")}
      role={full.expanded ? "dialog" : "region"} aria-modal={full.expanded ? true : undefined}
      aria-label={full.expanded ? undefined : "Область диаграммы"}
      aria-labelledby={full.expanded ? titleId : undefined} onKeyDownCapture={full.onKeyDownCapture}>
      <div className="pv-canvas-heading">
        {full.expanded && <h2 id={titleId}>{props.ariaLabel ?? "Диаграмма этапов"}</h2>}
        {full.expanded ? <button ref={full.close} type="button" className="pv-button" onClick={() => full.setExpanded(false)}>Закрыть диаграмму</button>
          : <button ref={full.trigger} type="button" className="pv-button" onClick={() => full.setExpanded(true)}>Развернуть диаграмму</button>}
      </div>
      <ReactFlowProvider>
        <CanvasInner {...props} fitToken={`${props.fitToken ?? ""}|${full.expanded}`} />
      </ReactFlowProvider>
    </div>
  );
}
