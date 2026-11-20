import { useState } from "react";
import type { ReactNode } from "react";
import type {
  BehavioralModel,
  Transition,
  Value,
  Variable,
} from "../../contracts/model";
import { domainSize } from "../../dsl/evaluate";
import { formatExpression, formatValue } from "../../dsl/expression-text";
import { cx } from "../../ui/cx";
import { CloseIcon, CopyIcon, PencilIcon } from "../../ui/icons";
import { formatEffects } from "../draft";
import type { GraphSelection } from "../flow-elements";
import type { ProjectionEdge, StateProjection } from "../projection";
import type { AnalyzedStep, TraceAnalysis } from "../trace";

export function domainText(variable: Variable): string {
  const { domain } = variable;
  if (domain.kind === "boolean") return "boolean";
  if (domain.kind === "integer")
    return `integer ${domain.minimum}…${domain.maximum}`;
  return `enum, ${domainSize(domain)} знач.`;
}

function RequirementList({
  model,
  ids,
  onSelect,
}: {
  model: BehavioralModel;
  ids: string[];
  onSelect?: ((id: string) => void) | undefined;
}) {
  if (ids.length === 0) return null;
  return (
    <ul className="pv-reqs">
      {ids.map((id) => {
        const requirement = model.requirements.find((item) => item.id === id);
        return (
          <li key={id}>
            {onSelect ? (
              <button
                type="button"
                className="pv-req-code"
                onClick={() => onSelect(id)}
              >
                {id}
              </button>
            ) : (
              <span className="pv-req-code">{id}</span>
            )}
            <span className="pv-req-text">
              {requirement?.text ?? "Требования нет в этой версии"}
              {requirement && (
                <small className="pv-muted">
                  {requirement.source_refs.map((ref, i) => (
                    <span key={i}>
                      {" "}
                      {ref.source_id}
                      {ref.quote ? `: «${ref.quote}»` : ""}
                    </span>
                  ))}
                </small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function stageName(projection: StateProjection, id: string): string {
  return projection.nodes.find((node) => node.id === id)?.label ?? id;
}

function TransitionLinks({
  edges,
  projection,
  names,
  direction,
  onSelect,
}: {
  edges: ProjectionEdge[];
  projection: StateProjection;
  names: Map<string, string>;
  direction: "out" | "in";
  onSelect: (selection: GraphSelection) => void;
}) {
  if (edges.length === 0) return <span className="pv-muted">нет</span>;
  return (
    <span className="pv-links">
      {edges.map((edge) => {
        const other = direction === "out" ? edge.target : edge.source;
        const name = names.get(edge.transitionId) ?? edge.transitionId;
        const condition = edge.guardResidual
          ? `, если ${formatExpression(edge.guardResidual)}`
          : "";
        return (
          <button
            key={edge.id}
            type="button"
            className={cx(
              "pv-link-chip",
              edge.kind !== "unconditional" && "is-conditional",
            )}
            onClick={() =>
              onSelect({
                kind: "transition",
                transitionId: edge.transitionId,
                edgeId: edge.id,
              })
            }
          >
            {name} {direction === "out" ? "→" : "←"}{" "}
            {edge.selfLoop ? "тот же этап" : stageName(projection, other)}
            {condition && (
              <span className="pv-link-chip__cond">{condition}</span>
            )}
          </button>
        );
      })}
    </span>
  );
}

export function NodeInspector({
  model,
  projection,
  nodeId,
  onSelect,
  onClose,
  onRequirementSelect,
  editSlot,
}: {
  model: BehavioralModel;
  projection: StateProjection;
  nodeId: string;
  onSelect: (selection: GraphSelection) => void;
  onClose: () => void;
  onRequirementSelect?: ((id: string) => void) | undefined;
  editSlot?: ReactNode;
}) {
  const node = projection.nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  const names = new Map(
    model.transitions.map((transition) => [transition.id, transition.name]),
  );
  const outgoing = projection.edges.filter((edge) => edge.source === nodeId);
  const incoming = projection.edges.filter(
    (edge) => edge.target === nodeId && !edge.selfLoop,
  );
  const requirementIds = [
    ...new Set(
      projection.variables.flatMap((variable) => variable.requirement_ids),
    ),
  ];
  return (
    <section className="pv-inspector__card" aria-label={`Этап ${node.label}`}>
      <header className="pv-inspector__head">
        <span
          className={cx("pv-inspector__dot", node.initial && "is-initial")}
          aria-hidden="true"
        />
        <h3>{node.label}</h3>
        <button
          type="button"
          className="pv-icon-button"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <CloseIcon />
        </button>
      </header>
      <dl className="pv-rows">
        {node.outOfDomain ? (
          <Row label="Значение">
            Присваивание выводит переменную за её область; проверка такой модели
            вернёт MODEL_INVALID.
          </Row>
        ) : (
          <Row label="Значения">
            <code>
              {projection.variables
                .map(
                  (variable) =>
                    `${variable.id} = ${formatValue(node.values[variable.id]!)}`,
                )
                .join(", ") || "—"}
            </code>
            {node.initial && <span className="pv-tag">начальное</span>}
          </Row>
        )}
        {projection.hiddenVariables.length > 0 && (
          <Row label="Не зафиксированы">
            {projection.hiddenVariables.map((variable) => (
              <span key={variable.id} className="pv-var">
                <code>{variable.id}</code>{" "}
                <span className="pv-muted">{domainText(variable)}</span>
              </span>
            ))}
          </Row>
        )}
        <Row label="Выходы">
          <TransitionLinks
            edges={outgoing}
            projection={projection}
            names={names}
            direction="out"
            onSelect={onSelect}
          />
        </Row>
        <Row label="Входы">
          <TransitionLinks
            edges={incoming}
            projection={projection}
            names={names}
            direction="in"
            onSelect={onSelect}
          />
        </Row>
        <Row label="Требования">
          <RequirementList
            model={model}
            ids={requirementIds}
            onSelect={onRequirementSelect}
          />
        </Row>
      </dl>
      {editSlot}
    </section>
  );
}

export function TransitionInspector({
  model,
  projection,
  transition,
  edgeId,
  trace,
  onClose,
  onEdit,
  onRequirementSelect,
}: {
  model: BehavioralModel;
  projection: StateProjection | null;
  transition: Transition;
  edgeId: string | null;
  trace: TraceAnalysis | null;
  onClose: () => void;
  onEdit?: (() => void) | undefined;
  onRequirementSelect?: ((id: string) => void) | undefined;
}) {
  const edge =
    edgeId && projection
      ? (projection.edges.find((item) => item.id === edgeId) ?? null)
      : null;
  const usedAt =
    trace?.steps
      .filter((step) => step.transitionId === transition.id)
      .map((step) => step.index) ?? [];
  const neverEnabled =
    projection?.neverEnabled.includes(transition.id) ?? false;
  return (
    <section
      className="pv-inspector__card"
      aria-label={`Переход ${transition.name}`}
    >
      <header className="pv-inspector__head">
        <h3>
          Переход «{transition.name}»{" "}
          <span className="pv-muted pv-mono">{transition.id}</span>
        </h3>
        {onEdit && (
          <button
            type="button"
            className="pv-button pv-button--quiet"
            onClick={onEdit}
          >
            <PencilIcon /> Изменить
          </button>
        )}
        <button
          type="button"
          className="pv-icon-button"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <CloseIcon />
        </button>
      </header>
      <dl className="pv-rows">
        <Row label="Условие">
          <code className="pv-code-block">
            {formatExpression(transition.guard)}
          </code>
        </Row>
        {edge && projection && (
          <Row label="Эта стрелка">
            <span>
              {stageName(projection, edge.source)} →{" "}
              {edge.selfLoop
                ? "тот же этап"
                : stageName(projection, edge.target)}
              {edge.guardResidual ? (
                <>
                  , только если{" "}
                  <code>{formatExpression(edge.guardResidual)}</code>
                </>
              ) : (
                ", условие выполнено на этом этапе"
              )}
              {Object.keys(edge.effectResiduals).length > 0 && (
                <>
                  ; этап вычисляется:{" "}
                  <code>
                    {Object.entries(edge.effectResiduals)
                      .map(
                        ([variable, value]) =>
                          `${variable} := ${formatExpression(value)}`,
                      )
                      .join("; ")}
                  </code>
                </>
              )}
            </span>
          </Row>
        )}
        {neverEnabled && (
          <Row label="На графе">
            Условие ложно на каждом этапе текущей проекции, поэтому стрелки нет.
          </Row>
        )}
        <Row label="Эффекты">
          <code className="pv-code-block">
            {formatEffects(transition.effects)}
          </code>
        </Row>
        <Row label="Требования">
          <RequirementList
            model={model}
            ids={transition.requirement_ids}
            onSelect={onRequirementSelect}
          />
        </Row>
        {usedAt.length > 0 && (
          <Row label="В трассе">шаг {usedAt.join(", ")}</Row>
        )}
      </dl>
    </section>
  );
}

function valueText(value: Value | undefined): string {
  return value === undefined ? "—" : formatValue(value);
}

export function StepState({
  model,
  analysis,
  step,
  total,
}: {
  model: BehavioralModel;
  analysis: TraceAnalysis;
  step: AnalyzedStep;
  total: number;
}) {
  const [copied, setCopied] = useState(false);
  const names = new Map(
    model.transitions.map((transition) => [transition.id, transition.name]),
  );
  const property = analysis.property;
  const isFocus = analysis.focusIndex === step.index;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(step.state, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section
      className={cx(
        "pv-inspector__card",
        "pv-step",
        isFocus && analysis.role !== "witness" && "is-violation",
      )}
      aria-label="Состояние на шаге трассы"
    >
      <header className="pv-inspector__head">
        <h3>
          {step.index === 0
            ? "Начальное состояние"
            : `Шаг ${step.index}: ${step.transitionName ?? step.transitionId}`}
          <span className="pv-muted">
            {" "}
            · {step.index} из {total}
          </span>
        </h3>
        <button
          type="button"
          className="pv-icon-button"
          onClick={copy}
          aria-label="Скопировать состояние как JSON"
          title="Скопировать JSON"
        >
          <CopyIcon />
        </button>
        <span className="pv-visually-hidden" aria-live="polite">
          {copied ? "Скопировано" : ""}
        </span>
      </header>
      <table className="pv-state-table">
        <thead>
          <tr>
            <th scope="col">Переменная</th>
            <th scope="col">Значение</th>
          </tr>
        </thead>
        <tbody>
          {model.variables.map((variable) => {
            const change = step.changed[variable.id];
            return (
              <tr key={variable.id} className={cx(change && "is-changed")}>
                <th scope="row">
                  <code>{variable.id}</code>{" "}
                  <span className="pv-muted">{variable.name}</span>
                </th>
                <td>
                  <code>{valueText(step.state[variable.id])}</code>
                  {change && (
                    <span className="pv-was">
                      было {formatValue(change[0])}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!step.replay.ok && (
        <p className="pv-alert" role="alert">
          Шаг не согласуется с моделью версии: {step.replay.message}
        </p>
      )}
      <dl className="pv-rows">
        {property && step.predicate !== null && (
          <Row
            label={
              property.kind === "invariant"
                ? "Инвариант"
                : property.kind === "reachable"
                  ? "Цель"
                  : property.kind === "forbidden_state"
                    ? "Запрещено"
                    : "Допустимый конец"
            }
          >
            <code>{formatExpression(property.predicate)}</code> ={" "}
            <code>{String(step.predicate)}</code>
            {isFocus && analysis.role === "counterexample" && (
              <strong className="pv-violation-text"> — нарушение</strong>
            )}
            {isFocus && analysis.role === "witness" && (
              <strong> — цель достигнута</strong>
            )}
          </Row>
        )}
        <Row label="Разрешены">
          {step.enabled.length === 0 ? (
            <span
              className={cx(
                analysis.role === "deadlock" && isFocus && "pv-violation-text",
              )}
            >
              ни один переход
            </span>
          ) : (
            step.enabled.map((id) => names.get(id) ?? id).join(", ")
          )}
        </Row>
      </dl>
    </section>
  );
}
