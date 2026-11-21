import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/http";
import type { CandidateComparison, ComparisonRequest, Generation, RepositorySnapshot, TestRun } from "../contract";
import { isTerminalTestRun } from "../contract";
import { codegenErrorMessage, newActionKey, type CodegenProvider, type ComparisonProvider } from "../provider";
import { useRunPolling } from "../useRunPolling";

export function RepositoryComparison(props: {
  provider: CodegenProvider;
  comparisons: ComparisonProvider;
  generation: Generation;
  disabledReason: string | null;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="pv-comparison" onToggle={(event) => {
      if (event.currentTarget.open) setOpened(true);
    }}>
      <summary>Сравнить с репозиторием</summary>
      {opened && <ComparisonWorkspace {...props} />}
    </details>
  );
}

const verdicts: Record<CandidateComparison["status"], string> = {
  pending: "Ожидает сравнения",
  matches: "Совпадает на проверенных сценариях",
  mismatch: "Есть расхождения с моделью",
  incompatible_adapter: "Несовместимый адаптер",
  execution_error: "Ошибка выполнения сравнения",
};

function ComparisonWorkspace({ provider, comparisons, generation, disabledReason }: {
  provider: CodegenProvider;
  comparisons: ComparisonProvider;
  generation: Generation;
  disabledReason: string | null;
}) {
  const [snapshots, setSnapshots] = useState<RepositorySnapshot[] | null>(null);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [runId, setRunId] = useState("");
  const [module, setModule] = useState("");
  const [prefix, setPrefix] = useState(
    typeof generation.technical_conditions.api_prefix === "string"
      ? generation.technical_conditions.api_prefix : "",
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setSnapshotsError(null);
    setLoadError(null);
    comparisons.listSnapshots(generation.session_id, signal).then((list) => {
      if (!signal.aborted) setSnapshots(list);
    }).catch((cause) => {
      if (!signal.aborted) setSnapshotsError(codegenErrorMessage(cause));
    });
    comparisons.list(generation.generation_id, signal).then((list) => {
      if (signal.aborted) return;
      setRuns((old) => [
        ...list.map((item) => old.find((known) => known.test_run_id === item.test_run_id) ?? item),
        ...old.filter((known) => !list.some((item) => item.test_run_id === known.test_run_id)),
      ]);
    }).catch((cause) => {
      if (!signal.aborted) setLoadError(codegenErrorMessage(cause));
    });
    return () => controller.abort();
  }, [comparisons, generation.session_id, generation.generation_id, attempt]);
  const snapshot = snapshots?.find((item) => item.id === snapshotId) ?? snapshots?.[0];
  const run = runs.find((item) => item.test_run_id === runId) ?? runs.at(-1) ?? null;
  const mergeRun = useCallback((next: TestRun) => {
    setRuns((old) => old.some((item) => item.test_run_id === next.test_run_id)
      ? old.map((item) => item.test_run_id === next.test_run_id ? next : item)
      : [...old, next]);
  }, []);
  const pollError = useRunPolling(provider, run, mergeRun, busy);
  const invalidAdapter = !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(module.trim())
    || !/^(?:\/[A-Za-z0-9_-]+)*$/.test(prefix);
  const start = async () => {
    if (!snapshot || invalidAdapter || disabledReason || busy) return;
    const request: ComparisonRequest = {
      snapshot_id: snapshot.id,
      manifest_sha256: snapshot.manifest_sha256,
      reference_code_hash: generation.code_hash,
      adapter: { kind: "fastapi-evaluate-v1", module: module.trim(), api_prefix: prefix },
    };
    const body = JSON.stringify(request);
    if (retry.current?.body !== body) retry.current = { body, key: newActionKey("compare") };
    const signal = lifetime.current?.signal;
    setBusy(true);
    setError(null);
    try {
      const next = await comparisons.start(generation.generation_id, request, retry.current.key);
      if (signal?.aborted) return;
      mergeRun(next);
      setRunId(next.test_run_id);
      retry.current = null;
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof ApiError) retry.current = null;
      setError(codegenErrorMessage(cause));
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };

  return (
    <div className="pv-comparison__body">
      <form className="pv-comparison__form" onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}>
        {snapshotsError ? <p role="alert">Снимки репозитория. {snapshotsError}</p>
          : snapshots === null ? <p role="status">Загрузка снимков…</p>
          : snapshots.length === 0 ? <p>В сессии нет снимков репозитория.</p>
          : (
            <label>
              Снимок репозитория
              <select value={snapshot?.id} disabled={busy} onChange={(event) => setSnapshotId(event.target.value)}>
                {snapshots.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.remote_url} · {item.commit_sha.slice(0, 12)} · {item.id}
                  </option>
                ))}
              </select>
            </label>
          )}
        {snapshots && snapshots.length > 0 && !snapshotsError && (
          <fieldset disabled={busy}>
            <legend>Адаптер fastapi-evaluate-v1</legend>
            <label>
              Модуль Python
              <input required maxLength={128} placeholder="app.api" value={module}
                onChange={(event) => setModule(event.target.value)} />
            </label>
            <label>
              Префикс API кандидата
              <input maxLength={64} value={prefix} onChange={(event) => setPrefix(event.target.value)} />
            </label>
            {module && invalidAdapter && (
              <p role="alert">Укажите имя модуля Python через точки и префикс вида /api/v1 или оставьте префикс пустым.</p>
            )}
            <button type="submit" className="pv-button" disabled={invalidAdapter || !!disabledReason}>
              {busy ? "Запуск сравнения…" : "Запустить сравнение"}
            </button>
            {disabledReason && <p className="pv-note">{disabledReason}</p>}
          </fieldset>
        )}
      </form>
      {loadError && <p role="alert">История сравнений. {loadError}</p>}
      {(snapshots !== null || loadError || snapshotsError) && (
        <button type="button" className="pv-button" disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}>Обновить данные сравнения</button>
      )}
      {error && <p role="alert" className="pv-codegen-error">{error}</p>}
      {runs.length > 1 && (
        <label>
          Сохранённое сравнение{" "}
          <select value={run?.test_run_id} onChange={(event) => setRunId(event.target.value)}>
            {runs.map((item) => (
              <option key={item.test_run_id} value={item.test_run_id}>
                {item.comparison?.commit_sha.slice(0, 12)} · {new Date(item.created_at).toLocaleString("ru-RU")} · {item.test_run_id}
              </option>
            ))}
          </select>
        </label>
      )}
      {pollError && <p role="status">{pollError}</p>}
      {run && <ComparisonResult key={run.test_run_id} run={run} generation={generation} provider={provider} />}
    </div>
  );
}

function ComparisonResult({ run, generation, provider }: {
  run: TestRun;
  generation: Generation;
  provider: CodegenProvider;
}) {
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const id = run.test_run_id;
  useEffect(() => {
    if (!showLog) return;
    const controller = new AbortController();
    provider.getTestLog(id, controller.signal).then((text) => {
      if (!controller.signal.aborted) setLog(text);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setLogError(codegenErrorMessage(cause));
      setShowLog(false);
    });
    return () => controller.abort();
  }, [id, provider, showLog]);
  const result = run.comparison;
  if (!result || run.generation_id !== generation.generation_id
      || run.session_id !== generation.session_id || run.version_id !== generation.version_id
      || run.spec_hash !== generation.spec_hash || result.reference_code_hash !== generation.code_hash
      || result.code_hash !== run.code_hash) {
    return <p role="alert">Результат сравнения не связан с выбранной генерацией.</p>;
  }
  return (
    <section className="pv-comparison__result" aria-label="Результат сравнения">
      <p>
        <span role="status">{isTerminalTestRun(run) ? verdicts[result.status]
          : run.status === "queued" ? "Сравнение в очереди" : "Выполняется сравнение"}</span>
        {" · Снимок "}<code>{result.snapshot_id}</code>
        {" · Коммит "}<code title={result.commit_sha}>{result.commit_sha.slice(0, 12)}</code>
      </p>
      {run.error_code && <p>{run.message ?? run.error_code}</p>}
      {run.log_available && !showLog && (
        <button type="button" className="pv-button" onClick={() => {
          setLogError(null);
          setShowLog(true);
        }}>Журнал сравнения</button>
      )}
      {logError && <p role="alert">{logError}</p>}
      {showLog && (log === null ? <p role="status">Загрузка журнала…</p> : (
        <pre className="pv-test-log">{log}{run.log_truncated ? "\n[журнал сокращён сервером]" : ""}</pre>
      ))}
      {result.differences.length > 0 && (
        <ul>{result.differences.map((difference, index) => (
          <li key={`${difference.scenario_id}:${index}`}>
            <strong>{difference.scenario_id}</strong>
            {difference.transition_id && <> · переход {difference.transition_id}</>}
            {difference.requirement_ids.length > 0 && <> · требования {difference.requirement_ids.join(", ")}</>}
            {difference.message && <pre className="pv-test-log">{difference.message}</pre>}
          </li>
        ))}</ul>
      )}
      <details>
        <summary>Хеши сравнения</summary>
        <dl>
          <dt>Коммит</dt><dd><code>{result.commit_sha}</code></dd>
          <dt>Хеш manifest</dt><dd><code>{result.manifest_sha256}</code></dd>
          <dt>Хеш спецификации</dt><dd><code>{run.spec_hash}</code></dd>
          <dt>Хеш эталонного проекта</dt><dd><code>{result.reference_code_hash}</code></dd>
          <dt>Хеш проверенного кода</dt><dd><code>{result.code_hash}</code></dd>
          <dt>Хеш тестов</dt><dd><code>{result.tests_hash}</code></dd>
          <dt>Адаптер</dt><dd>{result.adapter.kind} · {result.adapter.module} · {result.adapter.api_prefix || "без префикса"}</dd>
        </dl>
      </details>
    </section>
  );
}
