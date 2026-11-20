import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BehavioralModel } from "../contracts/model";
import { computeSpecHash } from "../dsl/spec-hash";
import {
  ORDER_VERSIONS,
  TLC_ORDER_BUG_RESULT,
} from "../fixtures/order-versions";
import {
  createRecordedCodegenProvider,
  RECORDED_GENERATION,
  CODEGEN_VERSION,
} from "../fixtures/codegen";
import type {
  HostElementRef,
  HostModelVersion,
  HostWorkspaceContext,
} from "./contract";
import {
  cachedManifest,
  configureProjectFiles,
  implementationLinks,
  rememberManifest,
} from "./project-files";
import {
  DiagramView,
  FilesView,
  ImplementationSection,
  inspectorSections,
  StageSection,
  workspaceViews,
} from "./views";

function makeCalls() {
  return {
    select: vi.fn<HostWorkspaceContext["select"]>(),
    setTraceStep: vi.fn<HostWorkspaceContext["setTraceStep"]>(),
    focusTrace: vi.fn<HostWorkspaceContext["focusTrace"]>(),
    openView: vi.fn<HostWorkspaceContext["openView"]>(),
    selectVersion: vi.fn<HostWorkspaceContext["selectVersion"]>(),
  };
}
type Calls = ReturnType<typeof makeCalls>;

/** Контекст в форме ядра: свойства без origin/approved_by, как их типизирует frontend/. */
function looseVersion(index: number): HostModelVersion {
  const version = ORDER_VERSIONS[index]!;
  return {
    ...version,
    spec: {
      ...version.spec,
      properties: version.spec.properties.map(
        ({ origin: _o, approved_by: _a, ...rest }) => rest,
      ),
    },
  };
}

function makeContext(overrides: Partial<HostWorkspaceContext> = {}): {
  context: HostWorkspaceContext;
  calls: Calls;
} {
  const calls: Calls = makeCalls();
  const check = {
    runId: "chk_1",
    versionId: ORDER_VERSIONS[0]!.id,
    results: [{ ...TLC_ORDER_BUG_RESULT, version_id: ORDER_VERSIONS[0]!.id }],
  };
  const context: HostWorkspaceContext = {
    api: { id: "test" },
    capabilities: { adapter: "http" },
    versions: [looseVersion(0), looseVersion(1)],
    version: looseVersion(0),
    checks: [check],
    trace: null,
    selection: { versionId: ORDER_VERSIONS[0]!.id, element: null, trace: null },
    ...calls,
    ...overrides,
  };
  return { context, calls };
}

/** Повторяет ядро: select() меняет selection.element, setTraceStep — шаг. */
function Host({
  initial,
  onSelect,
}: {
  initial: HostWorkspaceContext;
  onSelect?: (element: HostElementRef | null) => void;
}) {
  const [element, setElement] = useState<HostElementRef | null>(
    initial.selection.element,
  );
  const context: HostWorkspaceContext = {
    ...initial,
    selection: { ...initial.selection, element },
    select: (next) => {
      setElement(next);
      onSelect?.(next);
    },
  };
  return (
    <div style={{ width: 1000, height: 700 }}>
      <DiagramView context={context} />
      {inspectorSections
        .filter((section) => section.matches(context))
        .map((section) => (
          <section key={section.id} aria-label={section.label}>
            <section.component context={context} />
          </section>
        ))}
    </div>
  );
}

afterEach(() => configureProjectFiles(null));

describe("подключение к рабочей области ядра", () => {
  it("регистрирует вкладки и секции по контракту ядра", () => {
    expect(workspaceViews.map((view) => [view.id, view.order])).toEqual([
      ["diagram", 40],
      ["files", 50],
    ]);
    const { context } = makeContext();
    expect(workspaceViews[0]!.available!(context)).toBe(true);
    expect(workspaceViews[0]!.available!({ ...context, version: null })).toBe(
      false,
    );
    // Без источника проекта вкладки «Файлы» нет: пустые заглушки ядро не показывает.
    expect(workspaceViews[1]!.available!(context)).toBe(false);
    configureProjectFiles({
      provider: createRecordedCodegenProvider(),
      resolve: () => ({ projectId: RECORDED_GENERATION.generation_id }),
    });
    expect(workspaceViews[1]!.available!(context)).toBe(true);
  });

  it("диаграмма отдаёт выбор ядру и показывает нарушение последней проверки версии", async () => {
    const selected: Array<HostElementRef | null> = [];
    const { context, calls } = makeContext();
    render(
      <Host initial={context} onSelect={(element) => selected.push(element)} />,
    );
    // Своего выбора версии и статуса нет: их показывает ядро.
    expect(
      screen.queryByRole("combobox", { name: "Версия модели" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Нарушено:/)).not.toBeInTheDocument();

    const chip = await screen.findByRole("button", {
      name: /«Исполнить» \(Execute\): Cancelled → Executed/,
    });
    await userEvent.click(chip);
    expect(selected.at(-1)).toEqual({ kind: "transition", id: "Execute" });
    const stages = screen.getByRole("region", { name: "Этапы" });
    expect(
      within(stages).getByText(
        /Срабатывает на любом этапе: условие не зависит от status/,
      ),
    ).toBeInTheDocument();
    expect(
      within(stages).getByText(/Cancelled → Executed/),
    ).toBeInTheDocument();

    // Шаг трассы без выбранной в ядре трассы выбирает её через focusTrace.
    await userEvent.click(screen.getByRole("button", { name: /Назад/ }));
    expect(calls.focusTrace).toHaveBeenCalledWith({
      checkRunId: "chk_1",
      propertyId: "NoCancelledExecution",
      step: 2,
    });
  });

  it("шаг трассы общий с ядром", async () => {
    const result = {
      ...TLC_ORDER_BUG_RESULT,
      version_id: ORDER_VERSIONS[0]!.id,
    };
    const { context, calls } = makeContext({
      trace: {
        check: {
          runId: "chk_1",
          versionId: ORDER_VERSIONS[0]!.id,
          results: [result],
        },
        result,
        property: undefined,
        step: 1,
        focus: 3,
      },
    });
    render(<Host initial={context} />);
    expect(await screen.findByText("Шаг 1 из 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Шаг$/ }));
    expect(calls.setTraceStep).toHaveBeenCalledWith(2);
  });

  it("выбор этапа передаётся ядру как значение переменной", async () => {
    const selected: Array<HostElementRef | null> = [];
    const { context } = makeContext({ checks: [] });
    render(
      <Host initial={context} onSelect={(element) => selected.push(element)} />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Таблица/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Граф/ }));
    // Этап выбирается с клавиатуры (Enter на сфокусированном узле React Flow).
    const node = await screen.findByRole("group", { name: /Этап Cancelled/ });
    node.focus();
    await userEvent.keyboard("{Enter}");
    expect(selected.at(-1)).toEqual({
      kind: "value",
      variable: "status",
      value: "Cancelled",
    });
    const stages = screen.getByRole("region", { name: "Этапы" });
    expect(
      within(stages).getByText(
        /Исполнить → Executed \(если approved == true\)/,
      ),
    ).toBeInTheDocument();
    expect(within(stages).getByText("approved, cancelled")).toBeInTheDocument();
  });

  it("без createVersion в ядре правка недоступна с причиной", async () => {
    const { context } = makeContext();
    render(<Host initial={context} />);
    const edit = await screen.findByRole("button", { name: /Изменить/ });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute(
      "title",
      "Создание версий не подключено в этом клиенте",
    );
  });

  it("с createVersion ядра создаёт версию от выбранной", async () => {
    const createVersion = vi.fn(
      async (
        modelId: string,
        body: { spec: BehavioralModel; parent_id: string },
        _key: string,
      ) => ({
        ...ORDER_VERSIONS[0]!,
        id: "v_new",
        number: 3,
        parent_id: body.parent_id,
        spec: body.spec,
        spec_hash: computeSpecHash(body.spec),
        model_id: modelId,
      }),
    );
    const { context } = makeContext({ createVersion });
    const user = userEvent.setup();
    render(<Host initial={context} />);
    await user.click(await screen.findByRole("button", { name: /Изменить/ }));
    await user.click(screen.getByRole("button", { name: /Таблица/ }));
    await user.click(screen.getByRole("button", { name: "Отменить" }));
    await user.click(
      screen.getByRole("button", { name: /Изменить guard и effects/ }),
    );
    const editor = screen.getByRole("region", {
      name: "Правка перехода Cancel",
    });
    await user.click(
      within(editor).getByRole("button", { name: /Присваивание/ }),
    );
    const value = within(editor).getByRole("textbox", {
      name: "Новое значение approved",
    });
    await user.clear(value);
    await user.type(value, "false");
    await user.click(
      within(editor).getByRole("button", { name: "Применить к черновику" }),
    );
    await user.click(screen.getByRole("button", { name: "Создать версию" }));
    await waitFor(() => expect(createVersion).toHaveBeenCalledTimes(1));
    const [modelId, body, key] = createVersion.mock.calls[0]!;
    expect(modelId).toBe(ORDER_VERSIONS[0]!.model_id);
    expect(body.parent_id).toBe(ORDER_VERSIONS[0]!.id);
    expect(key).toMatch(/^graph-edit-/);
    // Модель ядра без origin/approved_by нормализована: spec полный, как у сервера.
    expect(
      body.spec.properties.every(
        (property) =>
          property.origin === "requirement" && property.approved_by === null,
      ),
    ).toBe(true);
  });
});

describe("файлы проекта в ядре", () => {
  it("связывает настоящие строки генератора с элементом модели", () => {
    rememberManifest(
      { projectId: RECORDED_GENERATION.generation_id },
      RECORDED_GENERATION,
    );
    expect(
      cachedManifest({ projectId: RECORDED_GENERATION.generation_id }),
    ).toBe(RECORDED_GENERATION);
    const links = implementationLinks(RECORDED_GENERATION, {
      kind: "transition",
      id: "Cancel",
    });
    expect(
      links.some(
        (l) => l.path === "app/rules.py" && l.lines && l.lines.start > 0,
      ),
    ).toBe(true);
    expect(
      implementationLinks(RECORDED_GENERATION, {
        kind: "value",
        variable: "status",
        value: "Created",
      }),
    ).toEqual([]);
  });
  it("секция «Этапы» для перехода, ложного на всех этапах", () => {
    const spec = structuredClone(ORDER_VERSIONS[0]!.spec);
    spec.transitions.push({
      ...spec.transitions[0]!,
      id: "Never",
      name: "Никогда",
      guard: { kind: "literal", value: false },
    });
    const version = { ...ORDER_VERSIONS[0]!, spec };
    const { context } = makeContext({
      version,
      versions: [version],
      selection: {
        versionId: version.id,
        element: { kind: "transition", id: "Never" },
        trace: null,
      },
    });
    render(<StageSection context={context} />);
    expect(
      screen.getByText(/Условие ложно на каждом этапе status/),
    ).toBeInTheDocument();
  });
});
it("FilesView подключает реальный provider без циклических уведомлений", async () => {
  configureProjectFiles({ provider: createRecordedCodegenProvider() });
  const { context } = makeContext({
    version: { ...ORDER_VERSIONS[1]!, ...CODEGEN_VERSION },
    versions: [],
  });
  render(<FilesView context={context} />);
  expect(await screen.findByText(/Версия.*файлов/)).toBeInTheDocument();
  expect(await screen.findByText(/пройдено 79 из 79/)).toBeInTheDocument();
});
