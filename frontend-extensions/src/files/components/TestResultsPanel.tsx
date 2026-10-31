import type { TestRun } from "../contract";
import type { TestsProvenance } from "../manifest";
const labels: Record<TestRun["status"], string> = {
  queued: "Тесты в очереди",
  running: "Тесты выполняются",
  passed: "Тесты пройдены",
  failed: "Тесты упали",
  timeout: "Тесты остановлены по времени",
  engine_unavailable: "Песочница недоступна",
  cancelled: "Запуск отменён",
  error: "Ошибка запуска",
};
export function TestResultsPanel({
  tests,
  provenance,
}: {
  tests: TestRun | null;
  provenance: TestsProvenance;
}) {
  return (
    <section className="pv-tests" aria-label="Тесты">
      <header className="pv-tests__head">
        <h3>Тесты</h3>
        <span role="status">
          {tests ? labels[tests.status] : "не запускались"}
        </span>
        {tests && (
          <span>
            пройдено {tests.counts.passed ?? "?"} из {tests.counts.total ?? "?"}
            ; ошибок {tests.counts.errors ?? "?"}; упало{" "}
            {tests.counts.failed ?? "?"}; пропущено{" "}
            {tests.counts.skipped ?? "?"}
          </span>
        )}
      </header>
      <p className="pv-note">
        Тесты проверяют соответствие кода модели на выбранных состояниях.
        Результат TLC показан отдельно.
      </p>
      {provenance.kind === "stale" && (
        <p role="alert">
          Результаты относятся к другой генерации, версии или набору файлов.
        </p>
      )}
      {tests?.message && tests.error_code && (
        <p role="alert">
          {tests.message} {tests.error_code}
        </p>
      )}
      {tests?.sandbox && (
        <details>
          <summary>Песочница и происхождение</summary>
          <p>
            {tests.sandbox.engine}, сеть {tests.sandbox.network},{" "}
            {tests.sandbox.memory_mb} МБ
          </p>
          <code>
            {tests.version_id} / {tests.code_hash}
          </code>
        </details>
      )}
      <div className="pv-tests__list">
        {tests?.cases.map((c, i) => (
          <details key={i}>
            <summary>
              {c.outcome}: {c.classname} {c.name}
            </summary>
            {c.message && <pre>{c.message}</pre>}
          </details>
        ))}
      </div>
    </section>
  );
}
