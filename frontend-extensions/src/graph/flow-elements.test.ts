import { describe, expect, it } from "vitest";
import type { BehavioralModel, Expression, VerificationResult } from "../contracts/model";
import { computeSpecHash } from "../dsl/spec-hash";
import { TLC_ORDER_BUG_RESULT } from "../fixtures/order-versions";
import { buildFlowElements } from "./flow-elements";
import { layoutProjection } from "./layout";
import { nodeKey, projectModel } from "./projection";
import { analyzeTrace } from "./trace";

const variable = (name: string): Expression => ({ kind: "variable", name });
const not = (name: string): Expression => ({ kind: "unary", op: "not", operand: variable(name) });
const and = (left: Expression, right: Expression): Expression => ({ kind: "binary", op: "and", left, right });

/** Те же boolean guards/effects и длинные имена, что на аннотированной диаграмме заявки. */
function booleanRequest(corrected = false): BehavioralModel {
  return {
    schema_version: "1.0",
    name: "Согласование, исполнение и отмена заявки",
    sources: [], requirements: [],
    variables: ["approved", "executed", "cancelled"].map(id => ({
      id, name: id, requirement_ids: [], domain: { kind: "boolean" }, initial_value: false,
    })),
    transitions: [
      { id: "execute", name: "Исполнить заявку", requirement_ids: [],
        guard: corrected ? and(variable("approved"), not("cancelled")) : variable("approved"),
        effects: [{ variable: "executed", value: { kind: "literal", value: true } }] },
      { id: "cancel", name: "Пользователь отменяет заявку", requirement_ids: [], guard: not("executed"),
        effects: [{ variable: "cancelled", value: { kind: "literal", value: true } },
          { variable: "approved", value: variable("approved") }] },
      { id: "approve", name: "Согласовать заявку", requirement_ids: [],
        guard: and(and(not("approved"), not("cancelled")), not("executed")),
        effects: [{ variable: "approved", value: { kind: "literal", value: true } }] },
    ],
    properties: [{ id: "NoCancelledExecution", name: "Отменённая заявка не исполняется", requirement_ids: [],
      kind: "forbidden_state", predicate: and(variable("cancelled"), variable("executed")),
      explanation: "", origin: "requirement", approved_by: null }],
  };
}

function projectionFor(model: BehavioralModel) {
  const result = projectModel(model, ["approved"]);
  if (!result.ok) throw new Error(result.reason);
  return result.projection;
}

const approved = (value: boolean) => nodeKey({ approved: value }, ["approved"]);

describe("подписи boolean-проекции заявки", () => {
  it.each([false, true])("разделяет две петли approved=true до и после исправления guard: %s", corrected => {
    const model = booleanRequest(corrected);
    const projection = projectionFor(model);
    const layout = layoutProjection(projection);
    const { nodes, edges } = buildFlowElements(projection, layout, model.transitions);
    const loops = edges.filter(edge => edge.source === approved(true) && edge.target === approved(true));
    expect(loops).toHaveLength(2);
    expect(loops.map(edge => edge.data!.chips.map(chip => chip.transitionId))).toEqual([["execute"], ["cancel"]]);
    const top = loops.find(edge => edge.data!.loopSide === "top")!;
    const bottom = loops.find(edge => edge.data!.loopSide === "bottom")!;
    const box = layout.boxes[approved(true)]!;
    expect(top.sourceHandle).toBe("ts"); expect(top.targetHandle).toBe("tt");
    expect(top.data!.arcY).toBeLessThan(box.y);
    expect(bottom.sourceHandle).toBe("bs"); expect(bottom.targetHandle).toBe("bt");
    expect(bottom.data!.arcY).toBeGreaterThan(box.y + box.height);
    // Весь текст и исходные идентификаторы проекции сохранены: каждый chip кликается отдельно.
    expect(edges.flatMap(edge => edge.data!.chips.map(chip => chip.edgeId)).sort()).toEqual(projection.edges.map(edge => edge.id).sort());
    expect(nodes.map(node => node.position)).toEqual(projection.nodes.map(node => ({ x: layout.boxes[node.id]!.x, y: layout.boxes[node.id]!.y })));
    const forward = edges.find(edge => edge.data!.route === "forward")!;
    const source = layout.boxes[forward.source]!, target = layout.boxes[forward.target]!;
    expect(forward.data!.labelMaxWidth).toBeLessThan(target.x - source.x - source.width);
    expect(forward.data!.chips[0]!.name).toBe("Согласовать заявку");
  });

  it("сохраняет стороны петель при фильтрации условных рёбер и перестановке входа", () => {
    const model = booleanRequest();
    const projection = projectionFor(model);
    const layout = layoutProjection(projection);
    const full = buildFlowElements(projection, layout, model.transitions).edges;
    const filtered = buildFlowElements(projection, layout, model.transitions, { showConditional: false }).edges;
    const execute = full.find(edge => edge.data!.chips[0]!.transitionId === "execute")!;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: execute.id, sourceHandle: execute.sourceHandle, targetHandle: execute.targetHandle,
      data: { loopSide: execute.data!.loopSide, arcY: execute.data!.arcY } });
    const geometry = (edges: typeof full) => edges.map(edge => ({ id: edge.id, side: edge.data!.loopSide, y: edge.data!.arcY })).sort((a, b) => a.id.localeCompare(b.id));
    expect(geometry(buildFlowElements({ ...projection, edges: [...projection.edges].reverse() }, layout, model.transitions).edges)).toEqual(geometry(full));
  });

  it("выбор и шаги Cancel/Execute относятся к разным петлям того же этапа", () => {
    const model = booleanRequest();
    const projection = projectionFor(model);
    const result: VerificationResult = {
      ...TLC_ORDER_BUG_RESULT, version_id: null, spec_hash: computeSpecHash(model), property_id: "NoCancelledExecution",
      trace: [
        { number: 0, transition_id: null, state: { approved: false, executed: false, cancelled: false } },
        { number: 1, transition_id: "approve", state: { approved: true, executed: false, cancelled: false } },
        { number: 2, transition_id: "cancel", state: { approved: true, executed: false, cancelled: true } },
        { number: 3, transition_id: "execute", state: { approved: true, executed: true, cancelled: true } },
      ],
    };
    const analysis = analyzeTrace(model, result, projection);
    expect(analysis.consistent).toBe(true);
    const cancelEdge = analysis.steps[2]!.edgeId!;
    const { edges } = buildFlowElements(projection, layoutProjection(projection), model.transitions, {
      trace: { analysis, currentIndex: 3 }, selection: { kind: "transition", transitionId: "cancel", edgeId: cancelEdge },
    });
    const cancel = edges.find(edge => edge.data!.chips[0]!.edgeId === cancelEdge)!;
    const execute = edges.find(edge => edge.data!.chips[0]!.edgeId === analysis.steps[3]!.edgeId)!;
    expect(cancel.id).not.toBe(execute.id);
    expect(cancel.data!.chips[0]).toMatchObject({ traceSteps: [2], selected: true, current: false, violation: false });
    expect(execute.data!.chips[0]).toMatchObject({ traceSteps: [3], selected: false, current: true, violation: true });
  });

  it("выделяет следующие дорожки для нескольких петель и сохраняет длинные имена", () => {
    const model = booleanRequest();
    model.transitions.push(...Array.from({ length: 3 }, (_, index) => ({ ...model.transitions[1]!,
      id: `repeat_${index}`, name: "Очень длинное название дополнительного перехода для согласованной заявки", guard: variable("approved") })));
    const projection = projectionFor(model);
    const edges = buildFlowElements(projection, layoutProjection(projection), model.transitions).edges;
    const loops = edges.filter(edge => edge.source === approved(true) && edge.target === approved(true));
    expect(loops).toHaveLength(5);
    expect(new Set(loops.map(edge => edge.data!.arcY)).size).toBe(5);
    expect(loops.every(edge => edge.data!.labelMaxWidth <= 176 && edge.data!.chips.length === 1)).toBe(true);
    expect(loops.filter(edge => edge.data!.chips[0]!.transitionId.startsWith("repeat_")).map(edge => edge.data!.chips[0]!.name)).toEqual(model.transitions.slice(3).map(transition => transition.name));
  });
});
