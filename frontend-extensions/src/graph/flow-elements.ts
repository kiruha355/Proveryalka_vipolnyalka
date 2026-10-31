import type { Edge, Node, NodeHandle } from "@xyflow/react";
import { Position } from "@xyflow/react";
import type { Transition } from "../contracts/model";
import { formatExpression } from "../dsl/expression-text";
import type { GraphLayout } from "./layout";
import type { EdgeKind, ProjectionEdge, StateProjection } from "./projection";
import type { TraceAnalysis } from "./trace";

/** Выбор на графе: этап (узел проекции) или переход; edgeId — конкретная стрелка перехода. */
export type GraphSelection =
  | { kind: "node"; nodeId: string }
  | { kind: "transition"; transitionId: string; edgeId: string | null };

export type TraceView = { analysis: TraceAnalysis; currentIndex: number };

export type StageNodeData = {
  label: string;
  initial: boolean;
  outOfDomain: boolean;
  selected: boolean;
  /** Номера шагов трассы, на которых состояние находится в этом этапе. */
  traceSteps: number[];
  current: boolean;
  violation: boolean;
  dimmed: boolean;
  hasSelfLoop: boolean;
  [key: string]: unknown;
};

export type EdgeChip = {
  edgeId: string;
  transitionId: string;
  name: string;
  kind: EdgeKind;
  condition: string | null;
  computed: string | null;
  traceSteps: number[];
  current: boolean;
  violation: boolean;
  selected: boolean;
  description: string;
};

export type Route = "forward" | "skip" | "back" | "down" | "up" | "loop";

export type TransitionEdgeData = {
  chips: EdgeChip[];
  route: Route;
  /**
   * Для дуг (back — сверху, skip — снизу): координата y, через которую дуга
   * проходит в стороне от узлов промежуточных слоёв; null для остальных маршрутов.
   */
  arcY: number | null;
  dimmed: boolean;
  inTrace: boolean;
  current: boolean;
  violation: boolean;
  selected: boolean;
  dashed: boolean;
  [key: string]: unknown;
};

export type StageFlowNode = Node<StageNodeData, "stage">;
export type TransitionFlowEdge = Edge<TransitionEdgeData, "transitions">;

const HANDLE = 8;

function handlesFor(width: number, height: number): NodeHandle[] {
  return [
    {
      id: "l",
      type: "target",
      position: Position.Left,
      x: -HANDLE / 2,
      y: height / 2 - HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    },
    {
      id: "r",
      type: "source",
      position: Position.Right,
      x: width - HANDLE / 2,
      y: height / 2 - HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    },
    {
      id: "ts",
      type: "source",
      position: Position.Top,
      x: width * 0.62 - HANDLE / 2,
      y: -HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    },
    {
      id: "tt",
      type: "target",
      position: Position.Top,
      x: width * 0.38 - HANDLE / 2,
      y: -HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    },
    {
      id: "bs",
      type: "source",
      position: Position.Bottom,
      x: width * 0.62 - HANDLE / 2,
      y: height - HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    },
    {
      id: "bt",
      type: "target",
      position: Position.Bottom,
      x: width * 0.38 - HANDLE / 2,
      y: height - HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    },
  ];
}

export function routeFor(
  source: { x: number; y: number; width: number; layer: number },
  target: { x: number; y: number; width: number; layer: number },
  self: boolean,
): Route {
  if (self) return "loop";
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  // Переход через слой рисуется дугой снизу, чтобы не пересекать узлы и подписи между ними.
  if (dx > 40 && target.layer - source.layer >= 2) return "skip";
  if (dx > 40) return "forward";
  if (dx < -40) return "back";
  return target.y > source.y ? "down" : "up";
}

const HANDLES_BY_ROUTE: Record<Route, [string, string]> = {
  forward: ["r", "l"],
  skip: ["bs", "bt"],
  back: ["ts", "tt"],
  down: ["bs", "tt"],
  up: ["ts", "bt"],
  loop: ["ts", "tt"],
};

function describeChip(
  edge: ProjectionEdge,
  name: string,
  labels: Map<string, string>,
  condition: string | null,
  computed: string | null,
): string {
  const parts = [
    `Переход «${name}» (${edge.transitionId}): ${labels.get(edge.source)} → ${labels.get(edge.target)}`,
  ];
  if (condition) parts.push(`при условии ${condition}`);
  if (computed) parts.push(`значение вычисляется: ${computed}`);
  if (edge.kind === "invalid") parts.push("присваивание вне области");
  return parts.join(", ");
}

export type BuildOptions = {
  positions?: Record<string, { x: number; y: number }>;
  selection?: GraphSelection | null;
  trace?: TraceView | null;
  showConditional?: boolean;
};

export function buildFlowElements(
  projection: StateProjection,
  layout: GraphLayout,
  transitions: Transition[],
  options: BuildOptions = {},
): { nodes: StageFlowNode[]; edges: TransitionFlowEdge[] } {
  const {
    positions = {},
    selection = null,
    trace = null,
    showConditional = true,
  } = options;
  const names = new Map(
    transitions.map((transition) => [transition.id, transition.name]),
  );
  const labels = new Map(projection.nodes.map((node) => [node.id, node.label]));

  const steps =
    trace && trace.analysis.consistent
      ? trace.analysis.steps
      : trace
        ? trace.analysis.steps.slice(0, trace.analysis.firstMismatch ?? 0)
        : [];
  const shown = trace ? steps.slice(0, trace.currentIndex + 1) : [];
  const currentStep = trace ? (shown[trace.currentIndex] ?? null) : null;
  const focus = trace?.analysis.focusIndex ?? null;
  const violationActive =
    trace !== null &&
    focus !== null &&
    trace.currentIndex >= focus &&
    trace.analysis.role !== "witness";

  const nodeSteps = new Map<string, number[]>();
  const edgeSteps = new Map<string, number[]>();
  shown.forEach((step) => {
    if (step.nodeId)
      nodeSteps.set(step.nodeId, [
        ...(nodeSteps.get(step.nodeId) ?? []),
        step.index,
      ]);
    if (step.edgeId)
      edgeSteps.set(step.edgeId, [
        ...(edgeSteps.get(step.edgeId) ?? []),
        step.index,
      ]);
  });
  const focusStep = focus !== null ? steps[focus] : undefined;

  const boxOf = (id: string) => {
    const box = layout.boxes[id]!;
    const moved = positions[id];
    return { ...box, x: moved?.x ?? box.x, y: moved?.y ?? box.y };
  };

  const loops = new Set(
    projection.edges.filter((edge) => edge.selfLoop).map((edge) => edge.source),
  );
  const nodes: StageFlowNode[] = projection.nodes.map((node) => {
    const box = boxOf(node.id);
    const visited = nodeSteps.get(node.id) ?? [];
    return {
      id: node.id,
      type: "stage",
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      handles: handlesFor(box.width, box.height),
      selected: selection?.kind === "node" && selection.nodeId === node.id,
      ariaLabel: `Этап ${node.label}${node.initial ? ", начальный" : ""}${visited.length ? `, шаги трассы ${visited.join(", ")}` : ""}`,
      data: {
        label: node.label,
        initial: node.initial,
        outOfDomain: node.outOfDomain,
        selected: selection?.kind === "node" && selection.nodeId === node.id,
        traceSteps: visited,
        current: currentStep?.nodeId === node.id,
        violation: violationActive && focusStep?.nodeId === node.id,
        dimmed: trace !== null && visited.length === 0,
        hasSelfLoop: loops.has(node.id),
      },
    };
  });

  const groups = new Map<string, ProjectionEdge[]>();
  for (const edge of projection.edges) {
    if (
      !showConditional &&
      edge.kind !== "unconditional" &&
      !edgeSteps.has(edge.id)
    )
      continue;
    const key = `${edge.source}=>${edge.target}`;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }

  const ARC_CLEARANCE = 30;
  const ARC_STEP = 30;
  let backRank = 0;
  let skipRank = 0;
  const boxes = projection.nodes.map((node) => boxOf(node.id));
  const between = (a: number, b: number, x1: number, x2: number) =>
    boxes.filter(
      (box) =>
        box.x + box.width > Math.min(x1, x2) &&
        box.x < Math.max(x1, x2) &&
        box.layer >= Math.min(a, b) &&
        box.layer <= Math.max(a, b),
    );
  const edges: TransitionFlowEdge[] = [];
  for (const [key, group] of groups) {
    const first = group[0]!;
    const source = boxOf(first.source);
    const target = boxOf(first.target);
    const route = routeFor(source, target, first.selfLoop);
    let arcY: number | null = null;
    if (route === "back") {
      const span = between(
        source.layer,
        target.layer,
        source.x,
        target.x + target.width,
      );
      arcY =
        Math.min(...span.map((box) => box.y)) -
        ARC_CLEARANCE -
        backRank++ * ARC_STEP;
    } else if (route === "skip") {
      const span = between(
        source.layer,
        target.layer,
        source.x,
        target.x + target.width,
      );
      arcY =
        Math.max(...span.map((box) => box.y + box.height)) +
        ARC_CLEARANCE +
        skipRank++ * ARC_STEP;
    }
    const [sourceHandle, targetHandle] = HANDLES_BY_ROUTE[route];
    const chips: EdgeChip[] = group.map((edge) => {
      const name = names.get(edge.transitionId) ?? edge.transitionId;
      const condition = edge.guardResidual
        ? formatExpression(edge.guardResidual)
        : null;
      const computedEntries = Object.entries(edge.effectResiduals);
      const computed = computedEntries.length
        ? computedEntries
            .map(
              ([variable, value]) =>
                `${variable} := ${formatExpression(value)}`,
            )
            .join("; ")
        : null;
      const traceSteps = edgeSteps.get(edge.id) ?? [];
      return {
        edgeId: edge.id,
        transitionId: edge.transitionId,
        name,
        kind: edge.kind,
        condition,
        computed,
        traceSteps,
        current: currentStep?.edgeId === edge.id,
        violation: violationActive && focusStep?.edgeId === edge.id,
        selected:
          selection?.kind === "transition" &&
          selection.transitionId === edge.transitionId &&
          (selection.edgeId === null || selection.edgeId === edge.id),
        description: describeChip(edge, name, labels, condition, computed),
      };
    });
    const inTrace = chips.some((chip) => chip.traceSteps.length > 0);
    edges.push({
      id: key,
      type: "transitions",
      source: first.source,
      target: first.target,
      sourceHandle,
      targetHandle,
      selectable: false,
      focusable: false,
      zIndex: inTrace ? 2 : 1,
      data: {
        chips,
        route,
        arcY,
        dimmed: trace !== null && !inTrace,
        inTrace,
        current: chips.some((chip) => chip.current),
        violation: chips.some((chip) => chip.violation),
        selected: chips.some((chip) => chip.selected),
        dashed: chips.every((chip) => chip.kind !== "unconditional"),
      },
    });
  }
  return { nodes, edges };
}
