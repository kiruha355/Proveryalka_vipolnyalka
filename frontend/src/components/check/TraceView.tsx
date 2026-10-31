import { Fragment } from "react";
import type { ElementRef, TraceFocus } from "../../app/workspace";
import type { BehavioralModel } from "../../api/types";
import type { RequirementIndex } from "../../domain/requirements";
import { guardFacts, type StepView } from "../../domain/trace";
import { Expr, Val } from "../Expr";
import { RequirementChips } from "../RequirementChips";
import { ChevronLeft, ChevronRight, Reset } from "../icons";

interface Props {
  focus: TraceFocus;
  model: BehavioralModel;
  requirements: RequirementIndex | null;
  onStep(index: number): void;
  onSelect(element: ElementRef): void;
}

export function stepTitle(step: StepView): string {
  if (step.transitionId === null) return "Начальное состояние";
  return step.transition ? step.transition.name : step.transitionId;
}

export function TraceView({ focus, model, requirements, onStep, onSelect }: Props) {
  const { steps, step: current, focus: target, role } = focus;
  const last = steps.length - 1;
  const variables = model.variables;
  const caption = role === "witness" ? "Путь к цели, найденный движком" : "Контрпример, найденный движком";

  return (
    <section className="trace" aria-label={caption}>
      <div className="trace__bar">
        <div className="trace__controls" role="group" aria-label="Шаги трассы">
          <button type="button" className="button button--small button--ghost" onClick={() => onStep(current - 1)} disabled={current <= 0}>
            <ChevronLeft size={16} /> Назад
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => onStep(current + 1)} disabled={current >= last}>
            Шаг <ChevronRight size={16} />
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => onStep(0)} disabled={current === 0}>
            <Reset size={16} /> Сбросить
          </button>
        </div>
        <span className="trace__position" aria-live="polite">
          {current === 0 ? "Начальное состояние" : `Шаг ${current} из ${last}`}
        </span>
      </div>

      <div className="table-wrap">
        <table className="table trace__table">
          <caption className="visually-hidden">{caption}: шаги, действия и значения переменных</caption>
          <thead>
            <tr>
              <th scope="col" className="trace__num">Шаг</th>
              <th scope="col">Действие</th>
              {variables.map((v) => (
                <th scope="col" key={v.id} title={v.name}>
                  <span className="th-name">{v.name}</span>
                  <code className="th-id">{v.id}</code>
                </th>
              ))}
              <th scope="col">Требования</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => {
              const changed = new Set(step.changes.map((c) => c.variable));
              const isTarget = index === target;
              return (
                <tr key={step.number} className={`${index === current ? "is-current" : ""}${isTarget ? ` is-target is-target--${role}` : ""}`}
                  aria-current={index === current ? "step" : undefined}>
                  <td className="trace__num">
                    <button type="button" className="step-button" onClick={() => onStep(index)} aria-label={`Показать шаг ${step.number}`}>
                      {step.number}
                    </button>
                  </td>
                  <td>
                    {step.transitionId === null ? (
                      <span className="muted">начальное</span>
                    ) : step.transition ? (
                      <button type="button" className="link-button" onClick={() => onSelect({ kind: "transition", id: step.transitionId! })}>
                        {step.transition.name}
                      </button>
                    ) : (
                      <span className="warn-text" title="Перехода нет в модели этой версии">{step.transitionId}</span>
                    )}
                    {isTarget && <span className={`tag tag--${role}`}>{role === "witness" ? "цель" : "нарушение"}</span>}
                  </td>
                  {variables.map((v) => {
                    const change = step.changes.find((c) => c.variable === v.id);
                    return (
                      <td key={v.id} className={changed.has(v.id) ? "cell--changed" : undefined}>
                        {change ? (
                          <span className="change">
                            <span className="change__before"><Val value={change.before} /></span>
                            <span aria-hidden="true">→</span>
                            <span className="visually-hidden">стало</span>
                            <Val value={change.after} />
                          </span>
                        ) : (
                          <Val value={step.state[v.id]} />
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <RequirementChips ids={step.requirementIds} index={requirements} onSelect={(id) => onSelect({ kind: "requirement", id })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Explanation assembled only from the trace, the model and the checker's
 * related requirements. No text is generated by an LLM here.
 */
export function FactualExplanation({ focus, requirements }: { focus: TraceFocus; requirements: RequirementIndex | null }) {
  const { steps, focus: target, role, property } = focus;
  if (role === "unreachable") {
    return (
      <div className="facts">
        <p>Движок перебрал все достижимые состояния и не нашёл пути к цели{property ? <> <Expr value={property.predicate} /></> : null}.</p>
      </div>
    );
  }
  if (target === null || steps.length === 0) return null;
  const end = steps[target];
  if (!end) return null;
  const facts = guardFacts(steps, target);
  const label = (id: string) => requirements?.label(id) ?? id;

  return (
    <div className="facts">
      <ol className="facts__steps">
        {steps.slice(0, target + 1).map((step, index) => (
          <li key={step.number} value={step.number}>
            {index === 0 ? (
              <>
                Начальное состояние:{" "}
                {Object.entries(step.state).map(([k, v], i) => (
                  <Fragment key={k}>{i > 0 && ", "}<code>{k}</code> = <Val value={v} /></Fragment>
                ))}
                .
              </>
            ) : (
              <>
                <strong>{stepTitle(step)}</strong>
                {step.requirementIds.length > 0 && <span className="muted"> ({step.requirementIds.map(label).join(", ")})</span>}
                {step.changes.length === 0 ? ": значения переменных не меняются." : ": "}
                {step.changes.map((c, i) => (
                  <Fragment key={c.variable}>
                    {i > 0 && ", "}<code>{c.variable}</code> <Val value={c.before} /> → <Val value={c.after} />
                  </Fragment>
                ))}
                {step.changes.length > 0 && "."}
              </>
            )}
          </li>
        ))}
      </ol>

      {role === "counterexample" && property && (
        <p className="facts__verdict">
          {target === 0 ? "Свойство нарушено уже в начальном состоянии" : `Шаг ${end.number} нарушает свойство «${property.name}»`}
          {property.kind === "deadlock_free"
            ? <>: из этого состояния не разрешён ни один переход, а условие допустимой остановки <Expr value={property.predicate} /> ложно.</>
            : property.kind === "invariant"
              ? <>: условие <Expr value={property.predicate} /> становится ложным.</>
              : <>: достигнуто запрещённое состояние <Expr value={property.predicate} />.</>}
        </p>
      )}
      {role === "witness" && property && (
        <p className="facts__verdict">Шаг {end.number} достигает цели <Expr value={property.predicate} />.</p>
      )}

      {facts.length > 0 && end.transition && (
        <p className="facts__guard">
          «{end.transition.name}» разрешён условием <Expr value={end.transition.guard} />:{" "}
          {facts.map((fact, i) => {
            const origin = fact.setAt === 0 ? "с начального состояния" : `после шага ${steps[fact.setAt]?.number} «${stepTitle(steps[fact.setAt]!)}»`;
            const kept = fact.keptBy.length > 0
              ? `; ${fact.keptBy.map((s) => `«${stepTitle(s)}»`).join(", ")} ${fact.keptBy.length === 1 ? "его не изменил" : "его не изменили"}`
              : "";
            return (
              <Fragment key={fact.variable}>
                {i > 0 && "; "}<code>{fact.variable}</code> = <Val value={fact.value} /> {origin}{kept}
              </Fragment>
            );
          })}
          .
        </p>
      )}
    </div>
  );
}
