import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEGEN_VERSION,
  createRecordedCodegenProvider,
  RECORDED_GENERATION as generation,
} from "../../../frontend-extensions/src/fixtures/codegen";
import { DemoApi } from "../api/demo";
import { resetExtensions, workspaceViews } from "../app/extensions";
import type { WorkspaceContextValue } from "../app/workspace";
import { configureFilesForAdapter, focusGeneratedFile, loadExtensions } from "./load";

afterEach(() => {
  configureFilesForAdapter("demo");
  resetExtensions();
  vi.unstubAllGlobals();
});

it("opens the saved generation referenced by chat on the configured backend and scopes focus to its version", async () => {
  const recorded = createRecordedCodegenProvider();
  const available = await recorded.status();
  if (!available.available) throw new Error(available.reason);
  const api = new DemoApi();
  const [demoVersion] = await api.listVersions("demo_m_order");
  const version = { ...demoVersion!, ...CODEGEN_VERSION };
  const nextVersion = { ...version, id: "new_version", number: version.number + 1 };
  const context: WorkspaceContextValue = {
    api,
    capabilities: await api.capabilities(),
    session: await api.getSession("demo_s_order"),
    versions: [version, nextVersion],
    version,
    requirements: null,
    checks: [],
    trace: null,
    selection: { versionId: version.id, element: null, trace: null },
    select: vi.fn(),
    focusTrace: vi.fn(),
    selectVersion: vi.fn(),
    setTraceStep: vi.fn(),
    openView: vi.fn(),
  };
  const latest = { ...generation, generation_id: "new_generation" };
  const base = "https://proveryalka.example.test";
  const versionPath = (number: number) => `/api/models/${version.model_id}/versions/${number}/generations`;
  const fetcher = vi.fn(async (url: string) => {
    expect(url).toMatch(/^https:\/\/proveryalka\.example\.test\//);
    const { pathname } = new URL(url);
    if (pathname === "/api/codegen/status") return Response.json(available.status);
    if (pathname === versionPath(version.number)) {
      return Response.json([generation, latest], { headers: { "X-TLC-Verification-State": "violated" } });
    }
    if (pathname === versionPath(nextVersion.number)) {
      return Response.json([], { headers: { "X-TLC-Verification-State": "not_checked" } });
    }
    if (pathname.endsWith("/test-runs")) return Response.json([]);
    const path = pathname.split("/files/")[1];
    if (path) {
      const file = await recorded.readFile(generation.generation_id, path);
      return new Response(new TextDecoder().decode(file.bytes), {
        headers: { "X-Content-SHA256": file.sha256Header! },
      });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  loadExtensions();
  configureFilesForAdapter("http", base);
  const Files = workspaceViews().find((view) => view.id === "files")!.component;
  const view = render(<Files context={context} />);
  expect(await screen.findByRole("combobox", { name: "Генерация" })).toHaveValue(latest.generation_id);

  act(() => focusGeneratedFile({ generation_id: generation.generation_id, version_id: version.id, path: "app/rules.py" }));
  expect(await screen.findByLabelText("Содержимое app/rules.py")).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith(
    `${base}/api/generations/${generation.generation_id}/files/app/rules.py`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.getByRole("combobox", { name: "Генерация" })).toHaveValue(generation.generation_id);

  view.rerender(<Files context={{ ...context, version: nextVersion }} />);
  expect(await screen.findByText(/Утверждённая версия .*TLC: not_checked/)).toBeVisible();
  expect(screen.queryByLabelText("Содержимое app/rules.py")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
