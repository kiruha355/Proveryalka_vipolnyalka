import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/http";
import type { ModelVersionsPort } from "../../api/http";
import type { ModelVersion } from "../../contracts/model";
import { computeSpecHash } from "../../dsl/spec-hash";
import {
  ORDER_FIXED_SPEC,
  ORDER_VERSIONS,
  TLC_ORDER_BUG_RESULT,
} from "../../fixtures/order-versions";
import { StateGraphWorkspace } from "./StateGraphWorkspace";

function Harness({
  port,
  initial = ORDER_VERSIONS[0]!.id,
  onCreated,
}: {
  port?: ModelVersionsPort | null;
  initial?: string;
  onCreated?: (v: ModelVersion) => void;
}) {
  const [versions, setVersions] = useState(ORDER_VERSIONS);
  const [selected, setSelected] = useState(initial);
  return (
    <div style={{ width: 1000, height: 700 }}>
      <StateGraphWorkspace
        versions={versions}
        selectedVersionId={selected}
        onSelectVersion={setSelected}
        results={[TLC_ORDER_BUG_RESULT]}
        versionsPort={port ?? null}
        onVersionCreated={(version) => {
          setVersions((current) => [...current, version]);
          onCreated?.(version);
        }}
      />
    </div>
  );
}

describe("StateGraphWorkspace", () => {
  it("показывает этапы, нарушение и шаги реальной трассы TLC", async () => {
    render(<Harness />);
    expect(
      await screen.findByText("Нарушено: Отменённая заявка не исполняется"),
    ).toBeInTheDocument();
    for (const label of ["Created", "Approved", "Cancelled", "Executed"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // Трасса открыта на шаге нарушения.
    expect(screen.getByText("Шаг 3 из 3")).toBeInTheDocument();
    const state = screen.getByRole("region", {
      name: "Состояние на шаге трассы",
    });
    expect(within(state).getByText("Шаг 3: Исполнить")).toBeInTheDocument();
    expect(within(state).getByText("— нарушение")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Назад/ }));
    expect(screen.getByText("Шаг 2 из 3")).toBeInTheDocument();
    expect(within(state).getByText("Шаг 2: Отменить")).toBeInTheDocument();
    expect(within(state).getAllByText(/было/).length).toBe(2);
  });

  it("объясняет условную стрелку Execute из Cancelled", async () => {
    render(<Harness />);
    const chip = await screen.findByRole("button", {
      name: /«Исполнить» \(Execute\): Cancelled → Executed, при условии approved == true/,
    });
    await userEvent.click(chip);
    const card = screen.getByRole("region", { name: "Переход Исполнить" });
    expect(within(card).getByText("Эта стрелка")).toBeInTheDocument();
    expect(
      within(card).getAllByText("approved == true").length,
    ).toBeGreaterThan(0);
    expect(
      within(card).getAllByText(/Исполнить можно только согласованную заявку/)
        .length,
    ).toBeGreaterThan(0);
    expect(within(card).getByText("шаг 3")).toBeInTheDocument();
  });

  it("не накладывает отчёт другой версии", async () => {
    render(<Harness initial={ORDER_VERSIONS[1]!.id} />);
    expect(
      await screen.findByText(
        /Хеш спецификации отчёта не совпадает с версией; трасса на этой версии не показана/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Шаг \d из/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Нарушено:/)).not.toBeInTheDocument();
  });

  it("без порта версий правка недоступна и причина названа", async () => {
    render(<Harness />);
    const edit = await screen.findByRole("button", { name: /Изменить/ });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", "Создание версий не подключено");
  });

  it("правка эффектов создаёт новую версию от выбранной через порт", async () => {
    const parent = ORDER_VERSIONS[0]!;
    const createVersion = vi.fn<ModelVersionsPort["createVersion"]>(
      async (_modelId, body) => ({
        id: "v_created_3",
        model_id: parent.model_id,
        session_id: parent.session_id,
        number: 3,
        parent_id: body.parent_id,
        spec: body.spec,
        spec_hash: computeSpecHash(body.spec),
        approved: false,
      }),
    );
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        port={{ listVersions: vi.fn(), createVersion }}
        onCreated={onCreated}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Изменить/ }));
    expect(screen.getByText("Черновик от версии 1")).toBeInTheDocument();
    // Пока черновик не проверен, трасса не показывается.
    expect(screen.queryByText(/Шаг \d из/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Таблица/ }));
    await user.click(screen.getByRole("button", { name: "Отменить" }));
    const card = screen.getByRole("region", { name: "Переход Отменить" });
    await user.click(within(card).getByRole("button", { name: /Изменить/ }));

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
    await user.type(value, "1");
    expect(
      within(editor).getByText(/Ожидался тип boolean, получен integer/),
    ).toBeInTheDocument();
    expect(
      within(editor).getByRole("button", { name: "Применить к черновику" }),
    ).toBeDisabled();
    await user.clear(value);
    await user.type(value, "false");
    await user.click(
      within(editor).getByRole("button", { name: "Применить к черновику" }),
    );

    expect(
      screen.getByText("Черновик от версии 1 · изменений: 1"),
    ).toBeInTheDocument();
    await user.click(screen.getByText("Что изменится"));
    expect(
      screen.getByText(
        'Cancel: эффекты status := "Cancelled"; cancelled := true → status := "Cancelled"; cancelled := true; approved := false',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Создать версию" }));
    await waitFor(() => expect(createVersion).toHaveBeenCalledTimes(1));
    const [modelId, body, key] = createVersion.mock.calls[0]!;
    expect(modelId).toBe(parent.model_id);
    expect(body.parent_id).toBe(parent.id);
    expect(body.spec.transitions).toEqual(ORDER_FIXED_SPEC.transitions);
    expect(key).toMatch(/^graph-edit-v_fixture_order_1-[0-9a-f]{64}$/);
    // Исходная версия не изменилась.
    expect(parent.spec.transitions[1]!.effects).toHaveLength(2);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(screen.getByRole("combobox", { name: "Версия модели" })).toHaveValue(
      "v_created_3",
    );
    expect(screen.queryByText(/Черновик от версии/)).not.toBeInTheDocument();
  });

  it("показывает отказ сервера с путями и сохраняет черновик", async () => {
    const createVersion = vi.fn<ModelVersionsPort["createVersion"]>(
      async () => {
        throw new ApiError(
          422,
          "INVALID_REQUEST",
          "Request validation failed",
          [
            {
              path: ["body", "spec", "transitions", 1],
              type: "value_error",
              message: "Недостоверная ссылка на требование: Cancel",
            },
          ],
        );
      },
    );
    const user = userEvent.setup();
    render(<Harness port={{ listVersions: vi.fn(), createVersion }} />);
    await user.click(await screen.findByRole("button", { name: /Изменить/ }));
    await user.click(screen.getByRole("button", { name: /Таблица/ }));
    await user.click(screen.getByRole("button", { name: "Исполнить" }));
    await user.click(
      within(
        screen.getByRole("region", { name: "Переход Исполнить" }),
      ).getByRole("button", { name: /Изменить/ }),
    );
    const editor = screen.getByRole("region", {
      name: "Правка перехода Execute",
    });
    const guard = within(editor).getByRole("textbox", {
      name: "Условие (guard)",
    });
    await user.clear(guard);
    await user.type(guard, 'approved == true and status == "Approved"');
    await user.click(
      within(editor).getByRole("button", { name: "Применить к черновику" }),
    );
    await user.click(screen.getByRole("button", { name: "Создать версию" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Сервер отклонил модель");
    expect(alert).toHaveTextContent(
      "body.spec.transitions.1: Недостоверная ссылка на требование: Cancel",
    );
    expect(screen.getByText(/Черновик от версии 1/)).toBeInTheDocument();
  });

  it("сообщает синтаксическую ошибку условия с позицией", async () => {
    const user = userEvent.setup();
    render(
      <Harness port={{ listVersions: vi.fn(), createVersion: vi.fn() }} />,
    );
    await user.click(await screen.findByRole("button", { name: /Изменить/ }));
    await user.click(screen.getByRole("button", { name: /Таблица/ }));
    await user.click(screen.getByRole("button", { name: "Исполнить" }));
    await user.click(
      within(
        screen.getByRole("region", { name: "Переход Исполнить" }),
      ).getByRole("button", { name: /Изменить/ }),
    );
    const guard = screen.getByRole("textbox", { name: "Условие (guard)" });
    await user.clear(guard);
    await user.type(guard, "approved = true");
    expect(
      screen.getByText("Для сравнения используйте == (символ 10)"),
    ).toBeInTheDocument();
  });

  it("отказывается строить слишком большую проекцию и предлагает таблицу", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ width: 900, height: 600 }}>
        <StateGraphWorkspace
          versions={ORDER_VERSIONS}
          selectedVersionId={ORDER_VERSIONS[0]!.id}
          onSelectVersion={() => {}}
          maxNodes={4}
        />
      </div>,
    );
    await user.click(screen.getByText(/Этапы: status/));
    await user.click(screen.getByRole("checkbox", { name: /approved/ }));
    expect(
      screen.getByText(
        /Проекция даёт 8 узлов \(status: 4 × approved: 2\), предел — 4/,
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Открыть таблицу переходов" }),
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
it("блокирует правку и trace overlay при подмене спецификации версии", async () => {
  const version = { ...ORDER_VERSIONS[0]!, spec_hash: "0".repeat(64) };
  render(
    <StateGraphWorkspace
      versions={[version]}
      selectedVersionId={version.id}
      onSelectVersion={() => {}}
      results={[{ ...TLC_ORDER_BUG_RESULT, spec_hash: version.spec_hash }]}
      versionsPort={{ listVersions: vi.fn(), createVersion: vi.fn() }}
    />,
  );
  expect(
    await screen.findByText(/Модель версии не совпадает с её spec_hash/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Изменить" })).toBeDisabled();
  expect(screen.queryByText(/Шаг 3 из 3/)).not.toBeInTheDocument();
});

describe("controls and expanded diagram", () => {
  it("keeps trace and zoom controls outside the pane and operable at narrow width", async () => {
    const user = userEvent.setup();
    const {container} = render(<div style={{width:360,height:600}}><StateGraphWorkspace versions={ORDER_VERSIONS}
      selectedVersionId={ORDER_VERSIONS[0]!.id} onSelectVersion={()=>{}} results={[TLC_ORDER_BUG_RESULT]}/></div>);
    const toolbar=await screen.findByRole("toolbar",{name:"Управление диаграммой"});
    const trace=within(toolbar).getByRole("group",{name:"Шаги трассы"});
    const zoom=within(toolbar).getByRole("group",{name:"Масштаб"});
    expect(trace.closest(".react-flow")).toBeNull();expect(zoom.closest(".react-flow")).toBeNull();
    const expand=within(zoom).getByRole("button",{name:"Развернуть диаграмму"});
    expect(screen.getAllByRole("button",{name:"Развернуть диаграмму"})).toHaveLength(1);
    expect(screen.queryByRole("button",{name:"Вписать граф"})).toBeNull();
    expect(container.querySelector(".pv-canvas-heading")).toBeNull();
    expect(expand).toBe(zoom.lastElementChild);
    await user.click(within(trace).getByRole("button",{name:"Сбросить"}));
    expect(within(trace).getByText("Шаг 0 из 3")).toBeInTheDocument();
    await user.click(within(trace).getByRole("button",{name:"Шаг"}));
    expect(within(trace).getByText("Шаг 1 из 3")).toBeInTheDocument();
    const pane=container.querySelector(".react-flow__pane");
    await user.click(within(zoom).getByRole("button",{name:/сбросить до 100%/}));
    expect(container.querySelector(".react-flow__pane")).toBe(pane);
    expect(within(trace).getByText("Шаг 1 из 3")).toBeInTheDocument();
  });

  it("expands the same graph, keeps selection and changed trace, traps focus and returns it on Escape", async () => {
    const user=userEvent.setup();
    const previousOverflow=document.body.style.overflow;
    const {container}=render(<><button>Вне диаграммы</button><Harness/></>);
    const chip=await screen.findByRole("button",{name:/«Исполнить» \(Execute\): Cancelled → Executed/});
    await user.click(chip);expect(chip).toHaveAttribute("aria-pressed","true");
    const pane=container.querySelector(".react-flow__pane");
    const expand=screen.getByRole("button",{name:"Развернуть диаграмму"});
    await user.click(expand);
    const dialog=screen.getByRole("dialog",{name:/Диаграмма этапов модели/});
    expect(dialog).toHaveAttribute("aria-modal","true");
    expect(container.querySelector(".react-flow__pane")).toBe(pane);
    expect(chip).toHaveAttribute("aria-pressed","true");
    expect(screen.getByRole("button",{name:"Вне диаграммы"})).toHaveAttribute("inert");
    const close=within(dialog).getByRole("button",{name:"Закрыть диаграмму"});
    expect(within(dialog).getAllByRole("button",{name:"Закрыть диаграмму"})).toHaveLength(1);
    expect(within(dialog).queryByRole("button",{name:"Развернуть диаграмму"})).toBeNull();
    expect(within(dialog).queryByRole("button",{name:"Вписать граф"})).toBeNull();
    expect(close).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("button",{name:"Приблизить"})).toHaveFocus();
    await user.keyboard("{Tab}");expect(close).toHaveFocus();
    await user.click(within(dialog).getByRole("button",{name:"Назад"}));
    expect(within(dialog).getByText("Шаг 2 из 3")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button",{name:"Развернуть диаграмму"})).toHaveFocus();
    expect(screen.getByText("Шаг 2 из 3")).toBeInTheDocument();expect(chip).toHaveAttribute("aria-pressed","true");
    expect(screen.getByRole("button",{name:"Вне диаграммы"})).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe(previousOverflow);
    await user.click(screen.getByRole("button",{name:"Развернуть диаграмму"}));
    await user.click(screen.getByRole("button",{name:"Закрыть диаграмму"}));
    expect(screen.getByRole("button",{name:"Развернуть диаграмму"})).toHaveFocus();
  });

  it("restores background and focus when an expanded graph unmounts", async () => {
    const user=userEvent.setup();const outside=document.createElement("button");outside.textContent="outside";document.body.append(outside);
    const {unmount}=render(<Harness/>);
    await user.click(await screen.findByRole("button",{name:"Развернуть диаграмму"}));
    expect(outside).toHaveAttribute("inert");unmount();expect(outside).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");outside.remove();
  });
});
