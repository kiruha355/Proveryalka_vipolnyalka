import type { ReactNode } from "react";
import type { WorkspaceContextValue } from "../../app/workspace";
import type { DialogueState, ModelVersion, Question } from "../../api/types";
import { isTerminal } from "../../api/types";
import { DIALOGUE_STATUS } from "../../domain/dialogue";
import { indexRequirements } from "../../domain/requirements";
import { RUN_STATE, summarizeResults, traceRole } from "../../domain/status";
import { buildSteps, focusIndex, guardFacts } from "../../domain/trace";
import { sameJson } from "../../domain/versionDiff";
import type { CheckRunView } from "../../state/types";
import { boundResults } from "../views/CheckView";
import { QuestionStatusTag } from "../views/RequirementsView";
import { Expr, Val } from "../Expr";
import { StatusBadge } from "../StatusBadge";
import { Doc, Shield, Stop } from "../icons";

export function UserBubble({ text, time, children }: { text: string; time?: string | null; children?: ReactNode }) {
  return (
    <li className="msg msg--user">
      <div className="msg__bubble">
        <p className="msg__text">{text}</p>
        {time && <span className="msg__time">{time}</span>}
      </div>
      {children}
    </li>
  );
}

export function AgentBlock({ children, icon = "doc", time, label = "Агент" }: { children: ReactNode; icon?: "doc" | "check"; time?: string | null; label?: string }) {
  return (
    <li className="msg msg--agent">
      <span className="msg__avatar" aria-hidden="true">{icon === "check" ? <Shield size={16} /> : <Doc size={16} />}</span>
      <div className="msg__card">
        <span className="visually-hidden">{label}:</span>
        {children}
        {time && <span className="msg__time">{time}</span>}
      </div>
    </li>
  );
}

export function clock(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

interface QuestionProps {
  question: Question;
  active: boolean;
  canAnswer: boolean;
  onAnswer(question: Question, prefill: string | null): void;
}

export function QuestionCard({ question, active, canAnswer, onAnswer }: QuestionProps) {
  const open = question.status === "open";
  return (
    <div className={`question question--${question.kind}${active ? " is-active" : ""}`}>
      <p className="question__text">{question.text}</p>
      <p className="question__reason">{question.reason}</p>
      {question.kind === "assumption" && question.assumption && (
        <p className="question__assumption">Предположение агента: {question.assumption}</p>
      )}
      {!open && <QuestionStatusTag status={question.status} />}
      {open && canAnswer && (
        question.kind === "assumption" && question.assumption ? (
          <div className="answer-chips" role="group" aria-label="Ответ на предположение">
            <button type="button" className="answer-chip" onClick={() => onAnswer(question, `Да, верно: ${question.assumption}`)}>Подтверждаю</button>
            <button type="button" className="answer-chip" onClick={() => onAnswer(question, `Нет, это неверно: ${question.assumption}`)}>Это неверно</button>
            <button type="button" className="answer-chip answer-chip--plain" onClick={() => onAnswer(question, null)}>Ответить своими словами</button>
          </div>
        ) : (
          <button type="button" className="button button--small button--ghost" onClick={() => onAnswer(question, null)}>Ответить</button>
        )
      )}
    </div>
  );
}

interface AnalysisProps {
  state: DialogueState;
  isLatest: boolean;
  time: string | null;
  versions: ModelVersion[];
  context: WorkspaceContextValue;
  replyQuestionId: string | null;
  canAnswer: boolean;
  onAnswer(question: Question, prefill: string | null): void;
}

export function AnalysisEntry({ state, isLatest, time, versions, context, replyQuestionId, canAnswer, onAnswer }: AnalysisProps) {
  const analysis = state.analysis;
  const version = analysis.behavior ? versions.find((v) => sameJson(v.spec, analysis.behavior)) : undefined;
  const open = state.questions.filter((q) => q.status === "open");
  const model = analysis.behavior;
  return (
    <AgentBlock time={time}>
      {analysis.subject && <p className="msg__lead">{analysis.subject}</p>}
      <p className={`dialogue-status dialogue-status--${state.status}`}>{DIALOGUE_STATUS[state.status]}</p>
      {analysis.assumptions.length > 0 && <p className="small">Предположений, ждущих решения: {analysis.assumptions.length}</p>}
      {!model && analysis.model_issues.length > 0 && (
        <p className="small warn-text">Модель не собрана: {analysis.model_issues.length} замечани{analysis.model_issues.length === 1 ? "е" : "й"}</p>
      )}
      {isLatest && open.length > 0 && (
        <div className="questions">
          {open.map((q) => (
            <QuestionCard key={q.id} question={q} active={q.id === replyQuestionId} canAnswer={canAnswer} onAnswer={onAnswer} />
          ))}
        </div>
      )}
      <div className="msg__links">
        {version ? (
          <button type="button" className="text-link" onClick={() => { context.selectVersion(version.id); context.openView("model"); }}>
            Открыть модель · версия {version.number}
          </button>
        ) : model && isLatest ? (
          <span className="muted small">Версия модели загружается</span>
        ) : null}
        <button type="button" className="text-link" onClick={() => context.openView("requirements")}>Требования и цитаты</button>
      </div>
    </AgentBlock>
  );
}

interface CheckCardProps {
  check: CheckRunView;
  version: ModelVersion | undefined;
  /** Model name, when the session has several models. */
  modelName?: string;
  context: WorkspaceContextValue;
  onCancel(): void;
}

/** A check summary in the chat. Wording is assembled from the trace; no LLM text. */
export function CheckCard({ check, version, modelName, context, onCancel }: CheckCardProps) {
  const running = check.run ? !isTerminal(check.run.state) : check.results === null && check.resultsError === null;
  const results = version ? boundResults(check, version.id, version.spec_hash).own : [];
  const summary = summarizeResults(results);
  const violated = results.find((r) => r.status === "PROPERTY_VIOLATED" && r.trace.length > 0);
  const show = (propertyId: string) => {
    if (version) context.selectVersion(version.id);
    context.focusTrace({ checkRunId: check.runId, propertyId });
    context.openView("check");
  };

  let scenario: ReactNode = null;
  if (violated && version) {
    const property = version.spec.properties.find((p) => p.id === violated.property_id);
    const steps = buildSteps(violated, version.spec, property);
    const target = focusIndex(steps, property, traceRole(violated, property?.kind));
    const facts = target !== null ? guardFacts(steps, target) : [];
    const end = target !== null ? steps[target] : undefined;
    scenario = (
      <>
        <p>Найден путь, нарушающий «{property?.name ?? violated.property_id}»:</p>
        <ol className="scenario">
          {steps.slice(1, (target ?? steps.length - 1) + 1).map((s) => <li key={s.number}>{s.transition?.name ?? s.transitionId}</li>)}
        </ol>
        {steps.length === 1 && <p>Нарушение уже в начальном состоянии.</p>}
        {end?.transition && facts.map((f) => (
          <p key={f.variable} className="callout">
            «{end.transition!.name}» разрешён условием <Expr value={end.transition!.guard} />, а <code>{f.variable}</code> = <Val value={f.value} />
            {f.keptBy.length > 0 ? <> остаётся после «{f.keptBy.map((s) => s.transition?.name ?? s.transitionId).join("», «")}»</> : null}.
          </p>
        ))}
      </>
    );
  }

  return (
    <AgentBlock icon="check" label="Проверка" time={clock(check.startedAt)}>
      <p className="msg__lead">
        Проверка {modelName ? `«${modelName}» · ` : ""}{version ? `версии ${version.number}` : ""}
        {!running && results.length > 0 && <span className={`chip chip--${summary.tone} chip--inline`}>{summary.label}</span>}
      </p>
      {running && (
        <p className="quiet" role="status">
          <span className="spinner" aria-hidden="true" />
          {check.run ? RUN_STATE[check.run.state] : "Загрузка"}
          {check.run && (check.run.state === "queued" || check.run.state === "running") && (
            <button type="button" className="button button--small button--ghost" onClick={onCancel} disabled={check.cancelRequested}>
              <Stop size={13} /> Остановить
            </button>
          )}
        </p>
      )}
      {check.failure && <p className="small">{check.failure.code === "CANCELLED" ? "Остановлено, результата нет." : `Не выполнена: ${check.failure.code}`}</p>}
      {scenario}
      {!violated && results.length > 0 && (
        <ul className="mini-results">
          {results.map((r) => (
            <li key={r.property_id}>
              <span>{version?.spec.properties.find((p) => p.id === r.property_id)?.name ?? r.property_id}</span>
              <StatusBadge status={r.status} size="sm" />
            </li>
          ))}
        </ul>
      )}
      {results.length > 0 && (
        <div className="msg__links">
          <button type="button" className="text-link" onClick={() => show((violated ?? results[0]!).property_id)}>
            {violated ? "Показать сценарий" : "Открыть результаты"}
          </button>
        </div>
      )}
    </AgentBlock>
  );
}

export function requirementIndexFor(version: ModelVersion | null) {
  return version ? indexRequirements(version.spec.requirements, version.spec.sources) : null;
}
