import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeApiError } from "../../api/http";
import { SplitPane } from "../../ui/SplitPane";
import type {
  Generation,
  LineRange,
  ModelElementRef,
  TestRun,
  VersionRef,
} from "../contract";
import { isTerminalTestRun } from "../contract";
import {
  compareWithVersion,
  reviewManifest,
  testsProvenance,
} from "../manifest";
import {
  newActionKey,
  verificationDetails,
  type CodegenProvider,
} from "../provider";
import { decodeText } from "../text";
import { allFolderPaths, buildFileTree } from "../tree";
import { sha256Hex } from "../../util/sha256";
import { archiveBlockers, downloadProjectArchive, saveBytes } from "../zip";
import { CodeViewer } from "./CodeViewer";
import { FileTree } from "./FileTree";
import { TestResultsPanel } from "./TestResultsPanel";
export type ProjectFocus = {
  path: string;
  lines?: LineRange | null;
  generationId?: string;
};
export type ProjectFilesViewProps = {
  onAskFile?: (generation: Generation, entry: Generation["files"][number])=>void;
  provider: CodegenProvider;
  currentVersion: VersionRef | null;
  focus?: ProjectFocus | null;
  onRuleSelect?: (ref: ModelElementRef) => void;
  onManifestLoaded?: (generation: Generation) => void;
  className?: string;
};
/** Перемена версии размонтирует все запросы/кеши и исключает смешение поколений. */
export function ProjectFilesView(props: ProjectFilesViewProps) {
  if (!props.currentVersion)
    return <p className="pv-root pv-note">Выберите версию модели.</p>;
  return (
    <VersionProjects
      key={`${props.currentVersion.id}:${props.currentVersion.spec_hash}`}
      {...props}
      currentVersion={props.currentVersion}
    />
  );
}
function VersionProjects({
  provider,
  currentVersion,
  focus,
  onRuleSelect,
  onManifestLoaded, onAskFile,
  className,
}: ProjectFilesViewProps & { currentVersion: VersionRef }) {
  const [projects, setProjects] = useState<Generation[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState("loading"),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const [sandboxReason, setSandboxReason] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [gate, setGate] =
    useState<ReturnType<typeof verificationDetails>>(null);
  const alive = useRef(true),
    actionKey = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    setPhase("loading");
    setError(null);
    (async () => {
      const state = await provider.status(ac.signal);
      if (ac.signal.aborted) return;
      if (!state.available) {
        setUnavailable(state.reason);
        setPhase("ready");
        return;
      }
      setUnavailable(null);
      setSandboxReason(
        state.status.sandbox_status === "engine_unavailable"
          ? (state.status.sandbox_reason ?? "Песочница тестов недоступна")
          : null,
      );
      const all = await provider.listGenerations(currentVersion, ac.signal);
      if (ac.signal.aborted) return;
      setProjects(all);
      setSelected((old) =>
        all.some((g) => g.generation_id === old)
          ? old
          : (all.at(-1)?.generation_id ?? null),
      );
      setPhase("ready");
    })().catch((e) => {
      if (!ac.signal.aborted) {
        setError(describeApiError(e).title);
        setPhase("error");
      }
    });
    return () => ac.abort();
  }, [provider, currentVersion.id, attempt]);
  const generation = projects.find((p) => p.generation_id === selected) ?? null;
  const create = async (allowUnverified: boolean) => {
    setBusy(true);
    setError(null);
    const key = actionKey.current ?? newActionKey("generate");
    actionKey.current = key;
    try {
      const g = await provider.createGeneration(
        currentVersion,
        { allowUnverified },
        key,
      );
      if (!alive.current) return;
      setProjects((old) => [
        ...old.filter((p) => p.generation_id !== g.generation_id),
        g,
      ]);
      setSelected(g.generation_id);
      setGate(null);
      actionKey.current = null;
    } catch (e) {
      if (!alive.current) return;
      const details = verificationDetails(e);
      if (details) {
        setGate(details);
        actionKey.current = null;
      } else {
        setError(describeApiError(e).title);
        if (e instanceof ApiError) actionKey.current = null;
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className={`pv-root pv-files ${className ?? ""}`}>
      <div className="pv-files__bar">
        <span>Версия {currentVersion.number}</span>
        {provider.label && <span className="pv-muted">{provider.label}</span>}
        {projects.length > 0 && (
          <label>
            Генерация{" "}
            <select
              aria-label="Генерация"
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {projects.map((g) => (
                <option key={g.generation_id} value={g.generation_id}>
                  {new Date(g.created_at).toLocaleString("ru-RU")} /{" "}
                  {g.generation_id.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="pv-toolbar__spacer" />
        <button
          className="pv-button"
          disabled={
            busy ||
            phase !== "ready" ||
            !!unavailable ||
            !currentVersion.approved
          }
          title={
            !currentVersion.approved
              ? "Сначала подтвердите, что эта версия отражает требования"
              : undefined
          }
          onClick={() => create(false)}
        >
          {busy ? "Генерация…" : "Создать проект"}
        </button>
        <button
          className="pv-button"
          disabled={busy}
          onClick={() => setAttempt((v) => v + 1)}
        >
          Обновить
        </button>
      </div>
      {!currentVersion.approved && (
        <p className="pv-note">
          Для генерации подтвердите, что выбранная версия модели отражает
          требования. Подтверждение не является результатом TLC.
        </p>
      )}
      {phase === "loading" && <p role="status">Загрузка проектов…</p>}
      {unavailable && <p role="status">{unavailable}</p>}
      {error && <p role="alert">{error}</p>}
      {gate && (
        <section
          className="pv-generation-gate"
          aria-label="Подтверждение генерации"
        >
          <p>
            Не все правила имеют результат PROPERTY_HOLDS. Проект воспроизведёт
            текущую модель, включая найденные нарушения.
          </p>
          <ul>
            {gate.map((p) => (
              <li key={p.property_id}>
                {p.property_id}: {p.status ?? "не проверено"}
              </li>
            ))}
          </ul>
          <button
            className="pv-button"
            disabled={busy}
            onClick={() => create(true)}
          >
            Создать с текущими результатами TLC
          </button>
          <button
            className="pv-button"
            disabled={busy}
            onClick={() => setGate(null)}
          >
            Отмена
          </button>
        </section>
      )}
      {phase === "ready" && !unavailable && !generation && (
        <p className="pv-note">
          Для этой версии ещё нет сгенерированного проекта.
        </p>
      )}
      {generation && (
        <GenerationFiles
          key={generation.generation_id}
          sandboxReason={sandboxReason}
          provider={provider}
          generation={generation}
          currentVersion={currentVersion}
          focus={focus}
          onRuleSelect={onRuleSelect}
          onManifestLoaded={onManifestLoaded} onAskFile={onAskFile}
        />
      )}
    </div>
  );
}
function GenerationFiles({
  sandboxReason,
  provider,
  generation,
  currentVersion,
  focus,
  onRuleSelect,
  onManifestLoaded, onAskFile,
}: {
  sandboxReason: string | null;
  provider: CodegenProvider;
  generation: Generation;
  currentVersion: VersionRef;
  focus: ProjectFocus | null | undefined;
  onRuleSelect: ProjectFilesViewProps["onRuleSelect"];
  onManifestLoaded: ProjectFilesViewProps["onManifestLoaded"];
  onAskFile?: ProjectFilesViewProps["onAskFile"];
}) {
  const loadedCallback = useRef(onManifestLoaded);
  loadedCallback.current = onManifestLoaded;
  const activeFocus =
    !focus?.generationId || focus.generationId === generation.generation_id
      ? focus
      : null;
  const review = useMemo(() => reviewManifest(generation), [generation]);
  const tree = useMemo(() => buildFileTree(review.files), [review]);
  const [opened, setOpened] = useState(() => new Set(allFolderPaths(tree)));
  const [path, setPath] = useState(
    activeFocus?.path ??
      review.files.find((f) => f.role === "source")?.path ??
      null,
  );
  const [highlight, setHighlight] = useState<LineRange | null>(
    activeFocus?.lines ?? null,
  );
  const [file, setFile] = useState<{
    path: string;
    text: string | null;
    error: string | null;
  } | null>(null);
  const [test, setTest] = useState<TestRun | null>(null),
    [testError, setTestError] = useState<string | null>(null),
    [testBusy, setTestBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null),
    [download, setDownload] = useState(false),
    [downloadError, setDownloadError] = useState<string | null>(null);
  const alive = useRef(true),
    testKey = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const compatible =
    compareWithVersion(generation, currentVersion).kind === "same";
  const blockers = archiveBlockers(generation),
    valid = blockers.length === 0;
  const entry = review.files.find((f) => f.path === path) ?? null;
  useEffect(() => {
    if (valid) loadedCallback.current?.(generation);
  }, [generation, valid]);
  useEffect(() => {
    if (!activeFocus) return;
    setPath(activeFocus.path);
    setHighlight(activeFocus.lines ?? null);
    const parts = activeFocus.path.split("/");
    setOpened((old) => {
      const n = new Set(old);
      for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join("/"));
      return n;
    });
  }, [activeFocus]);
  useEffect(() => {
    if (!entry || !valid) return;
    const ac = new AbortController();
    setFile(null);
    provider
      .readFile(generation.generation_id, entry.path, ac.signal)
      .then(({ bytes, sha256Header }) => {
        if (ac.signal.aborted) return;
        if (
          bytes.length !== entry.size ||
          sha256Hex(bytes) !== entry.sha256 ||
          (sha256Header !== null && sha256Header !== entry.sha256)
        )
          throw new Error("Содержимое не совпадает с manifest (size/sha256)");
        setFile({ path: entry.path, text: decodeText(bytes), error: null });
      })
      .catch((e) => {
        if (!ac.signal.aborted)
          setFile({
            path: entry.path,
            text: null,
            error:
              e instanceof ApiError && e.status === 404
                ? "Файл указан в manifest, но в источнике его нет"
                : e instanceof Error
                  ? e.message
                  : String(e),
          });
      });
    return () => ac.abort();
  }, [provider, generation, entry, valid]);
  useEffect(() => {
    const ac = new AbortController();
    provider
      .listTestRuns(generation.generation_id, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setTest(r.at(-1) ?? null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setTestError(describeApiError(e).title);
      });
    return () => ac.abort();
  }, [provider, generation]);
  useEffect(() => {
    if (!test || isTerminalTestRun(test)) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      provider
        .getTestRun(test.test_run_id, ac.signal)
        .then((t) => {
          if (!ac.signal.aborted) setTest(t);
        })
        .catch((e) => {
          if (!ac.signal.aborted) setTestError(describeApiError(e).title);
        });
    }, 1000);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [provider, test]);
  const action = async (fn: () => Promise<TestRun>) => {
    setTestBusy(true);
    setTestError(null);
    setLog(null);
    try {
      const t = await fn();
      if (alive.current) {
        setTest(t);
        testKey.current = null;
      }
    } catch (e) {
      if (alive.current) {
        setTestError(describeApiError(e).title);
        if (e instanceof ApiError) testKey.current = null;
      }
    } finally {
      if (alive.current) setTestBusy(false);
    }
  };
  return (
    <>
      <div className="pv-provenance">
        <span>
          Версия {generation.version_number}, {generation.file_count} файлов
        </span>
        <details>
          <summary>Происхождение</summary>
          <p>
            Модель {generation.model_id}; версия {generation.version_id};
            генератор {generation.generator.name} {generation.generator.version}
          </p>
          <p>Код и тесты собираются по шаблонам из согласованной модели. LLM не генерирует файлы проекта.</p>
          <code>
            {generation.spec_hash} / {generation.code_hash}
          </code>
        </details>
        <code title={generation.spec_hash}>
          spec {generation.spec_hash.slice(0, 12)}
        </code>
        <code title={generation.code_hash}>
          code {generation.code_hash.slice(0, 12)}
        </code>
        <span>
          TLC: {generation.verification.state}
          {generation.verification.acknowledged
            ? " (генерация подтверждена с этим результатом)"
            : ""}
        </span>
        <button
          className="pv-button"
          disabled={!valid || !compatible || download}
          title={blockers.join("; ")}
          onClick={async () => {
            setDownload(true);
            setDownloadError(null);
            try {
              const a = await downloadProjectArchive(provider, generation);
              if (alive.current) saveBytes(a.bytes, a.fileName);
            } catch (e) {
              if (alive.current)
                setDownloadError(e instanceof Error ? e.message : String(e));
            } finally {
              if (alive.current) setDownload(false);
            }
          }}
        >
          {download ? "Подготовка ZIP…" : "Скачать проект"}
        </button>
      </div>
      {!compatible && (
        <p role="alert">
          Файлы относятся к другой версии или спецификации. Экспорт и запуск
          заблокированы.
        </p>
      )}
      {!valid && <p role="alert">{blockers.join("; ")}</p>}
      {downloadError && <p role="alert">{downloadError}</p>}
      <div className="pv-files__content">
        <SplitPane
          axis="vertical"
          label="Высота кода и тестов"
          storageKey="pv-files-code-height"
          initial={70}
          min={35}
          max={85}
        >
          {[
            <SplitPane
              key="source"
              label="Ширина дерева файлов"
              storageKey="pv-files-tree-width"
              initial={27}
              min={15}
              max={60}
            >
              {[
                <FileTree
                  key="tree"
                  root={tree}
                  rootLabel={generation.project_name}
                  expanded={opened}
                  selectedPath={path}
                  onOpen={(p) => {
                    setPath(p);
                    setHighlight(null);
                  }}
                  onToggle={(p, open) =>
                    setOpened((old) => {
                      const n = new Set(old);
                      if (open ?? !n.has(p)) n.add(p);
                      else n.delete(p);
                      return n;
                    })
                  }
                />,
                <div key="code" className="pv-viewer">
                  <header className="pv-viewer__head">
                    {entry?.path ?? "Выберите файл"}
                    {onAskFile && valid && entry && file?.path === entry.path && !file.error && file.text != null && <button type="button" className="pv-button" disabled={entry.size>65536} title={entry.size>65536 ? "Объяснение доступно для файлов до 64 КиБ" : undefined} onClick={()=>onAskFile(generation,entry)}>Спросить агента о файле</button>}
                  </header>
                  {!valid ? null : entry && file?.path !== entry.path ? (
                    <p role="status">Загрузка файла…</p>
                  ) : file?.error ? (
                    <p role="alert">{file.error}</p>
                  ) : entry &&
                    file?.text !== null &&
                    file?.text !== undefined ? (
                    <CodeViewer
                      entry={entry}
                      text={file.text}
                      highlight={highlight}
                      onHighlight={setHighlight}
                      onRuleSelect={onRuleSelect}
                    />
                  ) : entry ? (
                    <p>Двоичный файл доступен в архиве.</p>
                  ) : null}
                </div>,
              ]}
            </SplitPane>,
            <div key="tests" className="pv-tests-area">
              <div className="pv-files__bar">
                <button
                  className="pv-button"
                  title={sandboxReason ?? undefined}
                  disabled={
                    !valid ||
                    !compatible ||
                    !!sandboxReason ||
                    testBusy ||
                    (!!test && !isTerminalTestRun(test))
                  }
                  onClick={() => {
                    testKey.current ??= newActionKey("tests");
                    return action(() =>
                      provider.startTestRun(
                        generation.generation_id,
                        testKey.current!,
                      ),
                    );
                  }}
                >
                  Запустить тесты
                </button>
                {test && !isTerminalTestRun(test) && (
                  <button
                    className="pv-button"
                    disabled={testBusy || test.cancel_requested}
                    onClick={() =>
                      action(() => provider.cancelTestRun(test.test_run_id))
                    }
                  >
                    {test.cancel_requested
                      ? "Отмена запрошена"
                      : "Отменить тесты"}
                  </button>
                )}
                {test && (
                  <button
                    className="pv-button"
                    disabled={testBusy}
                    onClick={() =>
                      action(() => provider.getTestRun(test.test_run_id))
                    }
                  >
                    Обновить тесты
                  </button>
                )}
                {test?.log_available && (
                  <button
                    className="pv-button"
                    onClick={async () => {
                      try {
                        const s = await provider.getTestLog(test.test_run_id);
                        if (alive.current) setLog(s);
                      } catch (e) {
                        if (alive.current)
                          setTestError(describeApiError(e).title);
                      }
                    }}
                  >
                    Журнал pytest
                  </button>
                )}
              </div>
              {sandboxReason && <p role="status">{sandboxReason}</p>}
              {testError && <p role="alert">{testError}</p>}
              <TestResultsPanel
                tests={test}
                provenance={testsProvenance(test, generation)}
              />
              {log !== null && (
                <pre className="pv-test-log">
                  {log}
                  {test?.log_truncated ? "\n[журнал сокращён сервером]" : ""}
                </pre>
              )}
            </div>,
          ]}
        </SplitPane>
      </div>
    </>
  );
}
