import { useEffect } from "react";
import { useCore } from "../../app/core";
import type { WorkspaceViewProps } from "../../app/extensions";
import { describeCode, describeError } from "../../api/errors";
import { isTerminal, type VerificationResult } from "../../api/types";
import { RUN_STATE, statusInfo, summarizeResults } from "../../domain/status";
import type { CheckRunView } from "../../state/types";
import { findNarrative, ResultDetail } from "../check/ResultDetail";
import { ErrorNotice, QuietStatus } from "../Notice";
import { StatusBadge } from "../StatusBadge";
import { Download, Play, Stop } from "../icons";

function when(check: CheckRunView, demo: boolean): string {
  const limits = check.results?.[0]?.limits;
  const suffix = limits ? ` · ${limits.timeout_seconds} с, ${limits.max_states.toLocaleString("ru-RU")} сост.` : "";
  if (!check.startedAt) return `${demo ? "Записанный прогон" : "Прогон"}${suffix}`;
  const date = new Date(check.startedAt);
  return date.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + suffix;
}

/** Results whose version or model hash differ from the selected version are not shown as its results. */
export function boundResults(check: CheckRunView, versionId: string, specHash: string): { own: VerificationResult[]; foreign: number } {
  const results = check.results ?? [];
  const own = results.filter((r) => r.version_id === versionId && r.spec_hash === specHash);
  return { own, foreign: results.length - own.length };
}

function sortForReading(results: VerificationResult[]): VerificationResult[] {
  const rank = (r: VerificationResult) => (r.status === "PROPERTY_VIOLATED" ? 0 : statusInfo(r.status).conclusive ? 2 : 1);
  return [...results].sort((a, b) => rank(a) - rank(b));
}

export function CheckView({ context }: WorkspaceViewProps) {
  const core = useCore();
  const { version, checks, selection, trace } = context;
  const demo = context.capabilities.adapter === "demo";
  const selected = checks.find((c) => c.runId === selection.trace?.checkRunId) ?? checks[0] ?? null;
  const bound = selected && version ? boundResults(selected, version.id, version.spec_hash) : null;
  const ordered = bound ? sortForReading(bound.own) : [];
  const propertyId = selection.trace?.checkRunId === selected?.runId ? selection.trace?.propertyId : undefined;
  const result = ordered.find((r) => r.property_id === propertyId) ?? null;

  // Open the most informative result once a run has results and nothing is chosen yet.
  useEffect(() => {
    if (selected && !result && ordered[0]) {
      context.focusTrace({ checkRunId: selected.runId, propertyId: ordered[0].property_id });
    }
  }, [selected, result, ordered, context]);

  if (!version) return null;

  if (checks.length === 0) {
    return (
      <div className="view view--empty">
        <div className="empty">
          <h2 className="empty__title">Версия {version.number} ещё не проверялась</h2>
          <p className="empty__text">Проверьте таблицы модели, затем запустите TLC для выбранных свойств.</p>
          <button type="button" className="button button--primary" onClick={core.runCheck} disabled={core.selectedProperties.length === 0}>
            <Play size={16} /> Проверить версию {version.number}
          </button>
        </div>
      </div>
    );
  }

  const run = selected?.run ?? null;
  const active = run ? !isTerminal(run.state) : selected !== null && selected.results === null && selected.resultsError === null;

  return (
    <div className="view check-view">
      {checks.length > 1 && (
        <nav className="runs" aria-label="Проверки версии">
          {checks.map((check) => {
            const summary = summarizeResults(boundResults(check, version.id, version.spec_hash).own);
            const current = check.runId === selected?.runId;
            return (
              <button key={check.runId} type="button" className="run-chip" aria-pressed={current}
                onClick={() => context.focusTrace({ checkRunId: check.runId, propertyId: "" })}>
                <span>{when(check, demo)}</span>
                <span className={`run-chip__state tone--${check.run && !isTerminal(check.run.state) ? "pending" : summary.tone}`}>
                  {check.run && !isTerminal(check.run.state) ? RUN_STATE[check.run.state] : summary.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {selected && (
        <section className="run-panel" aria-label="Проверка">
          <div className="run-panel__line">
            <span className="muted">{when(selected, demo)}</span>
            {run && <span className={`run-state run-state--${run.state}`}>{RUN_STATE[run.state]}</span>}
            {active && <span className="spinner" aria-hidden="true" />}
            {active && run && (run.state === "queued" || run.state === "running") && (
              <button type="button" className="button button--small button--ghost" onClick={() => void core.workspace.cancelCheck(selected.runId)}
                disabled={selected.cancelRequested}>
                <Stop size={14} /> {selected.cancelRequested ? "Останавливается" : "Остановить"}
              </button>
            )}
          </div>

          {selected.stream.kind === "reconnecting" && (
            <QuietStatus>Связь с сервером прервана · повтор {selected.stream.attempt}/{selected.stream.maxAttempts}</QuietStatus>
          )}
          {selected.stream.kind === "lost" && active && (
            <ErrorNotice error={selected.stream.error} title="Нет связи с ходом проверки"
              action={<button type="button" className="button button--small" onClick={() => core.workspace.reconnect(selected.runId)}>Переподключиться</button>} />
          )}
          {selected.failure?.code === "CANCELLED" && <QuietStatus>Проверка остановлена, результата нет.</QuietStatus>}
          {selected.failure && selected.failure.code !== "CANCELLED" && (
            <ErrorNotice title="Проверка не выполнена" detail={describeCode(selected.failure.code) ?? selected.failure.code}
              action={<button type="button" className="button button--small" onClick={core.runCheck}>Проверить заново</button>} />
          )}
          {selected.resultsError !== null && (
            <ErrorNotice error={selected.resultsError} title="Результат проверки не загружен"
              action={<button type="button" className="button button--small" onClick={() => core.workspace.reconnect(selected.runId)}>Повторить</button>} />
          )}
          {active && selected.results !== null && selected.results.length === 0 && (
            <QuietStatus busy>TLC проверяет версию {version.number}</QuietStatus>
          )}
          {!active && run?.state === "completed" && selected.results?.length === 0 && (
            <ErrorNotice error={new Error("Сервер завершил проверку без отчёта")} title="Нет результатов" />
          )}
          {bound && bound.foreign > 0 && (
            <p className="warn-text" role="note">
              {bound.foreign} результат(а) относятся к другой версии или другому хешу модели и скрыты.
            </p>
          )}

          {ordered.length > 0 && (
            <div className="results">
              <ul className="results__list" aria-label="Свойства">
                {ordered.map((r) => {
                  const property = version.spec.properties.find((p) => p.id === r.property_id);
                  return (
                    <li key={r.property_id}>
                      <button type="button" className="result-row" aria-pressed={r.property_id === result?.property_id}
                        onClick={() => context.focusTrace({ checkRunId: selected.runId, propertyId: r.property_id })}>
                        <span className="result-row__name">{property?.name ?? r.property_id}</span>
                        <StatusBadge status={r.status} size="sm" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {result && (
                <ResultDetail version={version} result={result}
                  focus={trace && trace.result.property_id === result.property_id && trace.check.runId === selected.runId ? trace : null}
                  requirements={context.requirements}
                  narrative={findNarrative(core.history?.verifications ?? [], result)}
                  onStep={context.setTraceStep} onSelect={context.select} />
              )}
            </div>
          )}

          {context.capabilities.artifacts && run?.state === "completed" && (
            <section className="artifacts" aria-label="Файлы прогона">
              <h4>Файлы прогона</h4>
              {selected.artifacts.loading && <QuietStatus busy>Загрузка списка</QuietStatus>}
              {selected.artifacts.error !== null && <p className="muted">{describeError(selected.artifacts.error)}</p>}
              {selected.artifacts.data && (
                <ul className="artifacts__list">
                  {selected.artifacts.data.map((file) => (
                    <li key={file.name}>
                      <a href={context.api.artifactUrl(selected.runId, file.name)} download={file.name.split("/").pop()}>
                        <Download size={14} /> {file.name}
                      </a>
                      <span className="muted small">{file.size.toLocaleString("ru-RU")} Б</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </section>
      )}
    </div>
  );
}
