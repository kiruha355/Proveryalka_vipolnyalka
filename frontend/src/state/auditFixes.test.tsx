import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProveryalkaApi } from "../api/api";
import { DemoApi } from "../api/demo";
import { ApiError, describeError } from "../api/errors";
import type { CheckRun, DialogueView, ModelVersion, Question, Run, RunEvent, Session } from "../api/types";
import { App } from "../App";
import { registerCoreViews } from "../app/coreViews";
import { resetExtensions } from "../app/extensions";
import { NewChat } from "../components/NewChat";
import { loadLocal, updateLocal } from "./persist";
import { useSessionWorkspace } from "./useSessionWorkspace";

const sid = "demo_s_order";
const baseCaps = {
  adapter: "http" as const,
  agent: true,
  questionId: true,
  customLimits: true,
  artifacts: false,
  checkDiscovery: false,
  documents: true,
  documentSessions: true,
  dialogue: true,
  explanations: false,
};

const emptyDialogue = (): DialogueView => ({
  session_id: sid,
  status: "not_started",
  round: null,
  max_rounds: null,
  reply: null,
  requirements: [],
  questions: [],
  open_question_ids: [],
  corrections: [],
  analysis: null,
  model: null,
  pending: null,
  entries: [],
});

const runEvent = (runId: string, type: RunEvent["type"], id = 1, data: Record<string, unknown> = { state: "completed" }): RunEvent => ({
  run_id: runId,
  session_id: sid,
  event_id: id,
  type,
  data,
});

function makeApi() {
  const api: ProveryalkaApi = new DemoApi();
  api.capabilities = vi.fn(async () => baseCaps);
  api.getDialogue = vi.fn(async () => emptyDialogue());
  api.getRun = vi.fn<ProveryalkaApi["getRun"]>(async (id) => ({
    run_id: id,
    session_id: sid,
    state: "completed",
    version_id: null,
    error_code: null,
  }));
  api.streamEvents = async function* (id) {
    yield runEvent(id, "run_finished");
  };
  return api;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetExtensions();
  registerCoreViews();
});

describe("UX [9] + F07: version checks discovery and direct check links", () => {
  it("discovers checks via listCheckRuns with modelId and version number", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
    const listCheckRuns = vi.fn<NonNullable<ProveryalkaApi["listCheckRuns"]>>(async (ref) => (ref.id === version.id ? ["chk_srv_1", "chk_srv_2"] : []));
    api.listCheckRuns = listCheckRuns;
    api.getCheck = vi.fn(async (id: string) => ({ ...report, run: { ...report.run, run_id: id, version_id: version.id } }));
    updateLocal(api.id, sid, (local) => ({
      ...local,
      checkRuns: [{
        runId: "chk_srv_2", versionId: version.id, modelId: version.model_id,
        number: version.number, propertyIds: null, startedAt: "2026-11-21T00:00:00Z",
      }],
    }));

    const { result } = renderHook(() =>
      useSessionWorkspace({ api, capabilities: { ...baseCaps, checkDiscovery: true }, sessionId: sid }),
    );
    await waitFor(() => expect(result.current.checks.map((c) => c.runId)).toEqual(["chk_srv_2", "chk_srv_1"]));
    expect(listCheckRuns).toHaveBeenCalledWith(version, expect.any(AbortSignal));
    await waitFor(() => expect(result.current.checks[0]?.results?.length).toBeGreaterThan(0));
  });

  it("loads a direct route.check URL even without checkDiscovery or localStorage, showing loading/error instead of empty state", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
    let resolveCheck!: (value: CheckRun) => void;
    api.getCheck = vi.fn(() => new Promise<CheckRun>((resolve) => { resolveCheck = resolve; }));

    window.location.hash = `#/s/${sid}?m=${version.model_id}&v=${version.number}&view=check&check=chk_direct`;
    render(<App initialApi={api} />);

    expect(await screen.findByText("Загрузка результата проверки")).toBeInTheDocument();
    expect(screen.queryByText(/ещё не проверялась/)).toBeNull();
    expect(api.getCheck).toHaveBeenCalledWith("chk_direct", expect.any(AbortSignal));

    await act(async () => {
      resolveCheck({ ...report, run: { ...report.run, run_id: "chk_direct", version_id: version.id } });
    });
    expect(await screen.findByRole("list", { name: "Проверяемые правила" })).toBeInTheDocument();
  });

  it("shows error notice (not empty state) when a direct route.check URL returns 404", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    api.getCheck = vi.fn(async () => {
      throw new ApiError("http", "Check not found", { status: 404, code: "NOT_FOUND" });
    });

    window.location.hash = `#/s/${sid}?m=${version.model_id}&v=${version.number}&view=check&check=chk_missing`;
    render(<App initialApi={api} />);

    expect(await screen.findByText("Результат проверки не загружен")).toBeInTheDocument();
    expect(screen.queryByText(/ещё не проверялась/)).toBeNull();
  });

  it("shows loading and a per-version list error, then retries that version", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const [runId] = await (api as DemoApi).listCheckRuns(version.id);
    let rejectList!: (error: Error) => void;
    let attempts = 0;
    api.capabilities = vi.fn(async () => ({ ...baseCaps, checkDiscovery: true }));
    const list = vi.fn<NonNullable<ProveryalkaApi["listCheckRuns"]>>(async (ref) => {
      if (ref.id !== version.id) return [];
      if (++attempts > 1) return [runId!];
      return new Promise((_, reject) => { rejectList = reject; });
    });
    api.listCheckRuns = list;

    window.location.hash = `#/s/${sid}?m=${version.model_id}&v=1&view=check`;
    render(<App initialApi={api} />);
    expect(await screen.findByText("Загрузка списка проверок версии")).toBeInTheDocument();
    expect(screen.queryByText(/ещё не проверялась/)).toBeNull();
    await act(async () => rejectList(new ApiError("network", "Unavailable")));
    expect(await screen.findByText("Список проверок версии не загружен")).toBeInTheDocument();
    expect(screen.queryByText(/ещё не проверялась/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("list", { name: "Проверяемые правила" })).toBeInTheDocument();
    expect(list.mock.calls.filter(([ref]) => ref.id === version.id)).toHaveLength(2);
  });

  it.each([false, true])("refreshes the stale version list for a check-only link (refresh fails first: %s)", async (fails) => {
    const api = makeApi();
    const stale = await api.listVersions("demo_m_order");
    const base = stale[0]!;
    const version = { ...base, id: "v3", number: 3, parent_id: stale[1]!.id };
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(base.id))[0]!);
    const id = "check_v3";
    const versions = vi.fn<ProveryalkaApi["listVersions"]>()
      .mockResolvedValueOnce(stale);
    if (fails) versions.mockRejectedValueOnce(new ApiError("network", "Versions unavailable"));
    versions.mockResolvedValue([...stale, version]);
    api.listVersions = versions;
    api.getCheck = vi.fn(async () => ({
      ...report,
      run: { ...report.run, run_id: id, version_id: version.id },
      results: report.results.map((result) => ({ ...result, version_id: version.id })),
    }));

    window.location.hash = `#/s/${sid}?check=${id}`;
    render(<App initialApi={api} />);
    if (fails) {
      expect(await screen.findByText("Версия отчёта не загружена")).toBeInTheDocument();
      expect(screen.queryByText("Отчёт недоступен для выбранной версии")).toBeNull();
      expect(window.location.hash).toContain(`check=${id}`);
      fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    }
    expect(await screen.findByRole("list", { name: "Проверяемые правила" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Версия модели" })).toHaveValue(version.id);
    expect(versions).toHaveBeenCalledTimes(fails ? 3 : 2);
    expect(api.getCheck).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toContain(`check=${id}`);
  });

  it("keeps an explicit missing Demo ID while other reports load and allows closing the error", async () => {
    const api = new DemoApi();
    const getCheck = vi.spyOn(api, "getCheck");
    const missing = "missing_demo_check";
    window.location.hash = `#/s/${sid}?m=demo_m_order&v=1&check=${missing}`;
    render(<App initialApi={api} />);

    expect(await screen.findByText("Результат проверки не загружен")).toBeInTheDocument();
    await waitFor(() => expect(getCheck.mock.calls.some(([id]) => id !== missing)).toBe(true));
    expect(screen.queryByText("Загрузка результата проверки")).toBeNull();
    expect(screen.queryByRole("list", { name: "Проверяемые правила" })).toBeNull();
    expect(window.location.hash).toContain(`check=${missing}`);

    fireEvent.click(screen.getByRole("button", { name: "Закрыть отчёт" }));
    expect(await screen.findByRole("list", { name: "Проверяемые правила" })).toBeInTheDocument();
    expect(window.location.hash).not.toContain(missing);
  });

  it.each([
    ["version_id", "another_version", "Отчёт недоступен для выбранной версии"],
    ["session_id", "another_session", "Отчёт относится к другой сессии или проверке."],
  ])("shows a terminal error if the explicitly linked report has a different %s", async (field, value, message) => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
    const id = "chk_mismatch";
    api.getCheck = vi.fn(async () => ({ ...report, run: { ...report.run, run_id: id, [field]: value } }));
    window.location.hash = `#/s/${sid}?m=${version.model_id}&v=${version.number}&view=check&check=${id}`;
    render(<App initialApi={api} />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть отчёт" })).toBeEnabled();
    expect(screen.queryByText("Загрузка результата проверки")).toBeNull();
    expect(screen.queryByRole("list", { name: "Проверяемые правила" })).toBeNull();
    expect(window.location.hash).toContain(`check=${id}`);
  });
});

describe("UX [5]: ModelView manual version warning and explicit guard diff", () => {
  it("does not warn about newer agent analysis after a manual edit and renders old -> new guard expressions", async () => {
    const api = makeApi();
    const baseVersions = await api.listVersions("demo_m_order");
    const v1 = baseVersions[0]!;
    const v2Spec = structuredClone(v1.spec);
    const execTransition = v2Spec.transitions.find((t) => t.id === "Execute")!;
    execTransition.guard = {
      kind: "binary",
      op: "and",
      left: execTransition.guard,
      right: { kind: "binary", op: "eq", left: { kind: "variable", name: "status" }, right: { kind: "literal", value: "Approved" } },
    };
    const v2: ModelVersion = {
      ...v1,
      id: "v_manual_2",
      number: 2,
      parent_id: v1.id,
      spec: v2Spec,
      spec_hash: "manual-hash-2",
      approved: false,
    };
    api.listVersions = vi.fn(async () => [v1, v2]);
    api.getDialogue = vi.fn(async (): Promise<DialogueView> => ({
      ...emptyDialogue(),
      status: "ready",
      model: { model_id: v1.model_id, version_id: v1.id, number: 1, spec_hash: v1.spec_hash },
      analysis: {
        subject: "Заявка",
        source: v1.spec.sources[0]!,
        requirements: v1.spec.requirements,
        entities: [],
        participants: [],
        initial_state: [],
        properties: [],
        assumptions: [],
        contradictions: [],
        missing_information: [],
        behavior: v1.spec,
        model_issues: [],
      },
    }));

    window.location.hash = `#/s/${sid}?m=${v2.model_id}&v=2&view=model`;
    render(<App initialApi={api} />);

    const diff = await screen.findByRole("region", { name: "Изменения относительно версии 1" });
    expect(diff.textContent).toContain("approved = true → approved = true и status = Approved");
    expect(diff.textContent).not.toContain("также условие");
    expect(screen.queryByText(/Агент (уточняет модель|предложил версию)/)).toBeNull();
    expect(screen.queryByText(/новая версия появится/)).toBeNull();
  });
});

describe("F01: chat draft protection on late POST response", () => {
  it("preserves new draft typed in ChatPanel while sendMessage POST is still in-flight", async () => {
    const api = makeApi();
    let resolveSend!: (run: Run) => void;
    api.sendMessage = vi.fn(() => new Promise<Run>((resolve) => { resolveSend = resolve; }));

    window.location.hash = `#/s/${sid}`;
    render(<App initialApi={api} />);

    const input = await screen.findByRole("textbox", { name: "Сообщение агенту" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Первое сообщение" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    // While POST is still pending, user edits the composer to a new draft.
    fireEvent.change(input, { target: { value: "Новое уточнение" } });
    await act(async () => {
      resolveSend({ run_id: "agent_late", session_id: sid, state: "completed", version_id: null, error_code: null });
    });

    expect(input.value).toBe("Новое уточнение");
    expect(loadLocal(api.id, sid).draft).toBe("Новое уточнение");
  });

  it("preserves the draft and its file context if the text changed and was typed back during POST", async () => {
    const api = makeApi();
    const fileContext = { generation_id: "g_1", path: "src/rules.py", version_id: "v_1", sha256: "a".repeat(64) };
    updateLocal(api.id, sid, (local) => ({ ...local, draft: "Вопрос о файле", draftFileContext: fileContext }));
    let resolveSend!: (run: Run) => void;
    api.sendMessage = vi.fn(() => new Promise<Run>((resolve) => { resolveSend = resolve; }));

    window.location.hash = `#/s/${sid}`;
    render(<App initialApi={api} />);
    const input = await screen.findByRole("textbox", { name: "Сообщение агенту" });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    fireEvent.change(input, { target: { value: "Другая формулировка" } });
    fireEvent.change(input, { target: { value: "Вопрос о файле" } });
    await act(async () => {
      resolveSend({ run_id: "agent_file", session_id: sid, state: "completed", version_id: null, error_code: null });
    });

    expect(input).toHaveValue("Вопрос о файле");
    expect(loadLocal(api.id, sid)).toMatchObject({ draft: "Вопрос о файле", draftFileContext: fileContext, outbox: null });
  });

  it("carries over draft edited in NewChat while createSession is in-flight", async () => {
    const api = makeApi();
    let resolveSession!: (s: Session) => void;
    api.createSession = vi.fn(() => new Promise<Session>((resolve) => { resolveSession = resolve; }));
    const onCreated = vi.fn();

    render(<NewChat api={api} capabilities={baseCaps} onCreated={onCreated} />);
    const input = screen.getByRole("textbox", { name: "Описание поведения" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Первая версия описания" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    fireEvent.change(input, { target: { value: "Добавил ещё правило" } });
    await act(async () => {
      resolveSession({ id: "s_new_1", title: "Первая версия описания", mode: "analyzer", created_at: "2026-11-21T00:00:00Z" });
    });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(loadLocal(api.id, "s_new_1").draft).toBe("Добавил ещё правило");
  });

  it("keeps the newer same-text draft when retrying new chat creation", async () => {
    const api = makeApi();
    let rejectCreate!: (error: Error) => void;
    const create = vi.fn<ProveryalkaApi["createSession"]>()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectCreate = reject; }))
      .mockResolvedValue({ id: "s_retry", title: "Правила", mode: "analyzer", created_at: "2026-11-21T00:00:00Z" });
    api.createSession = create;
    const onCreated = vi.fn();
    render(<NewChat api={api} capabilities={baseCaps} onCreated={onCreated} />);
    const input = screen.getByRole("textbox", { name: "Описание поведения" });
    fireEvent.change(input, { target: { value: "Правила" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    fireEvent.change(input, { target: { value: "Дополнение" } });
    fireEvent.change(input, { target: { value: "Правила" } });
    await act(async () => rejectCreate(new ApiError("network", "Lost response")));
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const local = loadLocal(api.id, "s_retry");
    expect(local.draft).toBe("Правила");
    expect(local.outbox?.draftRevision).not.toBe(local.draftRevision);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  });

  it.each([true, false])("uses the original edit revision on retry after remount (edited: %s)", async (edited) => {
    const api = makeApi();
    const context = { generation_id: "g_1", path: "rules.py", version_id: "v1", sha256: "a".repeat(64) };
    let rejectSend!: (error: Error) => void;
    const send = vi.fn<ProveryalkaApi["sendMessage"]>()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectSend = reject; }))
      .mockResolvedValue({ run_id: "retried", session_id: sid, state: "completed", version_id: null, error_code: null });
    api.sendMessage = send;
    updateLocal(api.id, sid, (local) => ({ ...local, draft: "Исходный вопрос", draftFileContext: context }));
    window.location.hash = `#/s/${sid}`;
    const first = render(<App initialApi={api} />);
    const input = await screen.findByRole("textbox", { name: "Сообщение агенту" });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const submittedRevision = loadLocal(api.id, sid).outbox?.draftRevision;
    expect(submittedRevision).toBeTruthy();
    if (edited) {
      fireEvent.change(input, { target: { value: "Промежуточный текст" } });
      fireEvent.change(input, { target: { value: "Исходный вопрос" } });
    }
    await act(async () => rejectSend(new ApiError("network", "Lost response")));
    expect(loadLocal(api.id, sid).outbox?.draftRevision).toBe(submittedRevision);
    first.unmount();

    render(<App initialApi={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить отправку" }));
    await waitFor(() => expect(loadLocal(api.id, sid).outbox).toBeNull());
    expect(screen.getByRole("textbox", { name: "Сообщение агенту" })).toHaveValue(edited ? "Исходный вопрос" : "");
    expect(loadLocal(api.id, sid)).toMatchObject({
      draft: edited ? "Исходный вопрос" : "",
      draftFileContext: edited ? context : null,
    });
    expect(send.mock.calls[0]!.slice(1, 3)).toEqual(send.mock.calls[1]!.slice(1, 3));
  });
});

describe("F05 + F06: cancel races and check report fetch retry", () => {
  it("never rolls back a terminal agent run on late cancel response and allows cancelling again after a failure", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    let resolveCancel!: (run: Run) => void;
    const cancelRun = vi.fn<ProveryalkaApi["cancelRun"]>()
      .mockRejectedValueOnce(new ApiError("network", "Cancel failed"))
      .mockImplementationOnce(() => new Promise<Run>((resolve) => { resolveCancel = resolve; }));
    api.cancelRun = cancelRun;

    let finishStream!: () => void;
    api.streamEvents = async function* (id) {
      yield runEvent(id, "activity", 1, { phase: "started" });
      await new Promise<void>((resolve) => { finishStream = resolve; });
      yield runEvent(id, "run_finished", 2, { state: "completed" });
    };
    api.sendMessage = vi.fn(async (): Promise<Run> => ({
      run_id: "agent_1",
      session_id: sid,
      state: "running",
      version_id: null,
      error_code: null,
    }));

    const { result } = renderHook(() => useSessionWorkspace({ api, capabilities: baseCaps, sessionId: sid }));
    await waitFor(() => expect(result.current.detail.loading).toBe(false));
    await act(async () => { await result.current.sendMessage("Привет", null); });
    expect(result.current.activeAgentRun?.runId).toBe("agent_1");

    // 1. Cancel fails -> cancelRequested resets to false.
    await act(async () => { await result.current.cancelAgent(); });
    expect(result.current.activeAgentRun?.cancelRequested).toBe(false);
    expect(result.current.activeAgentRun?.cancelError).toBeInstanceOf(ApiError);
    expect(result.current.send.error).toBeNull();

    // 2. Second cancel starts, meanwhile SSE completes the run, then late cancel response returns "cancelling".
    let cancelPromise!: Promise<void>;
    act(() => { cancelPromise = result.current.cancelAgent(); });
    expect(result.current.activeAgentRun?.cancelRequested).toBe(true);
    await act(async () => { finishStream(); });
    await waitFor(() => expect(result.current.lastAgentRun?.run?.state).toBe("completed"));

    await act(async () => {
      resolveCancel({ run_id: "agent_1", session_id: sid, state: "cancelling", version_id: version.id, error_code: "CANCELLED" });
      await cancelPromise;
    });
    // Terminal state must not be rolled back to cancelling.
    expect(result.current.lastAgentRun?.run?.state).toBe("completed");
  });

  it("ignores a cancel failure that arrives after the agent run finished", async () => {
    const api = makeApi();
    let rejectCancel!: (error: Error) => void;
    let finishStream!: () => void;
    api.sendMessage = vi.fn(async (): Promise<Run> => ({
      run_id: "agent_done", session_id: sid, state: "running", version_id: null, error_code: null,
    }));
    api.cancelRun = vi.fn(() => new Promise<Run>((_, reject) => { rejectCancel = reject; }));
    api.streamEvents = async function* (id) {
      await new Promise<void>((resolve) => { finishStream = resolve; });
      yield runEvent(id, "run_finished");
    };
    const { result } = renderHook(() => useSessionWorkspace({ api, capabilities: baseCaps, sessionId: sid }));
    await act(async () => { await result.current.sendMessage("Сообщение", null); });
    act(() => { void result.current.cancelAgent(); });
    await act(async () => finishStream());
    await waitFor(() => expect(result.current.activeAgentRun).toBeNull());
    await act(async () => rejectCancel(new ApiError("network", "Late failure")));
    expect(result.current.lastAgentRun?.cancelError).toBeNull();
    expect(result.current.send.error).toBeNull();
  });

  it("keeps a completed check terminal while GET requests are pending and a stale cancel response arrives", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
    const running: Run = { ...report.run, run_id: "chk_cancel", state: "running" };
    const completed: Run = { ...running, state: "completed" };
    let resolveCancel!: (run: Run) => void;
    let resolveReport!: (check: CheckRun) => void;
    let finishStream!: () => void;
    let resolveRun!: (run: Run) => void;
    api.createCheck = vi.fn(async () => running);
    api.getCheck = vi.fn(() => new Promise<CheckRun>((resolve) => { resolveReport = resolve; }));
    api.getRun = vi.fn(() => new Promise<Run>((resolve) => { resolveRun = resolve; }));
    api.cancelRun = vi.fn<ProveryalkaApi["cancelRun"]>()
      .mockRejectedValueOnce(new ApiError("network", "Cancel failed"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCancel = resolve; }));
    api.streamEvents = async function* (id) {
      await new Promise<void>((resolve) => { finishStream = resolve; });
      yield runEvent(id, "run_finished");
    };

    const { result } = renderHook(() => useSessionWorkspace({ api, capabilities: baseCaps, sessionId: sid }));
    await act(async () => { await result.current.startCheck(version, null, report.results[0]!.limits); });
    await act(async () => { await result.current.cancelCheck(running.run_id); });
    expect(result.current.checks[0]?.cancelRequested).toBe(false);
    expect(result.current.checks[0]?.cancelError).toBeInstanceOf(ApiError);
    expect(result.current.checks[0]?.resultsError).toBeNull();

    act(() => { void result.current.cancelCheck(running.run_id); });
    await act(async () => { finishStream(); });
    expect(result.current.checks[0]?.run?.state).toBe("completed");
    await act(async () => { resolveCancel({ ...running, state: "cancelling" }); });
    expect(result.current.checks[0]?.run?.state).toBe("completed");
    await act(async () => {
      resolveRun(completed);
      resolveReport({ ...report, run: completed });
    });
    expect(result.current.checks[0]?.results?.length).toBeGreaterThan(0);
    expect(result.current.checks[0]?.cancelError).toBeNull();
  });

  it("retries GET /checks/{id} via fetchCheck (not SSE reconnect) and ignores stale check errors", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
    const streamSpy = vi.fn();
    api.streamEvents = async function* (id) {
      streamSpy(id);
      yield runEvent(id, "run_finished");
    };
    const getCheck = vi.fn<ProveryalkaApi["getCheck"]>()
      .mockRejectedValueOnce(new ApiError("network", "Temporary read error"))
      .mockResolvedValueOnce({ ...report, run: { ...report.run, run_id: "chk_retry", version_id: version.id } });
    api.getCheck = getCheck;

    window.location.hash = `#/s/${sid}?m=${version.model_id}&v=${version.number}&view=check&check=chk_retry`;
    render(<App initialApi={api} />);

    expect(await screen.findByText("Результат проверки не загружен")).toBeInTheDocument();
    expect(getCheck).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("list", { name: "Проверяемые правила" })).toBeInTheDocument();
    expect(getCheck).toHaveBeenCalledTimes(2);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("ignores stale rejected fetchCheck after a newer fetchCheck succeeds (F06 checkRequestSeq)", async () => {
    const api = makeApi();
    const version = (await api.listVersions("demo_m_order"))[0]!;
    const report = await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
    let rejectFirst!: (err: unknown) => void;
    let resolveSecond!: (value: CheckRun) => void;
    api.getCheck = vi.fn<ProveryalkaApi["getCheck"]>()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const { result } = renderHook(() => useSessionWorkspace({ api, capabilities: baseCaps, sessionId: sid }));
    await waitFor(() => expect(result.current.versions.length).toBeGreaterThan(0));

    act(() => { result.current.ensureCheck("chk_seq"); });
    act(() => { result.current.fetchCheck("chk_seq"); });

    await act(async () => {
      resolveSecond({ ...report, run: { ...report.run, run_id: "chk_seq", version_id: version.id } });
    });
    await waitFor(() => expect(result.current.checks[0]?.results?.length).toBeGreaterThan(0));

    await act(async () => {
      rejectFirst(new ApiError("network", "Stale failure"));
    });
    expect(result.current.checks[0]?.resultsError).toBeNull();
    expect(result.current.checks[0]?.results?.length).toBeGreaterThan(0);
  });
});

describe("UX [2] + [12]: pre-session file validation and friendly error messages", () => {
  it("rejects PDF before calling createSession and displays friendly Russian message without raw HTTP 415 code", async () => {
    const api = makeApi();
    const createSession = vi.fn<ProveryalkaApi["createSession"]>();
    const uploadDocument = vi.fn<NonNullable<ProveryalkaApi["createSessionWithDocument"]>>();
    api.createSession = createSession;
    api.createSessionWithDocument = uploadDocument;

    const { container } = render(<NewChat api={api} capabilities={baseCaps} onCreated={vi.fn()} />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const pdf = new File(["%PDF-1.4"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [pdf] } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Формат PDF не поддерживается. Выберите файл TXT, MD или DOCX.");
    expect(alert.textContent).not.toContain("HTTP 415");
    expect(alert.textContent).not.toContain("UNSUPPORTED_DOCUMENT");
    expect(createSession).not.toHaveBeenCalled();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it("creates a session and its first document through one request and reuses the key on retry", async () => {
    const api = makeApi();
    const createSession = vi.fn<ProveryalkaApi["createSession"]>();
    const uploadDocument = vi.fn<NonNullable<ProveryalkaApi["createSessionWithDocument"]>>()
      .mockRejectedValueOnce(new ApiError("http", "DOCX is invalid", { status: 422, code: "DOCUMENT_INVALID" }))
      .mockRejectedValueOnce(new ApiError("network", "Lost response"))
      .mockResolvedValueOnce({
        id: "s_with_document", title: "good.txt", mode: "analyzer", created_at: "2026-11-21T00:00:00Z",
      });
    api.createSession = createSession;
    api.createSessionWithDocument = uploadDocument;
    const onCreated = vi.fn();

    const { container } = render(<NewChat api={api} capabilities={baseCaps} onCreated={onCreated} />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, { target: { files: [new File(["bad"], "broken.docx")] } });
    await screen.findByRole("alert");
    expect(uploadDocument.mock.calls[0]![0].name).toBe("broken.docx");
    expect(onCreated).not.toHaveBeenCalled();

    const file = new File(["ok"], "good.txt");
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createSession).not.toHaveBeenCalled();
    expect(uploadDocument.mock.calls[1]).toEqual([file, expect.any(String)]);
    expect(uploadDocument.mock.calls[2]).toEqual(uploadDocument.mock.calls[1]);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s_with_document", title: "good.txt" }));
  });

  it("formats server UNSUPPORTED_DOCUMENT errors cleanly without raw HTTP 415 text", () => {
    const message = describeError(new ApiError("http", "Supported documents: .txt, .md, .docx", { status: 415, code: "UNSUPPORTED_DOCUMENT" }));
    expect(message).toContain("TXT, MD или DOCX");
    expect(message).not.toContain("HTTP 415");
    expect(message).not.toContain("UNSUPPORTED_DOCUMENT");
  });
});

describe("UX [10] + UX [3]: mobile pane restoration and jump to open question", () => {
  it("initializes active pane to workspace on reload when URL specifies view or check (UX [10])", async () => {
    const api = makeApi();
    window.location.hash = `#/s/${sid}?m=demo_m_order&v=1&view=model`;
    const first = render(<App initialApi={api} />);
    const workspaceBtn = await screen.findByRole("button", { name: "Модель и проверка" });
    expect(workspaceBtn).toHaveAttribute("aria-pressed", "true");
    expect(first.container.querySelector(".session")).toHaveClass("session--workspace");
    first.unmount();

    window.location.hash = `#/s/${sid}`;
    const second = render(<App initialApi={api} />);
    const chatBtn = await screen.findByRole("button", { name: "Чат" });
    expect(chatBtn).toHaveAttribute("aria-pressed", "true");
    expect(second.container.querySelector(".session")).toHaveClass("session--chat");
  });

  it("offers a compact jump button to the first open question and scrolls it into view (UX [3])", async () => {
    const api = makeApi();
    const q1: Question = {
      id: "q_1",
      text: "Может ли отменённая заявка быть исполнена?",
      reason: "Нужно уточнить запрет.",
      kind: "missing",
      assumption: null,
      status: "open",
      answer_source_id: null,
    };
    api.getDialogue = vi.fn(async (): Promise<DialogueView> => ({
      ...emptyDialogue(),
      status: "needs_clarification",
      questions: [q1],
      open_question_ids: ["q_1"],
      entries: [
        {
          id: "e_reply",
          sequence: 2,
          created_at: "2026-11-21T01:00:00Z",
          kind: "assistant",
          text: "Есть вопрос по процессу.",
          questions: [q1],
        },
      ],
    }));

    window.location.hash = `#/s/${sid}`;
    const { container } = render(<App initialApi={api} />);

    const jumpBtn = await screen.findByRole("button", { name: "К открытому вопросу" });
    const questionNode = container.querySelector('[data-question-open="true"]') as HTMLElement;
    expect(questionNode).not.toBeNull();
    const scrollSpy = vi.fn();
    questionNode.scrollIntoView = scrollSpy;

    fireEvent.click(jumpBtn);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "start" });
  });
});
