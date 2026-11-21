import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DemoApi } from "../api/demo";
import type { FileContextRef, ModelVersion } from "../api/types";
import { focusGeneratedFile } from "../extensions/load";
import { SessionView } from "./SessionView";

vi.mock("../extensions/load", () => ({ focusGeneratedFile: vi.fn() }));

it.each(["loaded", "retry", "missing"])("keeps a chat file link while versions load (%s)", async (outcome) => {
  vi.mocked(focusGeneratedFile).mockClear();
  const api = new DemoApi();
  const sessionId = "demo_s_order";
  const session = await api.getSession(sessionId);
  const versions = await api.listVersions("demo_m_order");
  const target = versions[0]!;
  const ref: FileContextRef = {
    generation_id: "gen_saved",
    version_id: target.id,
    version_number: target.number,
    path: "app/rules.py",
    sha256: "b".repeat(64),
  };
  const dialogue = await api.getDialogue(sessionId);
  api.getDialogue = async () => ({
    ...dialogue,
    entries: [{
      id: "file_message", sequence: 1, created_at: "2026-11-21T01:00:00Z",
      kind: "user", text: "Объясни правила", file_context: ref,
    }],
  });
  let finish!: (versions: ModelVersion[]) => void;
  let fail!: (cause: Error) => void;
  const firstLoad = new Promise<ModelVersion[]>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  api.listVersions = vi.fn().mockReturnValueOnce(firstLoad).mockResolvedValue(versions);
  const navigate = vi.fn();
  render(<SessionView api={api} capabilities={await api.capabilities()} sessionId={sessionId}
    listed={session} route={{ sessionId }} navigate={navigate} />);

  fireEvent.click(await screen.findByRole("button", { name: /Файл app\/rules\.py/ }));
  expect(screen.getByText("Загрузка версии для файла app/rules.py")).toBeVisible();
  expect(navigate).not.toHaveBeenCalled();
  expect(focusGeneratedFile).not.toHaveBeenCalled();

  if (outcome === "retry") {
    await act(async () => { fail(new Error("offline")); });
    expect(screen.getByText("Не удалось загрузить версию для файла app/rules.py")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку версий" }));
  } else {
    await act(async () => { finish(outcome === "missing" ? versions.slice(1) : versions); });
  }
  if (outcome === "missing") {
    expect(screen.getByText("Версия модели из ссылки не найдена")).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    expect(focusGeneratedFile).not.toHaveBeenCalled();
    return;
  }
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId, modelId: target.model_id, version: target.number, view: "files" }),
    { replace: true },
  ));
  expect(focusGeneratedFile).toHaveBeenCalledExactlyOnceWith(ref);
});
