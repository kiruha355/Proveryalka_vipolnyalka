import type { StateProjection } from "./projection";

/**
 * Детерминированная послойная раскладка: слой — расстояние от начального узла
 * по рёбрам проекции (без петель), порядок в слое — по среднему положению
 * предшественников, при равенстве — по порядку значений в области.
 * Узлы без пути из начального идут последним столбцом.
 * Положение узлов не входит в модель и не влияет на DSL.
 */

export type NodeBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  connected: boolean;
};
export type GraphLayout = {
  boxes: Record<string, NodeBox>;
  width: number;
  height: number;
};

export const NODE_HEIGHT = 48;
const LAYER_GAP = 176;
const ROW_GAP = 72;
const MIN_WIDTH = 132;
const MAX_WIDTH = 280;

export function nodeWidth(label: string): number {
  // Оценка ширины без DOM: средний символ ≈ 7.4px при 14px, плюс точка-индикатор и поля.
  return Math.round(
    Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, label.length * 7.4 + 64)),
  );
}

export function layoutProjection(projection: StateProjection): GraphLayout {
  const order = new Map(
    projection.nodes.map((node, index) => [node.id, index]),
  );
  const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!;
  const firm = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };
  for (const edge of projection.edges) {
    if (edge.selfLoop) continue;
    add(predecessors, edge.target, edge.source);
    if (edge.kind === "unconditional") add(firm, edge.source, edge.target);
  }
  for (const map of [firm, predecessors])
    for (const list of map.values()) list.sort(byOrder);

  // Слои сначала по безусловным рёбрам (основной ход этапов), затем узлы,
  // достижимые только условными рёбрами, ставятся после всех своих
  // уже размещённых предшественников.
  const layerOf = new Map<string, number>();
  const parents = new Map<string, string[]>();
  const start =
    projection.nodes.find((node) => node.initial) ?? projection.nodes[0];
  if (start) {
    layerOf.set(start.id, 0);
    const queue = [start.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of firm.get(current) ?? []) {
        if (!layerOf.has(next)) {
          layerOf.set(next, layerOf.get(current)! + 1);
          queue.push(next);
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      const frontier = projection.nodes
        .map((node) => node.id)
        .filter(
          (id) =>
            !layerOf.has(id) &&
            (predecessors.get(id) ?? []).some((parent) => layerOf.has(parent)),
        );
      for (const id of frontier) {
        const placed = (predecessors.get(id) ?? []).filter((parent) =>
          layerOf.has(parent),
        );
        layerOf.set(
          id,
          Math.max(...placed.map((parent) => layerOf.get(parent)!)) + 1,
        );
        changed = true;
      }
    }
  }
  for (const [id, layer] of layerOf) {
    parents.set(
      id,
      (predecessors.get(id) ?? []).filter(
        (parent) => layerOf.get(parent) === layer - 1,
      ),
    );
  }
  const connectedLayers =
    layerOf.size > 0 ? Math.max(...layerOf.values()) + 1 : 0;
  const layers: string[][] = Array.from({ length: connectedLayers }, () => []);
  const disconnected: string[] = [];
  for (const node of projection.nodes) {
    const layer = layerOf.get(node.id);
    if (layer === undefined) disconnected.push(node.id);
    else layers[layer]!.push(node.id);
  }
  if (disconnected.length > 0) layers.push(disconnected);

  const position = new Map<string, number>();
  layers.forEach((layer, index) => {
    if (index > 0 && index < connectedLayers) {
      const weight = (id: string) => {
        const list = parents.get(id) ?? [];
        if (list.length === 0) return Number.MAX_SAFE_INTEGER;
        return (
          list.reduce((sum, parent) => sum + (position.get(parent) ?? 0), 0) /
          list.length
        );
      };
      layer.sort(
        (a, b) => weight(a) - weight(b) || order.get(a)! - order.get(b)!,
      );
    }
    layer.forEach((id, row) => position.set(id, row));
  });

  const labels = new Map(projection.nodes.map((node) => [node.id, node.label]));
  const boxes: Record<string, NodeBox> = {};
  const tallest = Math.max(1, ...layers.map((layer) => layer.length));
  const totalHeight = tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  let x = 0;
  layers.forEach((layer, index) => {
    const widths = layer.map((id) => nodeWidth(labels.get(id) ?? ""));
    const columnWidth = Math.max(MIN_WIDTH, ...widths);
    const layerHeight =
      layer.length * NODE_HEIGHT + (layer.length - 1) * ROW_GAP;
    let y = (totalHeight - layerHeight) / 2;
    layer.forEach((id, row) => {
      const width = widths[row]!;
      boxes[id] = {
        x: x + (columnWidth - width) / 2,
        y,
        width,
        height: NODE_HEIGHT,
        layer: index,
        connected: index < connectedLayers,
      };
      y += NODE_HEIGHT + ROW_GAP;
    });
    x += columnWidth + LAYER_GAP;
  });
  return { boxes, width: Math.max(0, x - LAYER_GAP), height: totalHeight };
}
