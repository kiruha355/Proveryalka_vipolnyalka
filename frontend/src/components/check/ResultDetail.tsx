import type { ElementRef, TraceFocus } from "../../app/workspace";
import type { ModelVersion, PropertyExplanation, VerificationNarrative, VerificationOutcome, VerificationResult } from "../../api/types";
import type { RequirementIndex } from "../../domain/requirements";
import { NEXT_STEP, PROPERTY_KIND, statusInfo, statusMeaning } from "../../domain/status";
import { sameJson } from "../../domain/versionDiff";
import { Expr } from "../Expr";
import { RequirementChips } from "../RequirementChips";
import { StatusBadge } from "../StatusBadge";
import { FactualExplanation, TraceView } from "./TraceView";

export interface Narrative {
  summary: string;
  property: PropertyExplanation;
  question: string | null;
}

/** An agent narrative applies only to the exact same report: same model hash, property and trace. */
export function findNarrative(outcomes: VerificationOutcome[], result: VerificationResult): Narrative | null {
  for (const outcome of [...outcomes].reverse()) {
    const narrative: VerificationNarrative | null = outcome.explanation;
    if (!narrative) continue;
    const match = outcome.report.results.find((r) => r.property_id === result.property_id);
    if (!match || match.spec_hash !== result.spec_hash || match.status !== result.status || !sameJson(match.trace, result.trace)) continue;
    const property = narrative.properties.find((p) => p.property_id === result.property_id);
    if (property) return { summary: narrative.summary, property, question: narrative.question };
  }
  return null;
}

const number = (value: number | null | undefined, unit = "") =>
  value === null || value === undefined ? <span className="muted">нет данных</span> : <>{value.toLocaleString("ru-RU")}{unit}</>;

interface Props {
  version: ModelVersion;
  result: VerificationResult;
  focus: TraceFocus | null;
  requirements: RequirementIndex | null;
  narrative: Narrative | null;
  onStep(index: number): void;
  onSelect(element: ElementRef): void;
}

export function ResultDetail({ version, result, focus, requirements, narrative, onStep, onSelect }: Props) {
  const property = version.spec.properties.find((p) => p.id === result.property_id);
  const info = statusInfo(result.status);
  const stats = result.statistics;
  const limits = result.limits;

  return (
    <article className="result" aria-labelledby={`result-${result.property_id}`}>
      <header className="result__header">
        <div>
          <h3 id={`result-${result.property_id}`} className="result__title">
            <button type="button" className="link-button" onClick={() => onSelect({ kind: "property", id: result.property_id })}>
              {property?.name ?? result.property_id}
            </button>
          </h3>
          <p className="result__kind">
            {property ? PROPERTY_KIND[property.kind].label : "Свойство отсутствует в версии"} · <code>{result.property_id}</code>
          </p>
        </div>
        <StatusBadge status={result.status} />
      </header>

      {property && (
        <p className="result__predicate">
          <span className="muted">Условие</span> <Expr value={property.predicate} />
        </p>
      )}

      <div className={`verdict verdict--${info.tone}`}>
        <p>{statusMeaning(result.status, property?.kind)}</p>
        {!info.conclusive && NEXT_STEP[result.status] && <p className="verdict__next">{NEXT_STEP[result.status]}</p>}
      </div>

      {result.mode === "test" && <p className="warn-text">Результат тестового адаптера, не TLC.</p>}

      {focus && focus.steps.length > 0 && (
        <TraceView focus={focus} model={version.spec} requirements={requirements} onStep={onStep} onSelect={onSelect} />
      )}

      {focus && focus.role !== "none" && (
        <section className="result__section" aria-label="Как получен результат">
          <h4>{focus.role === "witness" ? "Путь к цели" : focus.role === "unreachable" ? "Почему цель недостижима" : "Как возникло нарушение"}</h4>
          <FactualExplanation focus={focus} requirements={requirements} />
        </section>
      )}

      {narrative && (
        <section className="result__section narrative" aria-label="Объяснение агента">
          <h4>Объяснение агента</h4>
          <p>{narrative.property.explanation}</p>
          {narrative.property.steps.length > 0 && (
            <ol className="narrative__steps">
              {narrative.property.steps.map((s) => <li key={s.number} value={s.number}>{s.explanation}</li>)}
            </ol>
          )}
          {narrative.property.hypotheses.map((h) => (
            <p key={h} className="hypothesis"><span className="tag tag--hypothesis">Гипотеза</span>{h}</p>
          ))}
          {narrative.question && <p className="narrative__question">{narrative.question}</p>}
        </section>
      )}

      <section className="result__section">
        <h4>Связанные требования</h4>
        {result.related_requirements.length === 0 ? (
          <p className="muted">Движок не указал связанных требований.</p>
        ) : (
          <ul className="req-list">
            {result.related_requirements.map((id) => {
              const requirement = requirements?.byId.get(id);
              return (
                <li key={id}>
                  <RequirementChips ids={[id]} index={requirements} onSelect={(rid) => onSelect({ kind: "requirement", id: rid })} />
                  <span>{requirement ? requirement.text : <span className="warn-text">нет в каталоге требований этой версии</span>}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <details className="result__section result__meta">
        <summary>Движок и лимиты</summary>
        <p className="engine-message">{result.message}</p>
        <dl className="stats">
          <div><dt>Состояний сгенерировано</dt><dd>{number(stats.states_generated)}</dd></div>
          <div><dt>Различных состояний</dt><dd>{number(stats.distinct_states)}</dd></div>
          <div><dt>Глубина</dt><dd>{number(stats.depth)}</dd></div>
          <div><dt>Время</dt><dd>{number(stats.elapsed_seconds === null ? null : Math.round(stats.elapsed_seconds * 100) / 100, " с")}</dd></div>
        </dl>
        <p className="muted small">
          {result.executed && result.engine ? `${result.engine.name} ${result.engine.version}` : "Движок не запускался"}
          {" · "}лимиты: {limits.timeout_seconds} с, {limits.max_states.toLocaleString("ru-RU")} состояний
          {limits.max_depth === null ? "" : `, глубина ${limits.max_depth}`}
        </p>
      </details>
    </article>
  );
}

