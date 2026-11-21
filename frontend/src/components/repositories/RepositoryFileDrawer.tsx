import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import type { RepositoryApi, RepositoryProvenance } from "../../api/repositories";
import type { SourceRef } from "../../api/types";
import { ErrorNotice, QuietStatus } from "../Notice";
import { RepositoryDialog } from "./RepositoryDialog";
import { useRepositoryLoad } from "./useRepositoryLoad";

export type RepositoryFileTarget = Omit<RepositoryProvenance, "kind" | "start_line" | "end_line"> & {
  start_line?: number;
  end_line?: number;
  total_lines?: number;
};

const PAGE_LINES = 160;

function FileLines({ api, sessionId, target }: { api: RepositoryApi; sessionId: string; target: RepositoryFileTarget }) {
  const { start_line: first, end_line: last } = target;
  const [range, setRange] = useState(() => ({
    start: Math.max(1, (first ?? 1) - 15),
    end: Math.min(target.total_lines ?? Infinity, last === undefined ? PAGE_LINES : last + 15),
  }));
  const highlighted = useRef<HTMLLIElement>(null);
  const file = useRepositoryLoad(useCallback(async signal => {
    const content = await api.content(sessionId, target.snapshot_id, target.path, range.start, range.end || undefined, signal);
    if (content.commit_sha !== target.commit_sha || content.path !== target.path || content.sha256 !== target.sha256) {
      throw new ApiError("malformed", "Файл отличается от выбранного снимка");
    }
    return content;
  }, [api, range, sessionId, target]));
  useEffect(() => { highlighted.current?.scrollIntoView?.({ block: "nearest" }); }, [file.data]);

  const data = file.data;
  return <>
    <p className="repository-file-path"><code>{target.path}</code></p>
    <p className="muted small">Commit <code>{target.commit_sha}</code>{first !== undefined && <> · строки {first}–{last}</>}</p>
    {file.loading && <QuietStatus busy>Загрузка файла</QuietStatus>}
    {file.error !== null && <ErrorNotice title="Файл не загружен" error={file.error}
      action={<button type="button" className="button button--small" onClick={file.reload}>Повторить</button>} />}
    {data && data.lines.length === 0 && <p className="muted">Файл пуст</p>}
    {data && data.lines.length > 0 && <>
      <div className="repository-actions">
        <button type="button" className="button button--small" disabled={data.start_line === 1} onClick={() =>
          setRange({ start: Math.max(1, data.start_line - PAGE_LINES), end: data.start_line - 1 })}>Предыдущие строки</button>
        <button type="button" className="button button--small" disabled={data.start_line + data.lines.length > data.total_lines} onClick={() => {
          const start = data.start_line + data.lines.length;
          setRange({ start, end: Math.min(data.total_lines, start + PAGE_LINES - 1) });
        }}>Следующие строки</button>
        <span className="small muted">{data.start_line}–{data.start_line + data.lines.length - 1} из {data.total_lines}</span>
      </div>
      <ol className="repository-lines" aria-label="Исходный код" start={data.start_line}>
        {data.lines.map((text, index) => {
          const number = data.start_line + index;
          const quote = first !== undefined && last !== undefined && number >= first && number <= last;
          return <li key={number} ref={number === first ? highlighted : undefined} className={quote ? "is-quoted" : undefined}>
            <span className="repository-lines__number">{number}</span>
            {quote ? <mark>{text}</mark> : <code>{text}</code>}
          </li>;
        })}
      </ol>
    </>}
  </>;
}

function CitationFile({ api, sessionId, sourceRef }: { api: RepositoryApi; sessionId: string; sourceRef: SourceRef }) {
  const quote = useRepositoryLoad(useCallback(async signal => {
    const location = await api.provenance(sessionId, sourceRef, signal);
    if (!location) throw new ApiError("http", "Для цитаты нет диапазона в снимке.");
    const snapshot = await api.get(sessionId, location.snapshot_id, signal);
    const file = snapshot.files.find(file => file.path === location.path);
    if (snapshot.commit_sha !== location.commit_sha || !file || file.sha256 !== location.sha256 || location.end_line > file.lines) {
      throw new ApiError("malformed", "Цитата отличается от индекса снимка");
    }
    return { ...location, total_lines: file.lines };
  }, [api, sessionId, sourceRef]));
  if (quote.loading) return <QuietStatus busy>Поиск цитаты в снимке</QuietStatus>;
  if (quote.data) return <FileLines api={api} sessionId={sessionId} target={quote.data} />;
  return <ErrorNotice title="Цитата не открылась" error={quote.error}
    action={<button type="button" className="button button--small" onClick={quote.reload}>Повторить</button>} />;
}

export function RepositoryFileDrawer({ api, sessionId, target, onClose }: {
  api: RepositoryApi;
  sessionId: string;
  target: { citation: SourceRef } | RepositoryFileTarget;
  onClose(): void;
}) {
  return <RepositoryDialog title="Исходный файл" variant="drawer" onClose={onClose}>
    {"citation" in target ? <CitationFile api={api} sessionId={sessionId} sourceRef={target.citation} />
      : <FileLines api={api} sessionId={sessionId} target={target} />}
  </RepositoryDialog>;
}
