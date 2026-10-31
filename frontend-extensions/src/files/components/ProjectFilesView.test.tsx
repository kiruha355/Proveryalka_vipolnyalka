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
import type { TestRun } from "../contract";
import { SplitPane } from "../../ui/SplitPane";

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
    expect(screen.getByText(/TLC: holds/)).toBeInTheDocument();
  });
  it("требует явного подтверждения после VERIFICATION_REQUIRED и не запускает тесты автоматически", async () => {
    const p = createRecordedCodegenProvider();
    p.listGenerations = async () => [];
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
    expect(await screen.findByText(/TLC: violated/)).toBeInTheDocument();
    expect(p.createGeneration).toHaveBeenLastCalledWith(
      version,
      { allowUnverified: true },
      expect.any(String),
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
