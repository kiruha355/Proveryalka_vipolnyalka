import { describe, expect, it } from "vitest";
import type {
  BehavioralModel,
  Expression,
  Transition,
  VerificationResult,
} from "../contracts/model";
import { domainValues, evaluate } from "../dsl/evaluate";
import { formatExpression } from "../dsl/expression-text";
import { normalizeSpec } from "../dsl/normalize";
import type { LooseBehavioralModel } from "../dsl/normalize";
import { computeSpecHash } from "../dsl/spec-hash";
import { validateModel } from "../dsl/validate";
import counterOverflow from "../fixtures/models/counter_overflow.json";
import grid from "../fixtures/models/grid.json";
import {
  ORDER_BUG_SPEC,
  ORDER_FIXED_SPEC,
  ORDER_VERSIONS,
  TLC_ORDER_BUG_RESULT,
  TLC_ORDER_FIXED_RESULT,
} from "../fixtures/order-versions";
import { TICKETS_SPEC } from "../fixtures/tickets";
import {
  applyDraftAction,
  diffModels,
  draftIdempotencyKey,
  DraftError,
  transitionTemplate,
  versionCreateBody,
} from "./draft";
import { layoutProjection } from "./layout";
import {
  defaultProjection,
  nodeForState,
  nodeKey,
  OUT_OF_DOMAIN_NODE_ID,
  projectModel,
} from "./projection";
import type { StateProjection } from "./projection";
import { analyzeTrace, bindReportToVersion, pickTraceResult } from "./trace";

function project(model: BehavioralModel, ids: string[]): StateProjection {
  const result = projectModel(model, ids);
  if (!result.ok) throw new Error(result.reason);
  return result.projection;
}

const status = (value: string) => nodeKey({ status: value }, ["status"]);

function edgesOf(projection: StateProjection, transitionId: string) {
  return projection.edges
    .filter((edge) => edge.transitionId === transitionId)
    .map(
      (edge) =>
        `${JSON.parse(edge.source)[0]}→${JSON.parse(edge.target)[0]}:${edge.kind}`,
    )
    .sort();
}

/** Все состояния модели полным перебором — только для проверки полноты проекции в тестах. */
function allStates(
  model: BehavioralModel,
): Array<Record<string, boolean | number | string>> {
  let states: Array<Record<string, boolean | number | string>> = [{}];
  for (const variable of model.variables) {
    states = states.flatMap((state) =>
      domainValues(variable.domain).map((value) => ({
        ...state,
        [variable.id]: value,
      })),
    );
  }
  return states;
}

function step(
  transition: Transition,
  state: Record<string, boolean | number | string>,
) {
  const next = { ...state };
  for (const effect of transition.effects)
    next[effect.variable] = evaluate(effect.value, state);
  return next;
}

describe("проекция модели на этапы", () => {
  it("по умолчанию выбирает enum status", () => {
    expect(defaultProjection(ORDER_BUG_SPEC)).toEqual(["status"]);
    expect(defaultProjection(TICKETS_SPEC)).toEqual(["phase"]);
  });

  it("строит рёбра ошибочной модели заявки с условиями на скрытые переменные", () => {
    const projection = project(ORDER_BUG_SPEC, ["status"]);
    expect(projection.nodes.map((node) => node.label)).toEqual([
      "Created",
      "Approved",
      "Cancelled",
      "Executed",
    ]);
    expect(projection.nodes.find((node) => node.initial)?.label).toBe(
      "Created",
    );
    expect(edgesOf(projection, "Approve")).toEqual([
      "Created→Approved:unconditional",
    ]);
    expect(edgesOf(projection, "Cancel")).toEqual([
      "Approved→Cancelled:unconditional",
      "Created→Cancelled:unconditional",
    ]);
    // Execute проверяет только approved: из любого этапа при approved = true, в том числе из Cancelled.
    expect(edgesOf(projection, "Execute")).toEqual([
      "Approved→Executed:conditional",
      "Cancelled→Executed:conditional",
      "Created→Executed:conditional",
      "Executed→Executed:conditional",
    ]);
    const fromCancelled = projection.edges.find(
      (edge) =>
        edge.transitionId === "Execute" && edge.source === status("Cancelled"),
    )!;
    expect(formatExpression(fromCancelled.guardResidual!)).toBe(
      "approved == true",
    );
    expect(projection.hiddenVariables.map((variable) => variable.id)).toEqual([
      "approved",
      "cancelled",
    ]);
  });

  it("уточняет рёбра при добавлении переменной в проекцию", () => {
    const projection = project(ORDER_FIXED_SPEC, ["status", "approved"]);
    const executeSources = projection.edges
      .filter((edge) => edge.transitionId === "Execute")
      .map(
        (edge) =>
          projection.nodes.find((node) => node.id === edge.source)!.label,
      );
    expect(
      executeSources.every((label) => label.endsWith("approved = true")),
    ).toBe(true);
    expect(
      projection.edges
        .filter((edge) => edge.transitionId === "Execute")
        .every((edge) => edge.kind === "unconditional"),
    ).toBe(true);
  });

  it("не теряет ни одного шага модели (полный перебор малых эталонов)", () => {
    for (const model of [ORDER_BUG_SPEC, ORDER_FIXED_SPEC, TICKETS_SPEC]) {
      for (const ids of [
        defaultProjection(model),
        model.variables.slice(0, 2).map((variable) => variable.id),
        [],
      ]) {
        const projection = project(model, ids);
        for (const state of allStates(model)) {
          for (const transition of model.transitions) {
            if (evaluate(transition.guard, state) !== true) continue;
            const next = step(transition, state);
            const source = nodeForState(projection, state);
            const target = nodeForState(projection, next);
            const found = projection.edges.some(
              (edge) =>
                edge.transitionId === transition.id &&
                edge.source === source &&
                edge.target === target,
            );
            expect(
              found,
              `${model.name} ${ids.join("+")} ${transition.id} ${JSON.stringify(state)}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("показывает присваивание вне области отдельным узлом", () => {
    const projection = project(
      normalizeSpec(counterOverflow as LooseBehavioralModel),
      ["n"],
    );
    const invalid = projection.edges.filter((edge) => edge.kind === "invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.target).toBe(OUT_OF_DOMAIN_NODE_ID);
    expect(invalid[0]!.outOfDomainValues).toEqual({ n: 3 });
  });

  it("отказывает в проекции, которая не помещается в предел, и объясняет почему", () => {
    const model = normalizeSpec(grid as LooseBehavioralModel);
    const result = projectModel(model, ["x"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("3000 узлов");
    expect(defaultProjection(model)).toEqual([]);
    const whole = project(model, []);
    expect(whole.nodes).toHaveLength(1);
    expect(whole.edges.every((edge) => edge.selfLoop)).toBe(true);
  });

  it("отмечает вычисляемую цель, когда эффект зависит от скрытой переменной", () => {
    const model = structuredClone(TICKETS_SPEC);
    model.transitions[0]!.effects = [
      { variable: "phase", value: { kind: "variable", name: "phase" } },
    ];
    const projection = project(model, ["sold"]);
    const sell = projection.edges.filter(
      (edge) => edge.transitionId === "Sell",
    );
    expect(sell.every((edge) => edge.kind !== "computed")).toBe(true);
    const projectionPhase = project(model, ["vip"]);
    model.transitions[2]!.effects = [
      {
        variable: "vip",
        value: {
          kind: "binary",
          op: "eq",
          left: { kind: "variable", name: "sold" },
          right: { kind: "literal", value: 3 },
        },
      },
    ];
    const computed = project(model, ["vip"]).edges.filter(
      (edge) => edge.transitionId === "Close",
    );
    expect(computed.every((edge) => edge.kind === "computed")).toBe(true);
    const both = [
      nodeKey({ vip: false }, ["vip"]),
      nodeKey({ vip: true }, ["vip"]),
    ];
    expect(computed).toHaveLength(4);
    for (const source of both) {
      expect(
        computed
          .filter((edge) => edge.source === source)
          .map((edge) => edge.target)
          .sort(),
      ).toEqual([...both].sort());
    }
    expect(projectionPhase.nodes).toHaveLength(2);
  });

  it("справляется с большой моделью", () => {
    const values = Array.from({ length: 40 }, (_, index) => `S${index}`);
    const base: BehavioralModel = structuredClone(ORDER_BUG_SPEC);
    base.variables = [
      {
        id: "stage",
        name: "Этап",
        requirement_ids: ["R1"],
        domain: { kind: "enum", values },
        initial_value: "S0",
      },
      {
        id: "flag",
        name: "Флаг",
        requirement_ids: ["R1"],
        domain: { kind: "boolean" },
        initial_value: false,
      },
      {
        id: "count",
        name: "Счётчик",
        requirement_ids: ["R1"],
        domain: { kind: "integer", minimum: 0, maximum: 9 },
        initial_value: 0,
      },
    ];
    base.properties = [];
    base.transitions = Array.from({ length: 200 }, (_, index): Transition => {
      const from = values[index % 40]!;
      const to = values[(index * 7 + 3) % 40]!;
      const guard: Expression = {
        kind: "binary",
        op: "eq",
        left: { kind: "variable", name: "stage" },
        right: { kind: "literal", value: from },
      };
      return {
        id: `T${index}`,
        name: `Переход ${index}`,
        requirement_ids: ["R1"],
        guard:
          index % 5 === 0
            ? {
                kind: "binary",
                op: "and",
                left: guard,
                right: { kind: "variable", name: "flag" },
              }
            : guard,
        effects: [{ variable: "stage", value: { kind: "literal", value: to } }],
      };
    });
    expect(validateModel(base)).toEqual([]);
    const started = performance.now();
    const projection = project(base, ["stage"]);
    const layout = layoutProjection(projection);
    const elapsed = performance.now() - started;
    expect(projection.edges).toHaveLength(200);
    expect(Object.keys(layout.boxes)).toHaveLength(40);
    expect(elapsed).toBeLessThan(500);
    const boxes = Object.values(layout.boxes);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe("раскладка", () => {
  it("ставит начальный этап первым и идёт слоями по переходам", () => {
    const projection = project(ORDER_FIXED_SPEC, ["status"]);
    const layout = layoutProjection(projection);
    expect(layout.boxes[status("Created")]!.layer).toBe(0);
    expect(layout.boxes[status("Approved")]!.layer).toBe(1);
    expect(layout.boxes[status("Cancelled")]!.layer).toBe(1);
    expect(layout.boxes[status("Executed")]!.layer).toBe(2);
    expect(layoutProjection(projection)).toEqual(layout);
  });
});

describe("трасса TLC на графе", () => {
  const bugVersion = ORDER_VERSIONS[0]!;
  const fixedVersion = ORDER_VERSIONS[1]!;

  it("привязывает реальный отчёт к версии по spec_hash и отказывает другой версии", () => {
    expect(bindReportToVersion(TLC_ORDER_BUG_RESULT, bugVersion)).toEqual({
      applies: true,
    });
    expect(
      bindReportToVersion(TLC_ORDER_BUG_RESULT, fixedVersion),
    ).toMatchObject({ applies: false, reason: "other_spec" });
    const bound = { ...TLC_ORDER_BUG_RESULT, version_id: bugVersion.id };
    expect(bindReportToVersion(bound, fixedVersion, () => 1)).toEqual({
      applies: false,
      reason: "other_version",
      message: "Отчёт относится к версии 1",
    });
  });

  it("воспроизводит контрпример Approve → Cancel → Execute по DSL версии", () => {
    const projection = project(bugVersion.spec, ["status"]);
    const analysis = analyzeTrace(
      bugVersion.spec,
      TLC_ORDER_BUG_RESULT,
      projection,
    );
    expect(analysis.consistent).toBe(true);
    expect(analysis.role).toBe("counterexample");
    expect(analysis.steps.map((item) => item.transitionId)).toEqual([
      null,
      "Approve",
      "Cancel",
      "Execute",
    ]);
    expect(analysis.steps.map((item) => item.nodeId)).toEqual(
      ["Created", "Approved", "Cancelled", "Executed"].map(status),
    );
    expect(analysis.steps.slice(1).every((item) => item.edgeId !== null)).toBe(
      true,
    );
    expect(analysis.steps[2]!.changed).toEqual({
      status: ["Approved", "Cancelled"],
      cancelled: [false, true],
    });
    expect(analysis.focusIndex).toBe(3);
    expect(analysis.steps[3]!.predicate).toBe(true);
    expect(analysis.steps[2]!.enabled).toContain("Execute");
  });

  it("находит расхождение трассы с исправленной моделью на шаге Execute", () => {
    // Та же трасса против order_fixed: Cancel сбрасывает approved, значит шаг 2 уже не совпадает.
    const analysis = analyzeTrace(
      fixedVersion.spec,
      TLC_ORDER_BUG_RESULT,
      project(fixedVersion.spec, ["status"]),
    );
    expect(analysis.consistent).toBe(false);
    expect(analysis.firstMismatch).toBe(2);
    expect(analysis.steps[2]!.replay).toMatchObject({
      ok: false,
      code: "effect_mismatch",
    });
    expect(analysis.steps[2]!.edgeId).toBeNull();
  });

  it("обнаруживает подменённые шаги", () => {
    const tampered: VerificationResult = structuredClone(TLC_ORDER_BUG_RESULT);
    tampered.trace[3]!.state.cancelled = false;
    const analysis = analyzeTrace(bugVersion.spec, tampered, null);
    expect(analysis.steps[3]!.replay).toMatchObject({
      ok: false,
      code: "frame_violation",
    });

    const wrongInitial: VerificationResult =
      structuredClone(TLC_ORDER_BUG_RESULT);
    wrongInitial.trace[0]!.state.approved = true;
    expect(
      analyzeTrace(bugVersion.spec, wrongInitial, null).firstMismatch,
    ).toBe(0);

    const unknown: VerificationResult = structuredClone(TLC_ORDER_BUG_RESULT);
    unknown.trace[1]!.transition_id = "Archive";
    expect(
      analyzeTrace(bugVersion.spec, unknown, null).steps[1]!.replay,
    ).toMatchObject({ code: "unknown_transition" });
  });

  it("нарушение уже в начальном состоянии даёт фокус на шаге 0", () => {
    const tickets = TICKETS_SPEC;
    const result: VerificationResult = {
      ...TLC_ORDER_BUG_RESULT,
      spec_hash: computeSpecHash(tickets),
      property_id: "SomethingSold",
      trace: [
        {
          number: 0,
          transition_id: null,
          state: { phase: "Open", sold: 0, vip: false },
        },
      ],
    };
    const analysis = analyzeTrace(tickets, result, project(tickets, ["phase"]));
    expect(analysis.consistent).toBe(true);
    expect(analysis.focusIndex).toBe(0);
  });

  it("не придумывает трассу, когда её нет", () => {
    expect(pickTraceResult([TLC_ORDER_FIXED_RESULT])).toBeNull();
    expect(
      pickTraceResult([TLC_ORDER_FIXED_RESULT, TLC_ORDER_BUG_RESULT]),
    ).toBe(TLC_ORDER_BUG_RESULT);
    const analysis = analyzeTrace(
      fixedVersion.spec,
      TLC_ORDER_FIXED_RESULT,
      null,
    );
    expect(analysis.steps).toEqual([]);
    expect(analysis.role).toBe("none");
    expect(analysis.focusIndex).toBeNull();
  });
});

describe("черновик и новая версия", () => {
  const parent = ORDER_VERSIONS[0]!;

  it("исправление из ТЗ меняет только эффекты Cancel и не трогает исходную версию", () => {
    const before = structuredClone(parent.spec);
    const cancel = parent.spec.transitions.find(
      (transition) => transition.id === "Cancel",
    )!;
    const draft = applyDraftAction(parent.spec, {
      type: "set_effects",
      transitionId: "Cancel",
      effects: [
        ...cancel.effects,
        { variable: "approved", value: { kind: "literal", value: false } },
      ],
    });
    expect(parent.spec).toEqual(before);
    expect(validateModel(draft)).toEqual([]);
    const changes = diffModels(parent.spec, draft);
    expect(changes).toEqual([
      {
        kind: "effects_changed",
        id: "Cancel",
        before: 'status := "Cancelled"; cancelled := true',
        after: 'status := "Cancelled"; cancelled := true; approved := false',
      },
    ]);
    const body = versionCreateBody(parent, draft);
    expect(body.parent_id).toBe(parent.id);
    // Переходы черновика совпадают с эталоном исправленной модели order_fixed.
    expect(draft.transitions).toEqual(ORDER_FIXED_SPEC.transitions);
    expect(computeSpecHash(draft)).not.toBe(parent.spec_hash);
    expect(draftIdempotencyKey(parent.id, draft)).toBe(
      draftIdempotencyKey(parent.id, structuredClone(draft)),
    );
    expect(draftIdempotencyKey(parent.id, draft)).not.toBe(
      draftIdempotencyKey(parent.id, parent.spec),
    );
    expect(draftIdempotencyKey(parent.id, draft).length).toBeLessThanOrEqual(
      128,
    );
  });

  it("добавляет этап и переход из узла, блокирует удаление используемого значения", () => {
    let draft = applyDraftAction(parent.spec, {
      type: "add_enum_value",
      variableId: "status",
      value: "Rework",
    });
    const template = transitionTemplate(draft, { status: "Approved" }, "R3");
    draft = applyDraftAction(draft, {
      type: "add_transition",
      transition: {
        ...template,
        id: "Return",
        effects: [
          { variable: "status", value: { kind: "literal", value: "Rework" } },
        ],
      },
    });
    expect(validateModel(draft)).toEqual([]);
    const projection = project(draft, ["status"]);
    expect(
      projection.edges.some(
        (edge) =>
          edge.transitionId === "Return" &&
          edge.source === status("Approved") &&
          edge.target === status("Rework"),
      ),
    ).toBe(true);
    expect(() =>
      applyDraftAction(draft, {
        type: "remove_enum_value",
        variableId: "status",
        value: "Rework",
      }),
    ).toThrow(DraftError);
    expect(() =>
      applyDraftAction(draft, { type: "add_transition", transition: template }),
    ).not.toThrow();
    expect(() =>
      applyDraftAction(draft, {
        type: "add_transition",
        transition: { ...template, id: "Return" },
      }),
    ).toThrow(/уже есть/);
    expect(() =>
      applyDraftAction(draft, {
        type: "add_transition",
        transition: { ...template, id: "1bad" },
      }),
    ).toThrow(DraftError);
    expect(diffModels(parent.spec, draft).map((change) => change.kind)).toEqual(
      ["transition_added", "enum_values_changed"],
    );
  });

  it("сводка изменений не пропускает правки вне переходов", () => {
    const draft = structuredClone(parent.spec);
    draft.properties[0]!.explanation = "Другая формулировка";
    expect(diffModels(parent.spec, draft)).toEqual([
      { kind: "other", path: "properties" },
    ]);
  });
});
it("ограничивает число стрелок до раскладки для крупных моделей",()=>{
 const spec=structuredClone(ORDER_BUG_SPEC);const stage=spec.variables.find(v=>v.id==="status")!;stage.domain={kind:"enum",values:Array.from({length:48},(_,i)=>`S${i}`)};stage.initial_value="S0";spec.transitions=Array.from({length:32},(_,i)=>({...spec.transitions[0]!,id:`T${i}`,guard:{kind:"literal",value:true},effects:[{variable:"status",value:{kind:"literal",value:"S1"}}]}));expect(projectModel(spec,["status"])).toMatchObject({ok:false,reason:expect.stringContaining("1200 стрелок")});
});
