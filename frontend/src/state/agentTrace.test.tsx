import {act, render, renderHook, screen, waitFor, within} from "@testing-library/react";
import {expect, it, vi} from "vitest";
import {App} from "../App";
import type {ApiCapabilities, ProveryalkaApi} from "../api/api";
import {DemoApi} from "../api/demo";
import type {AgentRunTrace, DialogueView, Run, RunEvent} from "../api/types";
import {registerCoreViews} from "../app/coreViews";
import {resetExtensions} from "../app/extensions";
import {useSessionWorkspace} from "./useSessionWorkspace";

const sid = "demo_s_order";
const caps: ApiCapabilities = {adapter: "http", agent: true, questionId: true, customLimits: true, artifacts: false,
  checkDiscovery: false, documents: false, dialogue: true, agentTrace: true};
const run = (id: string, state: Run["state"]): Run => ({run_id: id, session_id: sid, state, error_code: null, version_id: null});
const event = (id: string, number: number, type: RunEvent["type"], data: Record<string, unknown>): RunEvent => ({
  run_id: id, session_id: sid, event_id: number, type, data, created_at: `2026-10-31T10:00:0${number}Z`,
});
const trace = (id = "stored", state: Run["state"] = "completed"): AgentRunTrace => ({
  run: run(id, state), input_entry_id: "input", reply_entry_id: state === "completed" ? "reply" : null, source_id: "source",
  created_at: "2026-10-31T10:00:00Z", started_at: "2026-10-31T10:00:01Z", finished_at: state === "completed" ? "2026-10-31T10:00:03Z" : null,
  events: [event(id, 1, "activity", {phase: "model_request"})], events_truncated: false,
});
const dialogue = (): DialogueView => ({session_id: sid, status: "not_started", round: null, max_rounds: null, reply: null,
  requirements: [], questions: [], open_question_ids: [], corrections: [], analysis: null, model: null, pending: null, entries: [
    {id: "input", kind: "user", sequence: 1, text: "Проверь правило", status: "processed", created_at: "2026-10-31T10:00:00Z"},
    {id: "reply", kind: "assistant", sequence: 2, text: "Сохранённый ответ", created_at: "2026-10-31T10:00:03Z"},
  ]});
function apiWithTrace(): ProveryalkaApi {
  const api: ProveryalkaApi = new DemoApi();
  api.capabilities = async () => caps;
  api.getDialogue = vi.fn(async () => dialogue());
  api.listAgentRuns = vi.fn(async () => ({runs: [trace()], next_cursor: null}));
  api.streamEvents = vi.fn(async function* () {});
  return api;
}

it("discovers persisted traces in a fresh browser, paginates and deduplicates repeated pages", async () => {
  const api = apiWithTrace();
  api.listAgentRuns = vi.fn(async (_sid, before) => before ? {runs: [trace("older")], next_cursor: null}
    : {runs: [trace()], next_cursor: 15});
  const {result, unmount} = renderHook(() => useSessionWorkspace({api, capabilities: caps, sessionId: sid}));
  await waitFor(() => expect(result.current.agentRuns.map(item => item.runId)).toEqual(["stored"]));
  expect(result.current.agentRuns[0]?.trace?.reply_entry_id).toBe("reply");
  expect(result.current.agentTraceHistory.nextCursor).toBe(15);
  expect(api.streamEvents).not.toHaveBeenCalled();
  act(() => result.current.loadOlderAgentRuns());
  await waitFor(() => expect(result.current.agentRuns).toHaveLength(2));
  expect(api.listAgentRuns).toHaveBeenLastCalledWith(sid, 15, expect.any(AbortSignal));
  act(() => result.current.reloadAgentRuns());
  await waitFor(() => expect(api.listAgentRuns).toHaveBeenCalledTimes(3));
  expect(result.current.agentRuns).toHaveLength(2);
  unmount();
  localStorage.clear();
  const fresh = renderHook(() => useSessionWorkspace({api, capabilities: caps, sessionId: sid}));
  await waitFor(() => expect(fresh.result.current.agentRuns[0]?.trace?.input_entry_id).toBe("input"));
});

it("merges replayed SSE with persisted events and retains partial operations after terminal failure", async () => {
  const api = apiWithTrace();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  let failed = false;
  const stored = trace("live", "running");
  const all = [...stored.events, event("live", 2, "activity", {phase: "model_response"}),
    event("live", 3, "error", {code: "PROVIDER_TIMEOUT"}), event("live", 4, "run_finished", {state: "failed"})];
  api.listAgentRuns = vi.fn<NonNullable<ProveryalkaApi["listAgentRuns"]>>(async () => ({runs: [{...stored, run: {...stored.run, state: failed ? "failed" : "running"},
    events: failed ? all : stored.events}], next_cursor: null}));
  api.getRun = vi.fn<ProveryalkaApi["getRun"]>(async () => ({...stored.run, state: "failed", error_code: "PROVIDER_TIMEOUT"}));
  api.streamEvents = async function* () {
    yield stored.events[0]!;
    await gate;
    failed = true;
    for (const item of all.slice(1)) yield item;
  };
  const {result} = renderHook(() => useSessionWorkspace({api, capabilities: caps, sessionId: sid}));
  await waitFor(() => expect(result.current.activeAgentRun?.events).toHaveLength(1));
  expect(result.current.activeAgentRun?.events[0]?.data.phase).toBe("model_request");
  await act(async () => release());
  await waitFor(() => expect(result.current.activeAgentRun).toBeNull());
  const completed = result.current.agentRuns[0]!;
  expect(completed.events.map(item => item.event_id)).toEqual([1, 2, 3, 4]);
  expect(completed.run?.state).toBe("failed");
  expect(completed.failure?.code).toBe("PROVIDER_TIMEOUT");
  expect(completed.trace?.reply_entry_id).toBeNull();
});

it("shows a stored run within its exact public reply instead of rendering SDK message content", async () => {
  resetExtensions(); registerCoreViews();
  window.location.hash = `/s/${sid}?m=demo_m_order&v=1&view=model`;
  const api = apiWithTrace();
  const session = await api.getSession(sid);
  api.getSession = vi.fn(async () => ({...session, messages: [{id: "private", session_id: sid, sequence: 3,
    created_at: "2026-10-31T10:00:00Z", message_data: {role: "assistant", content: "PRIVATE SDK CONTENT"}}]}));
  render(<App initialApi={api}/>);
  const answer = await screen.findByText("Сохранённый ответ");
  await waitFor(() => expect(within(answer.closest(".msg__card") as HTMLElement).getByText("Ход работы")).toBeInTheDocument());
  expect(screen.getAllByText("Ход работы")).toHaveLength(1);
  expect(screen.queryByText("PRIVATE SDK CONTENT")).toBeNull();
  expect(screen.queryByText("Модель готовит ответ")).toBeNull();
});

it("does not request a trace API when the backend does not advertise it", async () => {
  const api = apiWithTrace();
  const {result} = renderHook(() => useSessionWorkspace({api, capabilities: {...caps, agentTrace: false}, sessionId: sid}));
  await waitFor(() => expect(result.current.detail.loading).toBe(false));
  expect(api.listAgentRuns).not.toHaveBeenCalled();
  expect(result.current.agentRuns).toHaveLength(0);
});

it("replaces queued status when actual started/model_request events arrive", async () => {
  const api = apiWithTrace();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  api.sendMessage = async () => run("new", "queued");
  api.streamEvents = async function* () {
    yield event("new", 1, "activity", {phase: "started"});
    yield event("new", 2, "activity", {phase: "model_request"});
    await gate;
    yield event("new", 3, "run_finished", {state: "completed"});
  };
  api.getRun = async () => run("new", "completed");
  const {result} = renderHook(() => useSessionWorkspace({api, capabilities: {...caps, agentTrace: false}, sessionId: sid}));
  await waitFor(() => expect(result.current.detail.loading).toBe(false));
  await act(async () => {await result.current.sendMessage("Новое правило", null);});
  await waitFor(() => expect(result.current.activeAgentRun?.run?.state).toBe("running"));
  expect(result.current.activeAgentRun?.events.at(-1)?.data.phase).toBe("model_request");
  await act(async () => release());
  await waitFor(() => expect(result.current.activeAgentRun).toBeNull());
});

it("keeps a failed attempt after its input while linking the successful retry only to its reply", async () => {
  resetExtensions(); registerCoreViews();
  window.location.hash = `/s/${sid}?m=demo_m_order&v=1&view=model`;
  const api = apiWithTrace();
  const failed = {...trace("old", "failed"), created_at: "2026-10-31T09:59:00Z", run: {...run("old", "failed"), error_code: "PROVIDER_TIMEOUT"}};
  api.listAgentRuns = async () => ({runs: [trace(), failed], next_cursor: null});
  render(<App initialApi={api}/>);
  await waitFor(() => expect(screen.getAllByText("Ход работы")).toHaveLength(2));
  const failedTrace = document.querySelector('[data-run-id="old"]')!.closest("li.msg")!;
  expect(failedTrace.previousElementSibling).toHaveTextContent("Проверь правило");
  expect(failedTrace.nextElementSibling).toHaveTextContent("Сохранённый ответ");
  const answer = screen.getByText("Сохранённый ответ");
  expect(answer.closest(".msg__card")!.querySelector('[data-run-id="stored"]')).toBeInTheDocument();
  expect(answer.closest(".msg__card")!.querySelector('[data-run-id="old"]')).toBeNull();
});
