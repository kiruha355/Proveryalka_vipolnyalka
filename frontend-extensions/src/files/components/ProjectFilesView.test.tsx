import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/http";
import {
  createRecordedCodegenProvider,
  CODEGEN_VERSION as version,
  RECORDED_GENERATION as g,
  RECORDED_TEST_RUN as run,
} from "../../fixtures/codegen";
import { ProjectFilesView } from "./ProjectFilesView";
import type { CandidateComparison, TestRun } from "../contract";
import { SplitPane } from "../../ui/SplitPane";

const supportedConditions = {
  language: ["python"],
  platform: ["fastapi"],
  api_prefix: ["", "/api/v1"],
  storage: ["memory", "sqlite"],
  integrations: [],
};

async function currentProvider() {
  const provider = createRecordedCodegenProvider();
  const available = await provider.status();
  if (!available.available) throw new Error(available.reason);
  provider.status = async () => ({
    available: true,
    status: { ...available.status, supported_conditions: supportedConditions },
  });
  return provider;
}

describe("project viewer реального контракта", () => {
  it("показывает manifest/строки/модель/pytest с явным recording provenance", async () => {
    const onSelect = vi.fn();
    render(
      <ProjectFilesView
        provider={createRecordedCodegenProvider()}
        currentVersion={version}
        focus={{ path: "app/rules.py", lines: { start: 34, end: 45 } }}
        onRuleSelect={onSelect}
      />,
    );
    expect(await screen.findByText(/Версия.*файлов/)).toBeInTheDocument();
    const content = await screen.findByLabelText("Содержимое app/rules.py");
    expect(content.querySelector('[data-line="34"]')).toHaveClass("is-marked");
    expect(
      screen.getByText(/Запись прогона генератора и Docker; не live/),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByLabelText("Показать переход Cancel в модели"),
    );
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transition", id: "Cancel" }),
    );
    expect(await screen.findByText(/пройдено 79 из 79/)).toBeInTheDocument();
    expect(screen.getByText(/^TLC: holds/)).toBeVisible();
  });
  it("требует явного подтверждения после VERIFICATION_REQUIRED и не запускает тесты автоматически", async () => {
    const p = await currentProvider();
    p.listGenerations = async (_version, _signal, onVerification) => {
      onVerification?.("violated");
      return [];
    };
    p.startTestRun = vi.fn();
    p.createGeneration = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "VERIFICATION_REQUIRED", "Нужно подтверждение", [
          {
            property_id: "R",
            status: "PROPERTY_VIOLATED",
            check_run_id: "chk",
          },
        ]),
      )
      .mockResolvedValueOnce({
        ...g,
        verification: {
          ...g.verification,
          state: "violated",
          acknowledged: true,
        },
      });
    render(<ProjectFilesView provider={p} currentVersion={version} />);
    await screen.findByText(/ещё нет сгенерированного/);
    expect(screen.getByText(/Утверждённая версия .*TLC: violated/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Создать проект" }),
    );
    expect(await screen.findByText("R: PROPERTY_VIOLATED")).toBeInTheDocument();
    expect(p.createGeneration).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Создать с текущими результатами TLC",
      }),
    );
    expect(await screen.findByText(/^TLC: violated/)).toBeVisible();
    expect(p.createGeneration).toHaveBeenLastCalledWith(
      version,
      expect.objectContaining({
        allowUnverified: true,
        applicationMode: "template",
        technicalConditions: expect.objectContaining({ storage: "memory" }),
      }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(p.startTestRun).not.toHaveBeenCalled();
    expect(await screen.findByText(/пройдено 79 из 79/)).toBeInTheDocument();
  });
  it("не превращает pending counts в нули и позволяет отменить тесты", async () => {
    const p = createRecordedCodegenProvider();
    p.listTestRuns = async () => [];
    const pending: TestRun = {
      ...run,
      status: "queued",
      counts: {
        total: null,
        passed: null,
        failed: null,
        errors: null,
        skipped: null,
      },
      cases: [],
    };
    p.startTestRun = vi.fn().mockResolvedValue(pending);
    p.cancelTestRun = vi
      .fn()
      .mockResolvedValue({ ...pending, status: "cancelled" });
    render(<ProjectFilesView provider={p} currentVersion={version} />);
    await screen.findByText(/Версия.*файлов/);
    await screen.findByText("не запускались");
    await userEvent.click(
      screen.getByRole("button", { name: "Запустить тесты" }),
    );
    expect(await screen.findByText(/пройдено \? из \?/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Отменить тесты" }),
    );
    expect(await screen.findByText("Запуск отменён")).toBeInTheDocument();
  });
  it("не показывает содержимое при hash mismatch и отсутствующем файле", async () => {
    const p = createRecordedCodegenProvider();
    p.readFile = async () => ({
      bytes: new TextEncoder().encode("tampered"),
      sha256Header: null,
    });
    render(<ProjectFilesView provider={p} currentVersion={version} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /не совпадает с manifest/,
    );
  });
  it("не смешивает файлы после смены версии и запоздалого ответа", async () => {
    const p = createRecordedCodegenProvider();
    let resolve!: (r: { bytes: Uint8Array; sha256Header: null }) => void;
    p.readFile = () =>
      new Promise((r) => {
        resolve = r;
      });
    const view = render(
      <ProjectFilesView provider={p} currentVersion={version} />,
    );
    await screen.findByText("Загрузка файла…");
    view.rerender(
      <ProjectFilesView
        provider={p}
        currentVersion={{ ...version, id: "v_other", number: 88 }}
      />,
    );
    await screen.findByText(/ещё нет сгенерированного/);
    await act(async () => {
      resolve({ bytes: new TextEncoder().encode("LATE"), sha256Header: null });
    });
    expect(screen.queryByText("LATE")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Содержимое/)).not.toBeInTheDocument();
  });
  it("называет router unavailable, не показывает пустой успешный проект", async () => {
    const p = createRecordedCodegenProvider();
    p.status = async () => ({
      available: false,
      reason: "На сервере не подключён модуль генерации",
    });
    render(<ProjectFilesView provider={p} currentVersion={version} />);
    expect(await screen.findByText(/не подключён/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Создать проект" }),
    ).toBeDisabled();
  });
  it("версия без подтверждения не генерируется", async () => {
    render(
      <ProjectFilesView
        provider={createRecordedCodegenProvider()}
        currentVersion={{ ...version, approved: false }}
      />,
    );
    await screen.findByText(/Версия.*файлов/);
    await userEvent.click(screen.getByRole("button", { name: "Новая генерация…" }));
    expect(
      screen.getByRole("button", { name: "Создать проект" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Подтверждение не является результатом TLC/),
    ).toBeInTheDocument();
  });
  it("разделитель сохраняет размер, ограничивает Home/End и работает при запрете localStorage", async () => {
    localStorage.clear();
    const props = { label: "Ширина", storageKey: "test-split" };
    const a = render(
      <SplitPane {...props}>
        {[<p key="1">Tree</p>, <p key="2">Code</p>]}
      </SplitPane>,
    );
    const sep = screen.getByRole("separator");
    sep.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(sep).toHaveAttribute("aria-valuenow", "30");
    a.unmount();
    render(
      <SplitPane {...props}>
        {[<p key="1">Tree</p>, <p key="2">Code</p>]}
      </SplitPane>,
    );
    const next = screen.getByRole("separator");
    expect(next).toHaveAttribute("aria-valuenow", "30");
    fireEvent.keyDown(next, { key: "End" });
    expect(next).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(next, { key: "Home" });
    expect(next).toHaveAttribute("aria-valuenow", "15");
  });
});

it("сохраняет комбинацию и режим после отказа сервера, затем выбирает созданный проект", async () => {
  const p = await currentProvider();
  const conditions = {
    language: "python",
    platform: "fastapi",
    api_prefix: "/api/v1",
    storage: "sqlite",
    integrations: [],
  };
  const created = {
    ...g,
    generation_id: "gen_agent",
    application_mode: "agent" as const,
    technical_conditions: conditions,
  };
  const readFile = p.readFile;
  p.readFile = vi.fn(async (_id, path, signal) => readFile(g.generation_id, path, signal));
  p.listTestRuns = async () => [];
  p.createGeneration = vi.fn()
    .mockRejectedValueOnce(new ApiError(422, "UNSUPPORTED_TECHNICAL_CONDITIONS", "Условия отклонены", [
      { path: "storage", reason: "SQLite временно недоступен" },
    ]))
    .mockResolvedValueOnce(created);
  render(<ProjectFilesView provider={p} currentVersion={version} />);

  const picker = await screen.findByRole("combobox", { name: "Генерация" });
  expect(screen.queryByRole("form", { name: "Технические условия" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Новая генерация…" }));
  const form = within(screen.getByRole("form", { name: "Технические условия" }));
  expect(form.getByText(/Утверждённая версия .*TLC: holds/)).toBeVisible();
  expect(form.getByText("python-fastapi")).toBeVisible();
  expect(form.getByRole("combobox", { name: "Язык" })).toHaveValue("python");
  expect(form.getByRole("combobox", { name: "Платформа" })).toHaveValue("fastapi");
  expect(form.getByText(/Внешние интеграции пока не поддерживаются/)).toBeVisible();
  const storage = form.getByRole("combobox", { name: "Хранилище" });
  const prefix = form.getByRole("combobox", { name: "Префикс API" });
  const mode = form.getByRole("radio", { name: "Прикладной проект с агентом" });
  await userEvent.selectOptions(storage, "sqlite");
  await userEvent.selectOptions(prefix, "/api/v1");
  await userEvent.click(mode);
  await userEvent.click(form.getByRole("button", { name: "Создать проект" }));
  expect(await form.findByRole("alert")).toHaveTextContent("storage: SQLite временно недоступен");
  expect(storage).toHaveValue("sqlite");
  expect(prefix).toHaveValue("/api/v1");
  expect(mode).toBeChecked();
  await userEvent.click(form.getByRole("button", { name: "Создать проект" }));
  await waitFor(() => expect(picker).toHaveValue(created.generation_id));
  expect(p.createGeneration).toHaveBeenLastCalledWith(version, {
    target: "python-fastapi",
    applicationMode: "agent",
    technicalConditions: conditions,
    allowUnverified: false,
  }, expect.any(String), expect.any(AbortSignal));
  expect(within(picker).getByRole("option", {
    name: /Версия .*Прикладной проект с агентом.*\/api\/v1.*sqlite.*Без интеграций/,
  })).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Технические условия" })).toBeNull();
  await userEvent.selectOptions(picker, g.generation_id);
  await screen.findByLabelText("Содержимое app/__init__.py");
  expect(p.readFile).toHaveBeenLastCalledWith(g.generation_id, "app/__init__.py", expect.any(AbortSignal));
});

it("блокирует комбинацию, исключённую из статуса сервера после обновления", async () => {
  const p = await currentProvider();
  const supported = await p.status();
  if (!supported.available) throw new Error(supported.reason);
  p.listGenerations = async () => [];
  p.createGeneration = vi.fn();
  render(<ProjectFilesView provider={p} currentVersion={version} />);
  await screen.findByText(/ещё нет сгенерированного/);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Хранилище" }), "sqlite");
  p.status = async () => ({
    available: true,
    status: { ...supported.status, supported_conditions: { ...supportedConditions, storage: ["memory"] } },
  });
  await userEvent.click(screen.getByRole("button", { name: "Обновить" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Хранилище: доступно memory");
  expect(screen.getByRole("button", { name: "Создать проект" })).toBeDisabled();
  expect(p.createGeneration).not.toHaveBeenCalled();
});

it("сбрасывает согласие с прежней проверкой TLC при обновлении и сохраняет условия", async () => {
  const p = await currentProvider();
  let state: "not_checked" | "violated" = "not_checked";
  p.listGenerations = async (_version, _signal, onVerification) => {
    onVerification?.(state);
    return [];
  };
  const gate = (property_id: string, status: string | null) =>
    new ApiError(409, "VERIFICATION_REQUIRED", "Нужно подтверждение", [{ property_id, status, check_run_id: null }]);
  p.createGeneration = vi.fn()
    .mockRejectedValueOnce(gate("OldRule", null))
    .mockRejectedValueOnce(gate("NewRule", "PROPERTY_VIOLATED"));
  render(<ProjectFilesView provider={p} currentVersion={version} />);

  const conditions = within(screen.getByRole("form", { name: "Технические условия" }));
  await conditions.findByText(/TLC: not_checked/);
  await userEvent.selectOptions(conditions.getByRole("combobox", { name: "Хранилище" }), "sqlite");
  await userEvent.selectOptions(conditions.getByRole("combobox", { name: "Префикс API" }), "/api/v1");
  await userEvent.click(conditions.getByRole("radio", { name: "Прикладной проект с агентом" }));
  await userEvent.click(conditions.getByRole("button", { name: "Создать проект" }));
  expect(await conditions.findByText(/OldRule/)).toBeVisible();
  state = "violated";
  await userEvent.click(screen.getByRole("button", { name: "Обновить" }));

  expect(await conditions.findByText(/TLC: violated/)).toBeVisible();
  expect(conditions.queryByText(/OldRule/)).toBeNull();
  expect(conditions.queryByRole("button", { name: "Создать с текущими результатами TLC" })).toBeNull();
  await userEvent.click(conditions.getByRole("button", { name: "Создать проект" }));
  expect(await conditions.findByText(/NewRule.*PROPERTY_VIOLATED/)).toBeVisible();
  expect(p.createGeneration).toHaveBeenLastCalledWith(version, expect.objectContaining({
    allowUnverified: false,
    applicationMode: "agent",
    technicalConditions: expect.objectContaining({ storage: "sqlite", api_prefix: "/api/v1" }),
  }), expect.any(String), expect.any(AbortSignal));
});

it("переключает сохранённую генерацию по ссылке и сообщает об отсутствующей", async () => {
  const p = createRecordedCodegenProvider();
  const newer = { ...g, generation_id: "gen_newer" };
  p.listGenerations = async (ref) => ref.number === version.number ? [g, newer] : [];
  p.listTestRuns = async () => [];
  const readFile = p.readFile;
  p.readFile = vi.fn(async (_id, path, signal) => readFile(g.generation_id, path, signal));
  const view = render(<ProjectFilesView provider={p} currentVersion={version} />);
  const picker = await screen.findByRole("combobox", { name: "Генерация" });
  expect(picker).toHaveValue(newer.generation_id);

  const focus = { generationId: g.generation_id, versionId: version.id, path: "app/rules.py", lines: { start: 34, end: 34 } };
  view.rerender(<ProjectFilesView provider={p} currentVersion={version} focus={focus} />);
  expect(picker).toHaveValue(g.generation_id);
  const code = await screen.findByLabelText("Содержимое app/rules.py");
  expect(code.querySelector('[data-line="34"]')).toHaveClass("is-marked");
  expect(p.readFile).toHaveBeenLastCalledWith(g.generation_id, focus.path, expect.any(AbortSignal));
  await userEvent.selectOptions(picker, newer.generation_id);
  expect(picker).toHaveValue(newer.generation_id);
  view.rerender(<ProjectFilesView provider={p} currentVersion={version} focus={{ ...focus, generationId: "missing" }} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/missing.*не найдена/);
  expect(picker).toHaveValue("");
  expect(screen.queryByRole("tree")).toBeNull();
  expect(screen.queryByLabelText(/Содержимое/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Скачать проект" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Запустить тесты" })).toBeNull();
  await userEvent.selectOptions(picker, newer.generation_id);
  expect(picker).toHaveValue(newer.generation_id);
  expect(screen.getByRole("button", { name: "Скачать проект" })).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();

  view.rerender(<ProjectFilesView provider={p} currentVersion={{ ...version, id: "new_version", number: version.number + 1 }} focus={focus} />);
  expect(await screen.findByText(/ещё нет сгенерированного/)).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<ProjectFilesView provider={p} currentVersion={version} focus={focus} />);
  expect(await screen.findByRole("combobox", { name: "Генерация" })).toHaveValue(g.generation_id);
  expect(await screen.findByLabelText("Содержимое app/rules.py")).toBeVisible();
});

it("открывает файл из дерева после несовпадения хеша в ссылке", async () => {
  const provider = createRecordedCodegenProvider();
  provider.readFile = vi.fn(provider.readFile);
  const focus = { generationId: g.generation_id, path: "app/rules.py", sha256: "0".repeat(64) };
  render(<ProjectFilesView provider={provider} currentVersion={version} focus={focus} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/хешем в ссылке из чата/);
  expect(provider.readFile).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("treeitem", { name: "rules.py" }));
  expect(await screen.findByLabelText("Содержимое app/rules.py")).toBeVisible();
  expect(provider.readFile).toHaveBeenCalledExactlyOnceWith(g.generation_id, focus.path, expect.any(AbortSignal));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("на 640px открывает код с клавиатуры и позволяет вернуться к дереву", async () => {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: media === "(max-width: 640px)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  try {
    render(<ProjectFilesView provider={createRecordedCodegenProvider()} currentVersion={version} />);
    const tree = await screen.findByRole("tree");
    const file = within(tree).getByRole("treeitem", { name: "requirements.txt" });
    expect(screen.queryByRole("separator", { name: "Ширина дерева файлов" })).toBeNull();
    expect(screen.queryByLabelText(/Содержимое/)).toBeNull();
    file.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByLabelText("Содержимое requirements.txt")).toBeVisible();
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByRole("button", { name: "Код", pressed: true })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Файлы" }));
    expect(within(screen.getByRole("tree")).getByRole("treeitem", {
      name: "requirements.txt", selected: true,
    })).toBeVisible();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("повторяет опрос по ID локального запуска после ошибки и игнорирует запоздавшую историю", async () => {
  const p = createRecordedCodegenProvider();
  let finishList!: (runs: TestRun[]) => void;
  p.listTestRuns = vi.fn(() => new Promise<TestRun[]>((resolve) => { finishList = resolve; }));
  const started: TestRun = { ...run, test_run_id: "local_run", status: "queued" };
  p.startTestRun = vi.fn().mockResolvedValue(started);
  p.getTestRun = vi.fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce({ ...started, status: "running" })
    .mockResolvedValueOnce({ ...started, status: "passed" });
  render(<ProjectFilesView provider={p} currentVersion={version} />);
  const start = await screen.findByRole("button", { name: "Запустить тесты" });
  await waitFor(() => expect(p.listTestRuns).toHaveBeenCalled());

  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(start); });
    expect(p.startTestRun).toHaveBeenCalledWith(g.generation_id, expect.any(String));
    await act(async () => { finishList([run]); });
    expect(screen.getByText("Тесты в очереди")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(p.getTestRun).toHaveBeenCalledTimes(1);
    expect(start).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(p.getTestRun).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Тесты выполняются")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("Тесты пройдены")).toBeVisible();
    expect(vi.mocked(p.getTestRun).mock.calls.map(([id]) => id)).toEqual(Array(3).fill("local_run"));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(p.getTestRun).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["ответ", "ошибка"])("оставляет запоздавший журнал за исходным ID запуска (%s)", async (outcome) => {
  const p = createRecordedCodegenProvider();
  let finishOld!: (text: string) => void;
  let failOld!: (cause: ApiError) => void;
  const oldLog = new Promise<string>((resolve, reject) => {
    finishOld = resolve;
    failOld = reject;
  });
  p.getTestLog = vi.fn().mockReturnValueOnce(oldLog).mockResolvedValueOnce("Журнал нового запуска");
  p.startTestRun = vi.fn().mockResolvedValue({ ...run, test_run_id: "new_run" });
  render(<ProjectFilesView provider={p} currentVersion={version} />);
  await userEvent.click(await screen.findByRole("button", { name: "Журнал pytest" }));
  expect(p.getTestLog).toHaveBeenCalledWith(run.test_run_id, expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("button", { name: "Запустить тесты" }));
  await userEvent.click(await screen.findByRole("button", { name: "Журнал pytest" }));
  expect(p.getTestLog).toHaveBeenLastCalledWith("new_run", expect.any(AbortSignal));
  expect(await screen.findByText("Журнал нового запуска")).toBeVisible();
  await act(async () => {
    if (outcome === "ответ") finishOld("Старый журнал");
    else failOld(new ApiError(503, "LOG_UNAVAILABLE", "Старый журнал недоступен"));
  });
  expect(screen.queryByText(/Старый журнал/)).toBeNull();
  expect(screen.getByText("Журнал нового запуска")).toBeVisible();
});

it("сравнивает выбранный снимок с выбранной генерацией и открывает расхождения и журнал", async () => {
  const p = createRecordedCodegenProvider();
  const snapshot = { id: "snapshot_2", manifest_sha256: "a".repeat(64), commit_sha: "b".repeat(40), remote_url: "https://example.test/project" };
  const result: CandidateComparison = {
    snapshot_id: snapshot.id,
    manifest_sha256: snapshot.manifest_sha256,
    commit_sha: snapshot.commit_sha,
    reference_code_hash: g.code_hash,
    code_hash: "c".repeat(64),
    tests_hash: "d".repeat(64),
    adapter: { kind: "fastapi-evaluate-v1", module: "candidate.api", api_prefix: "/api/v1" },
    status: "pending",
    differences: [],
  };
  const pending: TestRun = { ...run, code_hash: result.code_hash, comparison: result, test_run_id: "cmp_new", status: "queued", log_available: false };
  const mismatch: TestRun = { ...pending, status: "failed", log_available: true, comparison: {
    ...result, status: "mismatch",
    differences: [{ scenario_id: "guard-disabled", transition_id: "Approve", requirement_ids: ["R-01"], message: "expected 409" }],
  } };
  const saved: TestRun = { ...pending, test_run_id: "cmp_saved", status: "passed", comparison: { ...result, status: "matches" } };
  const comparisons = {
    listSnapshots: vi.fn(async () => [{ ...snapshot, id: "snapshot_1" }, snapshot]),
    list: vi.fn(async () => [saved]),
    start: vi.fn(async () => pending),
  };
  p.getTestRun = vi.fn(async () => mismatch);
  p.getTestLog = vi.fn(async () => "Код кандидата вернул 200");
  render(<ProjectFilesView provider={{ ...p, comparisons }} currentVersion={version} />);
  await userEvent.click(await screen.findByText("Сравнить с репозиторием"));
  const picker = await screen.findByRole("combobox", { name: "Снимок репозитория" });
  expect(comparisons.listSnapshots).toHaveBeenCalledWith(g.session_id, expect.any(AbortSignal));
  expect(comparisons.list).toHaveBeenCalledWith(g.generation_id, expect.any(AbortSignal));
  expect(await screen.findByText("Совпадает на проверенных сценариях")).toBeVisible();
  await userEvent.selectOptions(picker, snapshot.id);
  await userEvent.type(screen.getByRole("textbox", { name: "Модуль Python" }), "candidate.api");
  await userEvent.type(screen.getByRole("textbox", { name: "Префикс API кандидата" }), "/api/v1");
  const start = screen.getByRole("button", { name: "Запустить сравнение" });
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(start); });
    expect(comparisons.start).toHaveBeenCalledWith(g.generation_id, {
      snapshot_id: snapshot.id, manifest_sha256: snapshot.manifest_sha256,
      reference_code_hash: g.code_hash, adapter: result.adapter,
    }, expect.any(String));
    expect(screen.getByText("Сравнение в очереди")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(p.getTestRun).toHaveBeenCalledWith("cmp_new", expect.any(AbortSignal));
    expect(screen.getByText("Есть расхождения с моделью")).toBeVisible();
    expect(screen.getByText("guard-disabled").closest("li")).toHaveTextContent(/Approve.*R-01.*expected 409/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Журнал сравнения" })); });
    expect(p.getTestLog).toHaveBeenCalledWith("cmp_new", expect.any(AbortSignal));
    expect(screen.getByText("Код кандидата вернул 200")).toBeVisible();

    const imported = { ...snapshot, id: "snapshot_imported", commit_sha: "e".repeat(40) };
    comparisons.listSnapshots.mockResolvedValueOnce([snapshot, imported]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Обновить данные сравнения" })); });
    expect(comparisons.listSnapshots).toHaveBeenCalledTimes(2);
    expect(within(picker).getByRole("option", { name: /snapshot_imported/ })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: imported.id } });
    expect(picker).toHaveValue(imported.id);
    const displayed = within(screen.getByRole("region", { name: "Результат сравнения" }));
    expect(displayed.getByText("Есть расхождения с моделью")).toBeVisible();
    expect(displayed.getByText(snapshot.id)).toBeVisible();
    expect(displayed.getByText(snapshot.commit_sha.slice(0, 12))).toBeVisible();
    expect(displayed.queryByText(imported.id)).toBeNull();
    expect(displayed.getByText("Код кандидата вернул 200")).toBeVisible();

    fireEvent.change(screen.getByRole("combobox", { name: "Сохранённое сравнение" }), { target: { value: "cmp_saved" } });
    expect(screen.queryByText("Код кандидата вернул 200")).toBeNull();
    expect(screen.getByText("Совпадает на проверенных сценариях")).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

it("недоступная Docker-песочница блокирует запуск, оставляя просмотр и экспорт", async () => {
  const p = createRecordedCodegenProvider();
  const available = await p.status();
  if (!available.available) throw new Error();
  p.status = async () => ({
    available: true,
    status: {
      ...available.status,
      sandbox_status: "engine_unavailable",
      sandbox_reason: "Нет Docker",
    },
  });
  render(<ProjectFilesView provider={p} currentVersion={version} />);
  expect(await screen.findByText("Нет Docker")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Запустить тесты" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Скачать проект" })).toBeEnabled();
});
it("сообщает о настоящем 404 файла и не показывает код", async () => {
  const p = createRecordedCodegenProvider();
  p.readFile = async () => {
    throw new ApiError(404, "FILE_NOT_FOUND", "missing");
  };
  render(<ProjectFilesView provider={p} currentVersion={version} />);
  expect(await screen.findByText(/Файл указан в manifest/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Содержимое/)).not.toBeInTheDocument();
});
it("pointer dragging ограничивается min/max и сохраняется", () => {
  localStorage.clear();
  render(
    <SplitPane label="Drag" storageKey="drag">
      {[<p key="1">one</p>, <p key="2">two</p>]}
    </SplitPane>,
  );
  const sep = screen.getByRole("separator");
  const captured = new Set<number>();
  sep.setPointerCapture = (id) => {
    captured.add(id);
  };
  sep.hasPointerCapture = (id) => captured.has(id);
  sep.releasePointerCapture = (id) => {
    captured.delete(id);
  };
  sep.parentElement!.getBoundingClientRect = () =>
    ({ width: 1000, height: 500, left: 0, top: 0 }) as DOMRect;
  const event = (type: string, x: number) => {
    const e = new Event(type, { bubbles: true });
    Object.defineProperties(e, {
      button: { value: 0 },
      pointerId: { value: 1 },
      clientX: { value: x },
      clientY: { value: 0 },
    });
    fireEvent(sep, e);
  };
  event("pointerdown", 200);
  event("pointermove", 900);
  expect(sep).toHaveAttribute("aria-valuenow", "70");
  event("pointerup", 900);
  event("pointermove", 100);
  expect(sep).toHaveAttribute("aria-valuenow", "70");
  expect(localStorage.getItem("drag")).toBe("70");
});
it("изменение callback загрузки не создаёт цикл уведомлений хоста", async () => {
  const p = createRecordedCodegenProvider(),
    callback = vi.fn();
  const v = render(
    <ProjectFilesView
      provider={p}
      currentVersion={version}
      onManifestLoaded={callback}
    />,
  );
  await waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  v.rerender(
    <ProjectFilesView
      provider={p}
      currentVersion={version}
      onManifestLoaded={(g) => callback(g)}
    />,
  );
  await screen.findByText(/Версия.*файлов/);
  expect(callback).toHaveBeenCalledTimes(1);
});

it("asks about the verified selected file without submitting or generating",async()=>{
  const p=createRecordedCodegenProvider();p.startTestRun=vi.fn();p.createGeneration=vi.fn();
  const ask=vi.fn();render(<ProjectFilesView provider={p} currentVersion={version} focus={{path:"app/rules.py"}} onAskFile={ask}/>);
  await screen.findByLabelText("Содержимое app/rules.py");
  await userEvent.click(screen.getByRole("button",{name:"Спросить агента о файле"}));
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({generation_id:g.generation_id,version_id:g.version_id}),expect.objectContaining({path:"app/rules.py",sha256:g.files.find(f=>f.path==="app/rules.py")!.sha256}));
  expect(p.startTestRun).not.toHaveBeenCalled();expect(p.createGeneration).not.toHaveBeenCalled();
});
