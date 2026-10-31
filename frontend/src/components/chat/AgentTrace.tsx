import type { ReactNode } from "react";
import { describeCode } from "../../api/errors";
import { isTerminal, type Run, type RunEvent } from "../../api/types";
import { RUN_STATE } from "../../domain/status";
import { mergeEvents, type StreamStatus } from "../../state/runTracker";
import { Chevron } from "../icons";

export interface AgentTraceData {
  runId: string;
  run: Run | null;
  events: RunEvent[];
  /** All times below come from persisted server data, never the client clock. */
  createdAt?: string | null;
  finishedAt?: string | null;
  cancelRequested?: boolean;
  stream?: StreamStatus;
  eventsTruncated?: boolean;
}

interface Step {
  key: string;
  label: string;
  at?: string | null;
  detail?: string;
  failed?: boolean;
}

const text = (data: Record<string, unknown>, key: string) => typeof data[key] === "string" ? data[key] as string : undefined;

const PHASES: Record<string, {label: string; current: string}> = {
  queued: {label: "Запрос принят", current: "В очереди"},
  started: {label: "Выполнение начато", current: "Запрос выполняется"},
  context_ready: {label: "Контекст подготовлен", current: "Контекст подготовлен"},
  model_request: {label: "Отправлен запрос к модели", current: "Модель готовит ответ"},
  model_response: {label: "Получен ответ модели", current: "Ответ модели получен"},
  validation: {label: "Проверка ответа модели", current: "Проверяется ответ модели"},
  retry: {label: "Повтор запроса к модели", current: "Повтор запроса к модели"},
  saving: {label: "Сохранение результата", current: "Сохраняется результат"},
  file_context_ready: {label: "Контекст файла подготовлен", current: "Контекст файла подготовлен"},
  answer_ready: {label: "Ответ подготовлен", current: "Ответ подготовлен"},
};

function eventStep(event: RunEvent): Step | null {
  const data = event.data;
  const step = {key: `${event.run_id}:${event.event_id}`, at: event.created_at};
  switch (event.type) {
    case "activity": {
      const phase = text(data, "phase");
      const label = phase ? PHASES[phase]?.label : null;
      if (!label) return null;
      const attempt = typeof data.attempt === "number" && data.attempt > 1 ? `Попытка ${data.attempt}` : undefined;
      const outcomeLabel = phase === "validation" ? data.outcome === "passed" ? "Структура ответа проверена"
        : data.outcome === "failed" ? "Ответ требует исправления" : label : label;
      return {...step, label: outcomeLabel, detail: attempt ?? (phase === "file_context_ready" ? text(data, "path") : undefined)};
    }
    case "message_delta": return {...step, label: "Получен текст ответа"};
    case "tool_call": return {...step, label: "Вызван инструмент"};
    case "clarification_requested": return {...step, label: "Запрошено уточнение"};
    case "model_proposed": {
      const verb = data.changed === false ? "Использована" : "Предложена";
      return {...step, label: typeof data.number === "number" ? `${verb} версия модели ${data.number}` : `${verb} версия модели`};
    }
    case "dialogue_updated": return {...step, label: "Диалог сохранён"};
    case "check_started": return {...step, label: "Начата проверка модели"};
    case "check_finished": return {...step, label: "Получен отчёт проверки"};
    case "file_written": return {...step, label: "Создан файл", detail: text(data, "path")};
    case "explanation_queued": return {...step, label: "Объяснение поставлено в очередь"};
    case "explanation_started": return {...step, label: "Начато объяснение отчёта"};
    case "explanation_ready": return {...step, label: "Объяснение сохранено"};
    case "error": {
      const code = text(data, "code");
      return {...step, label: "Ошибка выполнения", detail: code ? describeCode(code) ?? code : undefined, failed: true};
    }
    case "run_finished": {
      const state = text(data, "state");
      return {...step, label: state && state in RUN_STATE ? RUN_STATE[state as Run["state"]] : "Запуск завершён", failed: state === "failed"};
    }
    default: return null;
  }
}

function timestamp(value?: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function duration(start?: string | null, end?: string | null): string | null {
  const a = timestamp(start), b = timestamp(end);
  if (a === null || b === null || b < a) return null;
  const seconds = (b - a) / 1000;
  if (seconds < 60) return `${new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 1}).format(seconds)} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${Math.floor(seconds % 60)} с`;
}

function eventTime(value?: string | null): string | null {
  const time = timestamp(value);
  return time === null ? null : new Date(time).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
}

/** Public operation events only. The trace never renders raw SDK messages or reasoning. */
export function AgentTrace({trace, action}: {trace: AgentTraceData; action?: ReactNode}) {
  const events = mergeEvents([], trace.events).sort((a, b) => a.event_id - b.event_id);
  const steps = events.map(eventStep).filter((step): step is Step => step !== null);
  const state = trace.run?.state;
  const terminal = state !== undefined && isTerminal(state);
  const lastFinished = [...events].reverse().find(event => event.type === "run_finished");
  const errorCode = state === "failed" && !events.some(event => event.type === "error") ? trace.run?.error_code : null;
  const elapsed = terminal ? duration(trace.createdAt ?? events[0]?.created_at, trace.finishedAt ?? lastFinished?.created_at) : null;
  let status = state ? RUN_STATE[state] : "Состояние уточняется";
  const phaseEvent = [...events].reverse().find(event => event.type === "activity");
  const phase = phaseEvent ? text(phaseEvent.data, "phase") : undefined;
  if (!terminal && state === "running" && phase && PHASES[phase]) status = PHASES[phase]!.current;
  if (!terminal && state === "running" && phase === "validation") {
    if (phaseEvent?.data.outcome === "passed") status = "Структура ответа проверена";
    if (phaseEvent?.data.outcome === "failed") status = "Ответ требует исправления";
  }
  if (!terminal && events.at(-1)?.type === "error") status = "Ошибка выполнения";
  if (!terminal && trace.cancelRequested) status = "Останавливается";
  else if (!terminal && trace.stream?.kind === "lost") status = "Нет связи";
  else if (!terminal && trace.stream?.kind === "reconnecting") status = `Переподключение ${trace.stream.attempt}/${trace.stream.maxAttempts}`;

  return <div className="agent-trace-row">
    <details className="agent-trace" data-run-id={trace.runId}>
      <summary className="agent-trace__summary">
        <Chevron size={13}/>
        <span>Ход работы</span>
        <span className="agent-trace__status" role={terminal ? undefined : "status"} aria-live={terminal ? undefined : "polite"}>{status}</span>
        {elapsed && <span className="agent-trace__duration">{elapsed}</span>}
      </summary>
      <ol className="agent-trace__steps" aria-label="События запуска агента">
        {steps.map(step => <li key={step.key} className={step.failed ? "agent-trace__step agent-trace__step--failed" : "agent-trace__step"}>
          <span className="agent-trace__mark" aria-hidden="true"/>
          <span className="agent-trace__label">{step.label}{step.detail && <span className="agent-trace__detail">{step.detail}</span>}</span>
          {eventTime(step.at) && <time dateTime={step.at!}>{eventTime(step.at)}</time>}
        </li>)}
      </ol>
      {errorCode && <p className="agent-trace__missing">{describeCode(errorCode) ?? errorCode}</p>}
      {!phaseEvent && terminal && <p className="agent-trace__missing">Данные этапов не сохранены.</p>}
      {trace.eventsTruncated && <p className="agent-trace__missing">Показана часть сохранённых событий.</p>}
    </details>
    {action && <div className="agent-trace__action">{action}</div>}
  </div>;
}
