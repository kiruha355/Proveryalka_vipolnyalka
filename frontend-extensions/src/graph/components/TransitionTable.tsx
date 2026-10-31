import type { BehavioralModel } from "../../contracts/model";
import { formatExpression } from "../../dsl/expression-text";
import { cx } from "../../ui/cx";
import { formatEffects } from "../draft";
import type { GraphSelection } from "../flow-elements";
import type { StateProjection } from "../projection";
import type { TraceAnalysis } from "../trace";

/**
 * Табличный вид тех же данных, что и граф: переходы в порядке DSL, этапы
 * откуда/куда по проекции. Подходит для чтения с клавиатуры и экранного
 * диктора и для моделей, где граф перегружен.
 */
export function TransitionTable({
  model,
  projection,
  selection,
  trace,
  onSelect,
}: {
  model: BehavioralModel;
  projection: StateProjection | null;
  selection: GraphSelection | null;
  trace: TraceAnalysis | null;
  onSelect: (selection: GraphSelection) => void;
}) {
  const labels = new Map(
    projection?.nodes.map((node) => [node.id, node.label]) ?? [],
  );
  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <caption className="pv-visually-hidden">
          Переходы модели {model.name}
        </caption>
        <thead>
          <tr>
            <th scope="col">Переход</th>
            <th scope="col">Условие</th>
            <th scope="col">Эффекты</th>
            {projection && <th scope="col">Этапы</th>}
            <th scope="col">Требования</th>
            {trace && <th scope="col">Шаг трассы</th>}
          </tr>
        </thead>
        <tbody>
          {model.transitions.map((transition) => {
            const edges =
              projection?.edges.filter(
                (edge) => edge.transitionId === transition.id,
              ) ?? [];
            const selected =
              selection?.kind === "transition" &&
              selection.transitionId === transition.id;
            const steps =
              trace?.steps
                .filter((step) => step.transitionId === transition.id)
                .map((step) => step.index) ?? [];
            return (
              <tr
                key={transition.id}
                className={cx(
                  selected && "is-selected",
                  steps.length > 0 && "is-trace",
                )}
                aria-selected={selected}
              >
                <th scope="row">
                  <button
                    type="button"
                    className="pv-table__select"
                    onClick={() =>
                      onSelect({
                        kind: "transition",
                        transitionId: transition.id,
                        edgeId: null,
                      })
                    }
                  >
                    {transition.name}
                  </button>
                  <span className="pv-muted pv-mono">{transition.id}</span>
                </th>
                <td>
                  <code>{formatExpression(transition.guard)}</code>
                </td>
                <td>
                  <code>{formatEffects(transition.effects)}</code>
                </td>
                {projection && (
                  <td>
                    {edges.length === 0 ? (
                      <span className="pv-muted">ни с одного этапа</span>
                    ) : (
                      <ul className="pv-table__edges">
                        {edges.map((edge) => (
                          <li
                            key={edge.id}
                            className={cx(
                              edge.kind !== "unconditional" && "is-conditional",
                            )}
                          >
                            {labels.get(edge.source)} →{" "}
                            {edge.selfLoop ? "тот же" : labels.get(edge.target)}
                            {edge.guardResidual && (
                              <span className="pv-muted">
                                {" "}
                                если {formatExpression(edge.guardResidual)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                )}
                <td>{transition.requirement_ids.join(", ")}</td>
                {trace && <td>{steps.join(", ")}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
