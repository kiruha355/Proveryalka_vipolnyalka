import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeApiError } from "../../api/http";
import { SplitPane } from "../../ui/SplitPane";
import type {
  CodegenStatus,
  Generation,
  LineRange,
  ModelElementRef,
  TestRun,
  VerificationState,
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
  codegenErrorMessage,
  type CodegenProvider,
} from "../provider";
import { decodeText } from "../text";
import { allFolderPaths, buildFileTree } from "../tree";
import { sha256Hex } from "../../util/sha256";
import { archiveBlockers, downloadProjectArchive, saveBytes } from "../zip";
import { useRunPolling } from "../useRunPolling";
import { GenerationForm, generationLabel } from "./GenerationForm";
import { RepositoryComparison } from "./RepositoryComparison";
import { ProjectSourcePane } from "./ProjectSourcePane";
import { CodeViewer } from "./CodeViewer";
import { FileTree } from "./FileTree";
import { TestResultsPanel } from "./TestResultsPanel";
export type ProjectFocus = {
  path: string;
  lines?: LineRange | null;
  generationId?: string;
  versionId?: string;
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
  const [projects, setProjects] = useState<Generation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dismissedFocus, setDismissedFocus] = useState<ProjectFocus | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<CodegenStatus | null>(null);
  const [verificationState, setVerificationState] = useState<VerificationState | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setPhase("loading");
    setError(null);
    setVerificationState(null);
    (async () => {
      const state = await provider.status(signal);
      if (signal.aborted) return;
      if (!state.available) {
        setUnavailable(state.reason);
        setStatus(null);
        setPhase("ready");
        return;
      }
      setUnavailable(null);
      setStatus(state.status);
      const all = await provider.listGenerations(currentVersion, signal, (verification) => {
        if (!signal.aborted) setVerificationState(verification);
      });
      if (signal.aborted) return;
      setProjects(all);
      setPhase("ready");
    })().catch((cause) => {
      if (signal.aborted) return;
      setError(codegenErrorMessage(cause));
      setPhase("error");
    });
    return () => controller.abort();
  }, [provider, currentVersion.id, attempt]);

  const activeFocus = focus !== dismissedFocus && (!focus?.versionId || focus.versionId === currentVersion.id)
    ? focus : null;
  const focused = activeFocus?.generationId
    ? projects.find((project) => project.generation_id === activeFocus.generationId)
    : undefined;
  const generation = focused ?? projects.find((project) => project.generation_id === selected) ?? projects.at(-1);
  useEffect(() => {
    if (focused) setSelected(focused.generation_id);
  }, [focused]);

  const sandboxReason = status?.sandbox_status === "engine_unavailable"
    ? (status.sandbox_reason ?? "Песочница тестов недоступна") : null;
  return (
    <div className={`pv-root pv-files ${className ?? ""}`}>
      <div className="pv-files__bar">
        {projects.length > 0 && (
          <label className="pv-generation-picker">
            Генерация{" "}
            <select
              value={generation?.generation_id ?? ""}
              title={generation ? generationLabel(generation) : undefined}
              onChange={(event) => {
                setDismissedFocus(focus ?? null);
                setSelected(event.target.value);
              }}
            >
              {projects.map((project) => (
                <option key={project.generation_id} value={project.generation_id}>
                  {generationLabel(project)}
                </option>
              ))}
            </select>
          </label>
        )}
        {provider.label && <span className="pv-muted">{provider.label}</span>}
        {projects.length > 0 && phase === "ready" && !unavailable && (
          <button
            type="button"
            className="pv-button"
            aria-expanded={showForm}
            disabled={busy}
            onClick={() => setShowForm((open) => !open)}
          >
            {showForm ? "Свернуть форму" : "Новая генерация…"}
          </button>
        )}
        <button type="button" className="pv-button" disabled={busy || phase === "loading"}
          onClick={() => setAttempt((value) => value + 1)}>
          Обновить
        </button>
      </div>
      {phase === "loading" && <p role="status">Загрузка проектов…</p>}
      {unavailable && <p role="status">{unavailable}</p>}
      {error && <p role="alert">{error}</p>}
      {phase === "ready" && !unavailable && activeFocus?.generationId && !focused && (
        <p role="alert">Генерация {activeFocus.generationId} из ссылки не найдена у версии {currentVersion.number}.</p>
      )}
      {phase === "ready" && !unavailable && projects.length === 0 && (
        <p className="pv-note">Для этой версии ещё нет сгенерированного проекта.</p>
      )}
      <GenerationForm
        provider={provider}
        version={currentVersion}
        status={status}
        verificationState={verificationState}
        hidden={projects.length > 0 && !showForm}
        disabled={phase !== "ready" || !!unavailable}
        busy={busy}
        onBusy={setBusy}
        onVerificationState={setVerificationState}
        onCreated={(created) => {
          setProjects((old) => [...old.filter((project) => project.generation_id !== created.generation_id), created]);
          setDismissedFocus(focus ?? null);
          setSelected(created.generation_id);
          setShowForm(false);
        }}
      />
      {generation && (
        <GenerationFiles
          key={generation.generation_id}
          sandboxReason={sandboxReason}
          provider={provider}
          generation={generation}
          currentVersion={currentVersion}
          focus={activeFocus}
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
    testKey = useRef<string | null>(null),
    localRun = useRef(false);
  const [sourceView, setSourceView] = useState<"files" | "code">(activeFocus ? "code" : "files");
  const codeButton = useRef<HTMLButtonElement>(null);
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
    setSourceView("code");
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
                : e instanceof ApiError && (e.status === 401 || e.status === 403)
                  ? describeApiError(e).title
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
        if (!ac.signal.aborted && !localRun.current) setTest(r.at(-1) ?? null);
      })
      .catch((e) => {
        if (!ac.signal.aborted && !localRun.current) setTestError(codegenErrorMessage(e));
      });
    return () => ac.abort();
  }, [provider, generation.generation_id]);
  const pollError = useRunPolling(provider, test, setTest, testBusy);
  const action = async (fn: () => Promise<TestRun>) => {
    setTestBusy(true);
    setTestError(null);
    setLog(null);
    try {
      const t = await fn();
      if (alive.current) {
        localRun.current = true;
        setTestError(null);
        setTest(t);
        testKey.current = null;
      }
    } catch (e) {
      if (alive.current) {
        setTestError(codegenErrorMessage(e));
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
          <p>{generation.application_mode === "agent"
            ? "Агент составляет прикладной план. Генератор собирает реализацию правил и тесты из согласованной модели."
            : "Код и тесты собираются по шаблонам из согласованной модели."}</p>
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
                setDownloadError(
                  e instanceof ApiError && (e.status === 401 || e.status === 403)
                    ? describeApiError(e).title
                    : e instanceof Error
                      ? e.message
                      : String(e),
                );
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
            <ProjectSourcePane key="source" view={sourceView} onViewChange={setSourceView} hasFile={path !== null} codeButtonRef={codeButton}>
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
                    setSourceView("code");
                    codeButton.current?.focus();
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
                  {!valid ? null : path && !entry ? (
                    <p role="alert">Файл {path} отсутствует в выбранной генерации.</p>
                  ) : entry && file?.path !== entry.path ? (
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
            </ProjectSourcePane>,
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
                          setTestError(codegenErrorMessage(e));
                      }
                    }}
                  >
                    Журнал pytest
                  </button>
                )}
              </div>
              {sandboxReason && <p role="status">{sandboxReason}</p>}
              {testError && <p role="alert">{testError}</p>}
              {pollError && <p role="status">{pollError}</p>}
              {provider.comparisons && (
                <RepositoryComparison
                  provider={provider}
                  comparisons={provider.comparisons}
                  generation={generation}
                  disabledReason={!valid || !compatible ? "Генерация не прошла проверку происхождения." : sandboxReason}
                />
              )}
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
