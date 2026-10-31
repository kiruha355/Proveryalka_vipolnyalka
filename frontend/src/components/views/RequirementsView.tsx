import { useCore } from "../../app/core";
import type { WorkspaceViewProps } from "../../app/extensions";
import type { DialogueState, ExtractedRequirement, Question, Source } from "../../api/types";
import { highlightSpans, indexRequirements, refMatches } from "../../domain/requirements";
import { describeError } from "../../api/errors";

export function sourceLabel(source: Source, index: number, documents: { id: string; filename: string }[]): string {
  const document = documents.find((d) => d.id === source.id);
  if (document) return `Документ ${document.filename}`;
  if (source.id.startsWith("answer_")) return "Ответ на уточнение";
  return index === 0 ? "Описание пользователя" : "Сообщение пользователя";
}

const QUESTION_STATUS: Record<Question["status"], string> = {
  open: "ждёт ответа", answered: "отвечен", confirmed: "подтверждено", rejected: "отклонено",
};

export function QuestionStatusTag({ status }: { status: Question["status"] }) {
  return <span className={`tag tag--q-${status}`}>{QUESTION_STATUS[status]}</span>;
}

function SourceText({ source, label, requirements, onPick, active }: {
  source: Source; label: string; requirements: ExtractedRequirement[]; onPick(id: string): void; active: string | null;
}) {
  const spans = highlightSpans(source, requirements);
  const index = indexRequirements(requirements, []);
  return (
    <figure className="source">
      <figcaption className="source__label">{label}</figcaption>
      <p className="source__text">
        {spans.map((span) => {
          const text = source.text.slice(span.start, span.end);
          if (span.requirementIds.length === 0) return <span key={span.start}>{text}</span>;
          const first = span.requirementIds[0]!;
          const labels = span.requirementIds.map((id) => index.label(id)).join(", ");
          return (
            <mark key={span.start} className={span.requirementIds.includes(active ?? "") ? "is-active" : undefined}
              role="button" tabIndex={0} aria-label={`${labels}: ${text}`} title={labels}
              onClick={() => onPick(first)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(first); } }}>
              {text}
            </mark>
          );
        })}
      </p>
    </figure>
  );
}

export function RequirementsView({ context }: WorkspaceViewProps) {
  const core = useCore();
  const dialogue: DialogueState | null = core.history?.dialogue ?? null;
  const version = context.version;
  const documents = core.workspace.upload.documents;
  const fromVersion = version !== null;
  const requirements = version?.spec.requirements ?? dialogue?.analysis.requirements ?? [];
  const sources = version?.spec.sources ?? dialogue?.sources ?? core.workspace.detail.data?.sources ?? [];
  const index = context.requirements ?? indexRequirements(requirements, sources);
  const active = context.selection.element?.kind === "requirement" ? context.selection.element.id : null;
  const pick = (id: string) => context.select({ kind: "requirement", id });
  const answerText = (id: string | null) => (id ? dialogue?.sources.find((s) => s.id === id)?.text ?? null : null);
  const corrected = new Map((dialogue?.corrections ?? []).map((c) => [c.requirement_id, c]));

  return (
    <div className="view requirements-view">
      {(documents.length > 0 || core.workspace.upload.error !== null) && (
        <section className="model-section" aria-label="Документы">
          <h3>Документы</h3>
          {core.workspace.upload.error !== null && <p className="warn-text" role="alert">{describeError(core.workspace.upload.error)}</p>}
          <ul className="documents">
            {documents.map((d) => (
              <li key={d.id} className={`document document--${d.status}`}>
                <strong>{d.filename}</strong>
                <span className="muted small">{d.media_type} · {d.size.toLocaleString("ru-RU")} Б</span>
                {d.status === "failed"
                  ? <span className="warn-text">Текст не извлечён: {d.error?.message ?? d.error?.code ?? "причина не указана"}. Требования из этого файла не построены.</span>
                  : <span className="muted small">Текст извлечён: {(d.text ?? "").length.toLocaleString("ru-RU")} символов</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="model-section" aria-labelledby="sources-title">
        <h3 id="sources-title">Исходный текст</h3>
        {sources.length === 0 ? <p className="muted">Источников пока нет.</p> : sources.map((source, i) => (
          <SourceText key={source.id} source={source} label={sourceLabel(source, i, documents)} requirements={requirements} onPick={pick} active={active} />
        ))}
      </section>

      <section className="model-section" aria-labelledby="reqs-title">
        <h3 id="reqs-title">{fromVersion ? `Требования версии ${version!.number}` : "Требования из разбора агента"}</h3>
        {requirements.length === 0 ? <p className="muted">Агент ещё не выделил требований.</p> : (
          <ol className="requirements">
            {requirements.map((r) => (
              <li key={r.id} className={`requirement${active === r.id ? " is-selected" : ""}`} id={`req-${r.id}`}>
                <button type="button" className="requirement__label" onClick={() => pick(r.id)} aria-label={`${index.label(r.id)}: показать в инспекторе`}>
                  {index.label(r.id)}
                </button>
                <div className="requirement__body">
                  <p>{r.text}</p>
                  {corrected.has(r.id) && (
                    <p className="small warn-text">Изменено после ответа: «{corrected.get(r.id)!.quote}»</p>
                  )}
                  <ul className="quotes">
                    {r.source_refs.map((ref) => {
                      const source = sources.find((s) => s.id === ref.source_id);
                      const ok = source ? refMatches(source, ref) : false;
                      return (
                        <li key={`${ref.source_id}:${ref.start}`}>
                          <q>{ref.quote}</q>
                          {!ok && <span className="warn-text small"> цитата не совпадает с источником</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {dialogue && dialogue.analysis.assumptions.length > 0 && (
        <section className="model-section" aria-labelledby="assumptions-title">
          <h3 id="assumptions-title">Предположения агента</h3>
          <ul className="assumptions">
            {dialogue.analysis.assumptions.map((a) => (
              <li key={a.text}>
                <p>{a.text}</p>
                <p className="small muted">Основание: <q>{a.quote}</q>. {a.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialogue && dialogue.analysis.contradictions.length > 0 && (
        <section className="model-section" aria-labelledby="conflicts-title">
          <h3 id="conflicts-title">Противоречия</h3>
          <ul className="assumptions">
            {dialogue.analysis.contradictions.map((c) => (
              <li key={c.description}>
                <p>{c.description}</p>
                <p className="small muted">{c.quotes.map((q, i) => <q key={i}>{q}</q>)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialogue && dialogue.questions.length > 0 && (
        <section className="model-section" aria-labelledby="questions-title">
          <h3 id="questions-title">Уточнения · раунд {dialogue.round} из {dialogue.max_rounds}</h3>
          <ul className="question-list">
            {dialogue.questions.map((q) => (
              <li key={q.id}>
                <div className="question-list__head">
                  <QuestionStatusTag status={q.status} />
                  <span>{q.text}</span>
                </div>
                {q.assumption && <p className="small muted">Предположение: {q.assumption}</p>}
                {answerText(q.answer_source_id) && <p className="small">Ответ: <q>{answerText(q.answer_source_id)}</q></p>}
                {q.status === "open" && context.capabilities.agent && (
                  <button type="button" className="button button--small button--ghost" onClick={() => core.replyTo(q.id)}>Ответить</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
