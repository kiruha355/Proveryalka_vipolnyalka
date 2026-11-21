import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { DemoApi } from "../api/demo";
import type { DialogueState, Model, ModelVersion } from "../api/types";
import { useCore } from "../app/core";
import { registerCoreViews } from "../app/coreViews";
import { registerWorkspaceView, resetExtensions } from "../app/extensions";
import { parseRoute } from "../app/route";
import type { WorkspaceContextValue } from "../app/workspace";
import { AnalysisEntry } from "./chat/entries";
import { resolveVersionState } from "./SessionView";

beforeEach(() => {
  resetExtensions();
  registerCoreViews();
});

describe("issue #72 navigation fixes", () => {
  it("opens v1 violation and trace when clicking «Показать сценарий» from v2 and keeps them after reload", async () => {
    window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=2&view=model";
    const api = new DemoApi();
    const { unmount } = render(<App initialApi={api} />);

    // Confirm v2 is initially open.
    const picker = await screen.findByLabelText("Версия модели") as HTMLSelectElement;
    expect(picker.value).toBe("demo_order_v2");
    expect(screen.getByRole("heading", { name: "Заявка (исправлено)" })).toBeInTheDocument();

    // Click «Показать сценарий» under v1's violation card in chat.
    const showScenario = await screen.findByRole("button", { name: "Показать сценарий" });
    fireEvent.click(showScenario);

    await waitFor(() => {
      expect((screen.getByLabelText("Версия модели") as HTMLSelectElement).value).toBe("demo_order_v1");
    });

    // URL carries the atomic selection: model, version 1, check tab, v1 run and violated property.
    const parsed = parseRoute(window.location.hash);
    expect(parsed).toMatchObject({
      sessionId: "demo_s_order",
      modelId: "demo_m_order",
      version: 1,
      view: "check",
      check: "demo_chk_demo_order_v1_1",
      property: "NoCancelledExecution",
    });

    // Check view shows v1's violation and counterexample trace, not v2's passing check.
    expect(screen.getByRole("tab", { name: "Проверка" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Заявка" })).toBeInTheDocument();
    const traceRegion = await screen.findByRole("region", { name: "Контрпример, найденный движком" });
    expect(traceRegion).toBeInTheDocument();
    expect(within(traceRegion).getByText("нарушение")).toBeInTheDocument();

    // Simulate a full page reload with the same hash.
    const savedHash = window.location.hash;
    unmount();
    window.location.hash = savedHash;
    render(<App initialApi={new DemoApi()} />);

    await waitFor(() => {
      expect((screen.getByLabelText("Версия модели") as HTMLSelectElement).value).toBe("demo_order_v1");
    });
    expect(screen.getByRole("tab", { name: "Проверка" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "Контрпример, найденный движком" })).toBeInTheDocument();
    expect(window.location.hash).toBe(savedHash);
  });

  it("opens v2 results via «Открыть результаты» while v1 is open, and supports transitions from related requirements", async () => {
    window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=1&view=check&check=demo_chk_demo_order_v1_1&p=NoCancelledExecution";
    const api = new DemoApi();
    render(<App initialApi={api} />);

    // Wait for v1 violation detail and related requirements.
    const traceRegion = await screen.findByRole("region", { name: "Контрпример, найденный движком" });
    expect(traceRegion).toBeInTheDocument();

    // Navigate from «Связанные требования» into the Inspector and then to a linked model element.
    const relatedHeading = screen.getByRole("heading", { name: "Связанные требования" });
    const relatedSection = relatedHeading.closest("section")!;
    const reqButton = within(relatedSection).getAllByRole("button")[0]!;
    fireEvent.click(reqButton);

    const inspector = await screen.findByRole("complementary", { name: /^R\d+$/ });
    expect(inspector).toBeInTheDocument();
    expect(within(inspector).getByText("Элементы модели")).toBeInTheDocument();
    const elementLinks = within(inspector).getAllByRole("button").filter(
      (btn) => btn.getAttribute("aria-label") !== "Закрыть инспектор",
    );
    expect(elementLinks.length).toBeGreaterThan(0);
    const targetName = elementLinks[0]!.textContent!;
    fireEvent.click(elementLinks[0]!);
    expect(within(screen.getByRole("complementary")).getByRole("heading", { name: targetName })).toBeInTheDocument();

    // Now click «Открыть результаты» under v2's passing check card in chat.
    const openResults = screen.getByRole("button", { name: "Открыть результаты" });
    fireEvent.click(openResults);

    await waitFor(() => {
      expect((screen.getByLabelText("Версия модели") as HTMLSelectElement).value).toBe("demo_order_v2");
    });
    expect(parseRoute(window.location.hash)).toMatchObject({
      sessionId: "demo_s_order",
      modelId: "demo_m_order",
      version: 2,
      view: "check",
      check: "demo_chk_demo_order_v2_1",
      property: "NoCancelledExecution",
    });
    expect(screen.queryByRole("region", { name: "Контрпример, найденный движком" })).toBeNull();
    // Stale inspector element from v1 was cleared on version switch.
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("synchronously updates routeRef in SessionView go so sequential context calls keep all patches", async () => {
    let captured: WorkspaceContextValue | null = null;
    registerWorkspaceView({
      id: "probe",
      label: "Probe",
      component: ({ context }) => {
        captured = context;
        return <p>probe-ready</p>;
      },
    });
    window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=2&view=probe";
    render(<App initialApi={new DemoApi()} />);
    await screen.findByText("probe-ready");
    await waitFor(() => expect(captured?.versions.length).toBe(2));

    act(() => {
      captured!.selectVersion("demo_order_v1");
      captured!.focusTrace({ checkRunId: "demo_chk_demo_order_v1_1", propertyId: "NoCancelledExecution" });
      captured!.openView("check");
    });

    expect(parseRoute(window.location.hash)).toMatchObject({
      sessionId: "demo_s_order",
      modelId: "demo_m_order",
      version: 1,
      view: "check",
      check: "demo_chk_demo_order_v1_1",
      property: "NoCancelledExecution",
    });
  });

  it("AnalysisEntry uses one atomic openLocation call for opening a model version and its requirements", async () => {
    const api = new DemoApi();
    const versions = await api.listVersions("demo_m_order");
    const v1 = versions[0]!;
    const v2 = versions[1]!;
    const openLocation = vi.fn();
    const selectVersion = vi.fn();
    const openView = vi.fn();
    const context = {
      version: v2,
      versions,
      openLocation,
      selectVersion,
      openView,
    } as unknown as WorkspaceContextValue;

    const state: DialogueState = {
      schema_version: "2.0",
      status: "ready",
      round: 1,
      max_rounds: 3,
      sources: v1.spec.sources,
      questions: [],
      answers: [],
      corrections: [],
      property_approvals: {},
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
        model_issues: [],
        behavior: v1.spec,
      },
    };

    const analysisEntry = (current: WorkspaceContextValue) => (
      <ul>
        <AnalysisEntry
          state={state}
          isLatest={false}
          time={null}
          versions={versions}
          context={current}
          replyQuestionId={null}
          canAnswer={false}
          onAnswer={() => {}}
        />
      </ul>
    );
    const { rerender } = render(analysisEntry(context));

    fireEvent.click(screen.getByRole("button", { name: "Открыть модель · версия 1" }));
    expect(openLocation).toHaveBeenCalledTimes(1);
    expect(openLocation).toHaveBeenCalledWith({
      modelId: v1.model_id,
      version: v1.number,
      view: "model",
      check: undefined,
      property: undefined,
      step: undefined,
    });
    expect(selectVersion).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Требования и цитаты" }));
    expect(openLocation).toHaveBeenCalledTimes(1);
    expect(openView).toHaveBeenCalledWith("requirements");

    rerender(analysisEntry({ ...context, version: v1 }));
    fireEvent.click(screen.getByRole("button", { name: "Открыть модель · версия 1" }));
    expect(openLocation.mock.calls.at(-1)).toStrictEqual([{
      modelId: v1.model_id,
      version: v1.number,
      view: "model",
    }]);
  });

  it("preserves explicit check ID in URL while another run loads first (S1)", async () => {
    const baseApi = new DemoApi();
    const firstCheck = await baseApi.getCheck("demo_chk_demo_order_v1_1");
    const secondCheck = {
      ...firstCheck,
      run: { ...firstCheck.run, run_id: "demo_chk_demo_order_v1_2" },
    };
    let resolveTarget: ((value: typeof secondCheck) => void) | undefined;
    const api = new DemoApi();
    api.listCheckRuns = vi.fn(async (version) => {
      const id = typeof version === "string" ? version : version.id;
      return id === "demo_order_v1" ? ["demo_chk_demo_order_v1_1", "demo_chk_demo_order_v1_2"] : [];
    });
    api.getCheck = vi.fn(async (runId: string) => {
      if (runId === "demo_chk_demo_order_v1_2") {
        return new Promise<typeof secondCheck>((resolve) => { resolveTarget = resolve; });
      }
      return firstCheck;
    });

    window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=1&view=check&check=demo_chk_demo_order_v1_2&p=NoCancelledExecution";
    render(<App initialApi={api} />);

    // First run loads immediately, but explicit URL check ID must NOT be overwritten.
    await waitFor(() => {
      expect(api.getCheck).toHaveBeenCalledWith("demo_chk_demo_order_v1_1", expect.anything());
      expect(resolveTarget).toBeDefined();
    });
    expect(parseRoute(window.location.hash).check).toBe("demo_chk_demo_order_v1_2");

    // Once requested run finishes loading, it becomes active and stays selected.
    await act(async () => {
      resolveTarget!(secondCheck);
    });
    expect(await screen.findByRole("region", { name: "Контрпример, найденный движком" })).toBeInTheDocument();
    expect(parseRoute(window.location.hash).check).toBe("demo_chk_demo_order_v1_2");
  });

  it("initializes narrow-screen pane to workspace when reloading a report URL (S2)", async () => {
    window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=1&view=check&check=demo_chk_demo_order_v1_1&p=NoCancelledExecution";
    render(<App initialApi={new DemoApi()} />);

    const workspaceToggle = await screen.findByRole("button", { name: "Модель и проверка" });
    expect(workspaceToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("offers a retry when the requested version is absent from a stale model list", async () => {
    registerWorkspaceView({
      id: "model-refresh",
      label: "Model refresh",
      component: ({ context }) => {
        const { workspace } = useCore();
        return <button onClick={async () => {
          await workspace.reloadModels();
          context.openLocation({ modelId: "demo_m_order", version: 3 });
        }}>Refresh and open v3</button>;
      },
    });
    const api = new DemoApi();
    const versions = await api.listVersions("demo_m_order");
    const loadVersions = vi.spyOn(api, "listVersions")
      .mockResolvedValueOnce(versions)
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValue(versions);
    window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=2&view=model-refresh";
    render(<App initialApi={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Refresh and open v3" }));
    expect(await screen.findByText("Модели не загружены")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Повторить$/ }));
    expect(await screen.findByText("Запрошенная версия модели не найдена")).toBeInTheDocument();
    expect(loadVersions).toHaveBeenCalledTimes(3);
  });

  it("shows a recoverable route error for #/s/% and invalid numeric params instead of throwing URIError", async () => {
    window.location.hash = "#/s/%";
    const api = new DemoApi();
    render(<App initialApi={api} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Некорректная ссылка");
    expect(alert).toHaveTextContent("percent-encoding");

    fireEvent.click(screen.getByRole("button", { name: "Вернуться в список чатов" }));
    expect(window.location.hash).toBe("#/new");
    expect(screen.queryByText("Некорректная ссылка")).toBeNull();

    // Navigating to an invalid numeric param also shows a clear route error.
    act(() => {
      window.location.hash = "#/s/demo_s_order?m=demo_m_order&v=0&step=-1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const paramAlert = await screen.findByRole("alert");
    expect(paramAlert).toHaveTextContent("Некорректная ссылка");
    expect(paramAlert).toHaveTextContent("Недопустимый номер версии");
    expect(screen.getByRole("button", { name: "Вернуться в список чатов" })).toBeInTheDocument();
  });

  it("distinguishes loading, missing explicit version, and default session opening", async () => {
    const baseApi = new DemoApi();
    const realModels = await baseApi.listModels("demo_s_order");
    let resolveModels!: (models: Model[]) => void;
    const api = new DemoApi();
    api.listModels = vi.fn(
      () =>
        new Promise<Model[]>((resolve) => {
          resolveModels = resolve;
        }),
    );

    window.location.hash = "#/s/demo_s_order?m=missing&v=999&view=model";
    render(<App initialApi={api} />);

    // While models are loading, show loading indicator rather than error or v2.
    expect(await screen.findByText("Загрузка модели")).toBeInTheDocument();
    expect(screen.queryByText("Запрошенная версия модели не найдена")).toBeNull();
    expect(screen.queryByLabelText("Версия модели")).toBeNull();

    // After models resolve, show explicit missing-version error instead of silently falling back to v2.
    await act(async () => {
      resolveModels(realModels);
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Запрошенная версия модели не найдена");
    expect(alert).toHaveTextContent("missing");
    expect(alert).toHaveTextContent("999");
    expect(screen.queryByLabelText("Версия модели")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Заявка (исправлено)" })).toBeNull();

    // Action to open the latest version navigates to v2 on the requested view.
    fireEvent.click(screen.getByRole("button", { name: "Открыть последнюю версию (v2)" }));
    await waitFor(() => {
      expect((screen.getByLabelText("Версия модели") as HTMLSelectElement).value).toBe("demo_order_v2");
    });
    expect(parseRoute(window.location.hash)).toMatchObject({
      sessionId: "demo_s_order",
      modelId: "demo_m_order",
      version: 2,
      view: "model",
    });
  });

  it("opens defaultVersion when no model or version is specified in the route", async () => {
    window.location.hash = "#/s/demo_s_order";
    render(<App initialApi={new DemoApi()} />);

    const picker = await screen.findByLabelText("Версия модели") as HTMLSelectElement;
    expect(picker.value).toBe("demo_order_v2");
    expect(screen.queryByText("Запрошенная версия модели не найдена")).toBeNull();
  });

  it("resolveVersionState handles loading, missing, explicit match, and default cases", async () => {
    const api = new DemoApi();
    const models = await api.listModels("demo_s_order");
    const versions: ModelVersion[] = await api.listVersions("demo_m_order");
    const groups = [{ model: models[0]!, versions }];

    expect(
      resolveVersionState({ sessionId: "demo_s_order", modelId: "missing", version: 999 }, { data: null, error: null, loading: true }, []),
    ).toEqual({ status: "loading", version: null });

    expect(
      resolveVersionState({ sessionId: "demo_s_order", modelId: "missing", version: 999 }, { data: groups, error: null, loading: false }, versions),
    ).toEqual({ status: "missing", version: null, requestedModelId: "missing", requestedVersion: 999 });

    // Failed refresh with cached versions must return error (not missing) when requested version is not in cache (S3).
    expect(
      resolveVersionState(
        { sessionId: "demo_s_order", modelId: "demo_m_order", version: 3 },
        { data: groups, error: new Error("Network down"), loading: false },
        versions,
      ),
    ).toEqual({ status: "error", version: null });

    expect(
      resolveVersionState({ sessionId: "demo_s_order", modelId: "demo_m_order", version: 1 }, { data: groups, error: null, loading: false }, versions),
    ).toEqual({ status: "ready", version: versions[0] });

    expect(
      resolveVersionState({ sessionId: "demo_s_order" }, { data: groups, error: null, loading: false }, versions),
    ).toEqual({ status: "ready", version: versions[1] });
  });
});
