import { useCallback, useEffect, useRef, useState } from "react";
import { newKey, type ApiCapabilities } from "../../api/api";
import { describeCode } from "../../api/errors";
import type { GitConnectionsApi, RepositoryApi, RepositoryFile, RepositoryImport as ImportBody, RepositoryPlan, RepositoryRange, RepositorySelection, RepositorySnapshot } from "../../api/repositories";
import type { Run } from "../../api/types";
import { ErrorNotice, QuietStatus } from "../Notice";
import { RepositoryDialog } from "./RepositoryDialog";
import { RepositoryFileDrawer, type RepositoryFileTarget } from "./RepositoryFileDrawer";
import { RepositoryImport } from "./RepositoryImport";
import { RepositoryTree } from "./RepositoryTree";
import { useRepositoryLoad } from "./useRepositoryLoad";

const EXCLUDED: Record<string, string> = {
  sensitive_or_service_path: "Служебные и чувствительные пути",
  unsupported_type: "Неподдерживаемый тип",
  binary_or_non_utf8: "Двоичные файлы или другая кодировка",
  link_or_special: "Ссылки и специальные файлы",
  secret_pattern: "Обнаружены признаки секретов",
  lfs_pointer: "Указатели Git LFS",
};

const countLines = (ranges: RepositoryRange[]) => ranges.reduce((sum, range) => sum + Math.max(0, range.end_line - range.start_line + 1), 0);
const number = (n: number) => n.toLocaleString("ru-RU");

interface AnalysisProps {
  api: RepositoryApi;
  capabilities: ApiCapabilities;
  sessionId: string;
  blocked: string | null;
  runs: Map<string, Run>;
  onRun(run: Run, label: string): void;
}

function SnapshotDetails({ snapshot, api, capabilities, sessionId, blocked, runs, onRun, onRefresh, onClose, onBusy }: AnalysisProps & {
  snapshot: RepositorySnapshot;
  onRefresh(): void;
  onClose(): void;
  onBusy(busy: boolean): void;
}) {
  const latest = useRepositoryLoad(useCallback(signal => capabilities.repositoryContent
    ? api.latestContext(sessionId, snapshot.id, signal)
    : Promise.resolve(null), [api, capabilities.repositoryContent, sessionId, snapshot.id]));
  const [draft, setDraft] = useState<RepositoryRange[] | null>(null);
  const [file, setFile] = useState<RepositoryFileTarget | null>(null);
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState<RepositoryPlan | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"plan" | "send" | null>(null);
  const [error, setError] = useState<{ error: unknown; mode: "plan" | "analysis" } | null>(null);
  const attempt = useRef<{ payload: RepositorySelection; intent: string; key: string } | null>(null);
  const ranges = draft ?? latest.data?.ranges ?? [];
  const invalid = ranges.some(range => !Number.isInteger(range.start_line) || !Number.isInteger(range.end_line)
    || range.start_line < 1 || range.end_line < range.start_line
    || range.end_line > (snapshot.files.find(item => item.path === range.path)?.lines ?? 0));
  const run = runId ? runs.get(runId) : undefined;
  const runOngoing = Boolean(runId && (!run || run.state === "queued" || run.state === "running" || run.state === "cancelling"));
  const submissionsBlocked = Boolean(blocked || busy || runOngoing);
  const lines = snapshot.files.reduce((total, file) => total + file.lines, 0);

  async function selectAutomatically() {
    if (busy || runOngoing || !snapshot.files.length) return;
    setError(null);
    setBusy("plan");
    onBusy(true);
    try {
      const proposed = await api.plan(sessionId, snapshot.id, { query: query.trim() });
      setPlan(proposed);
      setDraft(proposed.selection.files);
      setQuery(proposed.selection.query ?? query);
    } catch (failure) {
      setError({ error: failure, mode: "plan" });
    } finally {
      setBusy(null);
      onBusy(false);
    }
  }

  async function analyze() {
    if (submissionsBlocked || !ranges.length || invalid) return;
    const focus = query.trim();
    const payload: RepositorySelection = {
      manifest_sha256: snapshot.manifest_sha256, files: ranges, ...(focus ? { query: focus } : {}),
    };
    const intent = JSON.stringify(payload);
    setError(null);
    setBusy("send");
    onBusy(true);
    try {
      if (attempt.current?.intent !== intent) {
        attempt.current = { intent, payload, key: newKey() };
      }
      const accepted = await api.analyze(sessionId, snapshot.id, attempt.current.payload, attempt.current.key);
      const label = `Репозиторий ${snapshot.remote_url} · ${snapshot.commit_sha.slice(0, 12)}`;
      onRun(accepted, label);
      setRunId(accepted.run_id);
      latest.reload();
      attempt.current = null;
    } catch (failure) {
      setError({ error: failure, mode: "analysis" });
    } finally {
      setBusy(null);
      onBusy(false);
    }
  }

  function selectFile(item: RepositoryFile) {
    setPlan(null);
    setDraft(ranges.some(range => range.path === item.path)
      ? ranges.filter(range => range.path !== item.path)
      : [...ranges, { path: item.path, sha256: item.sha256, start_line: 1, end_line: item.lines }]);
  }

  return <>
    <div className="repository-snapshot__meta">
      <strong>{snapshot.remote_url}</strong>
      <code>{snapshot.commit_sha}</code>
      <button type="button" className="button button--small" disabled={!!busy} onClick={onRefresh}>Обновить репозиторий</button>
    </div>
    <div className="repository-snapshot__columns">
      <section aria-label="Файлы снимка">
        <h3>Файлы · {number(snapshot.files.length)}</h3>
        <RepositoryTree files={snapshot.files} ranges={ranges} onToggle={selectFile}
          onOpen={capabilities.repositoryContent ? item => setFile({
            snapshot_id: snapshot.id, commit_sha: snapshot.commit_sha, path: item.path, sha256: item.sha256, total_lines: item.lines,
          }) : undefined} />
        {Object.keys(snapshot.excluded).length > 0 && <details className="repository-exclusions">
          <summary>Исключено · {number(Object.values(snapshot.excluded).reduce((sum, value) => sum + value, 0))}</summary>
          <ul>{Object.entries(snapshot.excluded).map(([reason, count]) => <li key={reason}>{EXCLUDED[reason] ?? reason} · {number(count)}</li>)}</ul>
        </details>}
      </section>
      <section aria-label="Контекст анализа" className="repository-context">
        <h3>Контекст анализа</h3>
        {capabilities.repositoryPlan && <div className="repository-form">
          <label>Область анализа<input className="input" value={query} maxLength={500} placeholder="Весь проект" disabled={!!busy} onChange={event => setQuery(event.target.value)} /></label>
          <button type="button" className="button" disabled={!!busy || runOngoing || !snapshot.files.length} onClick={() => void selectAutomatically()}>
            {query.trim() ? "Подобрать файлы по запросу" : "Подобрать файлы по всему проекту"}
          </button>
        </div>}
        <div className="repository-ranges">
          {ranges.length > 0 && <p className="muted small">
            {number(ranges.length)} из {number(plan?.indexed_file_count ?? snapshot.files.length)} файлов · {number(plan?.selected_line_count ?? countLines(ranges))} из {number(lines)} строк
          </p>}
          {latest.data && <p className="muted small">Сохранённый контекст · {number(latest.data.size_bytes)} Б</p>}
          {latest.error !== null && <ErrorNotice title="Контекст не загружен" error={latest.error}
            action={<button type="button" className="button button--small" onClick={latest.reload}>Повторить</button>} />}
          {ranges.map(range => <div className="repository-range" key={range.path}>
            <code>{range.path}</code>
            {(["start_line", "end_line"] as const).map((side, index) => <label key={side} className="small">{index === 0 ? "С" : "По"}
              <input type="number" className="input" aria-label={`${index === 0 ? "Начало" : "Конец"} диапазона ${range.path}`}
                min={1} max={snapshot.files.find(item => item.path === range.path)?.lines} value={range[side] || ""} disabled={!!busy}
                onChange={event => {
                  setPlan(null);
                  setDraft(ranges.map(item => item.path === range.path ? { ...item, [side]: Number(event.target.value) } : item));
                }} />
            </label>)}
          </div>)}
        </div>
        {invalid && <p className="small warn-text">Диапазон должен находиться в пределах файла.</p>}
        <button type="button" className="button button--primary" disabled={submissionsBlocked || !ranges.length || invalid} onClick={() => void analyze()}>
          Анализировать выбранные файлы
        </button>
        {busy && <QuietStatus busy>{busy === "plan" ? "Отбор файлов" : "Запуск анализа"}</QuietStatus>}
        {!busy && runOngoing && <QuietStatus busy>Идёт анализ снимка</QuietStatus>}
        {run && (run.state === "failed" || run.state === "cancelled") && <ErrorNotice title="Анализ снимка не завершён"
          detail={describeCode(run.error_code) ?? run.error_code ?? undefined}
          action={blocked ? <button type="button" className="button button--small" onClick={onClose}>К чату</button> : undefined} />}
        {error && <ErrorNotice title={error.mode === "plan" ? "Файлы не подобраны" : "Анализ не запущен"} error={error.error}
          action={<button type="button" className="button button--small" disabled={busy !== null || runOngoing || (error.mode === "analysis" && Boolean(blocked))}
            onClick={() => void (error.mode === "plan" ? selectAutomatically() : analyze())}>Повторить</button>} />}
        {!runOngoing && !busy && blocked && <p className="muted small">{blocked}</p>}
      </section>
    </div>
    {file && <RepositoryFileDrawer api={api} sessionId={sessionId} target={file} onClose={() => setFile(null)} />}
  </>;
}

function Snapshot({ snapshotId, ...props }: AnalysisProps & {
  snapshotId: string;
  onRefresh(snapshot: RepositorySnapshot): void;
  onClose(): void;
  onBusy(busy: boolean): void;
}) {
  const { api, sessionId, onRefresh } = props;
  const snapshot = useRepositoryLoad(useCallback(signal => api.get(sessionId, snapshotId, signal), [api, sessionId, snapshotId]));
  if (snapshot.loading) return <QuietStatus busy>Загрузка снимка</QuietStatus>;
  if (snapshot.data) return <SnapshotDetails snapshot={snapshot.data} {...props} onRefresh={() => onRefresh(snapshot.data!)} />;
  return <ErrorNotice title="Снимок не загружен" error={snapshot.error}
    action={<button type="button" className="button button--small" onClick={snapshot.reload}>Повторить</button>} />;
}

export function RepositorySnapshots({ snapshotId, onSelect, connections, onClose, ...props }: AnalysisProps & {
  snapshotId?: string;
  connections?: GitConnectionsApi;
  onSelect(snapshotId: string): void;
  onClose(): void;
}) {
  const { api, sessionId } = props;
  const list = useRepositoryLoad(useCallback(signal => api.list(sessionId, signal), [api, sessionId]));
  const [form, setForm] = useState<"import" | RepositorySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<RepositorySnapshot | null>(null);
  const snapshots = [...(list.data ?? []), ...(added && !list.data?.some(snapshot => snapshot.id === added.id) ? [added] : [])];
  const selected = snapshotId ?? snapshots.at(-1)?.id;
  const refreshing = form !== null && form !== "import" ? form : null;
  useEffect(() => {
    if (!snapshotId && selected) onSelect(selected);
  }, [onSelect, selected, snapshotId]);

  async function submit(body: ImportBody, key: string) {
    const { remote_url, ...refreshBody } = body;
    const imported = refreshing ? await api.refresh(sessionId, refreshing.id, refreshBody, key) : await api.import(sessionId, body, key);
    setAdded(imported);
    onSelect(imported.id);
    setForm(null);
    list.reload();
  }

  return <RepositoryDialog variant={form ? undefined : "snapshots"} busy={busy}
    title={refreshing ? "Обновить репозиторий" : form ? "Подключить репозиторий" : "Репозитории"} onClose={form ? () => setForm(null) : onClose}>
    {form ? <RepositoryImport connections={connections} refreshUrl={refreshing?.remote_url} submit={submit} onBusy={setBusy} /> : <>
      <div className="repository-actions">
        <button type="button" className="button" disabled={busy} onClick={() => setForm("import")}>Подключить репозиторий</button>
        {snapshots.length > 0 && <label>Снимок <select className="input" disabled={busy} value={selected} onChange={event => onSelect(event.target.value)}>
          {!snapshots.some(item => item.id === selected) && <option value={selected}>{selected}</option>}
          {[...snapshots].reverse().map(snapshot => <option key={snapshot.id} value={snapshot.id}>
            {snapshot.remote_url.split("/").at(-1)} · {snapshot.commit_sha.slice(0, 12)} · {new Date(snapshot.created_at).toLocaleString("ru-RU")}
          </option>)}
        </select></label>}
      </div>
      {list.loading && <QuietStatus busy>Загрузка списка снимков</QuietStatus>}
      {list.error !== null && <ErrorNotice title="Список снимков не загружен" error={list.error}
        action={<button type="button" className="button button--small" onClick={list.reload}>Повторить</button>} />}
      {selected ? <Snapshot key={selected} snapshotId={selected} {...props} onRefresh={setForm} onClose={onClose} onBusy={setBusy} />
        : list.data && <p className="muted">В этом чате пока нет снимков.</p>}
    </>}
  </RepositoryDialog>;
}
