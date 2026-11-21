import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ApiError } from "../api/errors";
import { HttpApi } from "../api/http";
import type { ReadyInfo } from "../api/types";
import { savePrefs } from "../state/persist";
import { ConnectionDialog } from "./ConnectionDialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ConnectionDialog", () => {
  it("hides technical proxy/GPT/ready details from primary text and puts diagnostics in <details>", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionDialog
        adapter="http"
        baseUrl=""
        ready={{ data: { status: "ready", checker: "tlc 2.19", agent_configured: true }, error: null, loading: false }}
        onApply={vi.fn()}
        onCheckReady={vi.fn(async () => ({ status: "ready" }))}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Подключение" });
    const details = dialog.querySelector("details")!;
    expect(details).toBeTruthy();
    expect(details).not.toHaveAttribute("open");

    // Primary text outside <details> must not leak proxy, GPT, /ready or raw checker string.
    const clone = dialog.cloneNode(true) as HTMLElement;
    clone.querySelector("details")?.remove();
    const primaryText = clone.textContent ?? "";
    expect(primaryText).not.toMatch(/\bproxy\b/i);
    expect(primaryText).not.toMatch(/\bGPT\b/i);
    expect(primaryText).not.toContain("/ready");
    expect(primaryText).not.toContain("tlc 2.19");
    expect(screen.getByPlaceholderText("Оставьте пустым для текущего адреса")).toBeInTheDocument();
    expect(screen.getByText("Сервер доступен")).toBeInTheDocument();

    // Technical diagnostics live inside expandable <details>.
    await user.click(screen.getByText("Технические сведения"));
    expect(details).toHaveAttribute("open");
    expect(within(details).getByText("/ready")).toBeInTheDocument();
    expect(within(details).getByText("tlc 2.19")).toBeInTheDocument();
  });

  it("checks the newly entered URL B while saved URL A stays unapplied, and resets stale status on edit", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCheckReady = vi.fn<(url: string, signal: AbortSignal) => Promise<ReadyInfo>>(
      async () => ({ status: "ready", checker: "tlc-b", agent_configured: true }),
    );

    render(
      <ConnectionDialog
        adapter="http"
        baseUrl="http://server-a.local:8000"
        ready={{ data: { status: "ready", checker: "tlc-a" }, error: null, loading: false }}
        onApply={onApply}
        onCheckReady={onCheckReady}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Сервер доступен: http://server-a.local:8000")).toBeInTheDocument();

    const input = screen.getByLabelText("Адрес API");
    await user.clear(input);
    await user.type(input, "http://server-b.local:9000/");

    // Editing resets previous result immediately.
    expect(screen.queryByText(/Сервер доступен/)).not.toBeInTheDocument();
    expect(screen.getByText(/Адрес изменён/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Проверить" }));
    expect(onCheckReady).toHaveBeenCalledTimes(1);
    expect(onCheckReady.mock.calls[0]![0]).toBe("http://server-b.local:9000");
    expect(onCheckReady.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(onApply).not.toHaveBeenCalled();

    expect(await screen.findByText("Сервер доступен: http://server-b.local:9000")).toBeInTheDocument();

    await user.click(screen.getByText("Технические сведения"));
    expect(screen.getByText("http://server-b.local:9000/ready")).toBeInTheDocument();
    expect(screen.getByText("tlc-b")).toBeInTheDocument();
  });

  it("aborts an in-flight probe when the URL changes and ignores late responses", async () => {
    const user = userEvent.setup();
    const first = deferred<ReadyInfo>();
    const signals: AbortSignal[] = [];
    const onCheckReady = vi.fn<(url: string, signal: AbortSignal) => Promise<ReadyInfo>>(
      (_url, signal) => {
        signals.push(signal);
        return first.promise;
      },
    );

    render(
      <ConnectionDialog
        adapter="http"
        baseUrl="http://server-a.local:8000"
        ready={{ data: null, error: null, loading: false }}
        onApply={vi.fn()}
        onCheckReady={onCheckReady}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Адрес API");
    await user.clear(input);
    await user.type(input, "http://slow-b.local:9000");
    await user.click(screen.getByRole("button", { name: "Проверить" }));
    expect(screen.getByText("Проверка подключения…")).toBeInTheDocument();
    expect(signals[0]?.aborted).toBe(false);

    // Edit URL while check for slow-b is still in flight.
    await user.type(input, "/v2");
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.queryByText("Проверка подключения…")).not.toBeInTheDocument();

    // Late resolution from aborted request must not populate UI.
    first.resolve({ status: "ready", checker: "stale-tlc" });
    await Promise.resolve();
    expect(screen.queryByText(/Сервер доступен/)).not.toBeInTheDocument();
  });

  it("shows check error for the checked URL and clears it when editing", async () => {
    const user = userEvent.setup();
    const onCheckReady = vi.fn<(url: string, signal: AbortSignal) => Promise<ReadyInfo>>(
      async () => {
        throw new ApiError("network", "Failed to fetch");
      },
    );

    render(
      <ConnectionDialog
        adapter="http"
        baseUrl="http://server-a.local:8000"
        ready={{ data: { status: "ready" }, error: null, loading: false }}
        onApply={vi.fn()}
        onCheckReady={onCheckReady}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Адрес API");
    await user.clear(input);
    await user.type(input, "http://offline-b.local:9999");
    await user.click(screen.getByRole("button", { name: "Проверить" }));

    expect(await screen.findByText(/Ошибка для http:\/\/offline-b\.local:9999/)).toBeInTheDocument();

    await user.type(input, "1");
    expect(screen.queryByText(/Ошибка для/)).not.toBeInTheDocument();
  });

  it("App checks entered URL B against B/ready without applying it and hides proxy from sidebar label", async () => {
    savePrefs({ adapter: "http", baseUrl: "", sidebarOpen: true });
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "/openapi.json") {
        return new Response(JSON.stringify({ paths: { "/api/sessions": {} }, components: { schemas: {} } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/sessions?limit=200") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/ready") {
        return new Response(JSON.stringify({ status: "ready", checker: "tlc-saved" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "http://server-b.example:8080/ready") {
        return new Response(JSON.stringify({ status: "ready", checker: "tlc-new-b" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App />);

      const connectionBtn = await screen.findByRole("button", { name: /Подключение: Сервер подключён/ });
      expect(connectionBtn.textContent).not.toMatch(/proxy/i);

      await user.click(connectionBtn);
      const input = screen.getByLabelText("Адрес API");
      await user.type(input, "http://server-b.example:8080");
      await user.click(screen.getByRole("button", { name: "Проверить" }));

      await waitFor(() => expect(requests).toContain("http://server-b.example:8080/ready"));
      expect(await screen.findByText("Сервер доступен: http://server-b.example:8080")).toBeInTheDocument();

      // Connection has NOT been applied yet: no openapi/sessions calls to server-b.
      expect(requests.some((u) => u.startsWith("http://server-b.example:8080/openapi.json"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives current readiness error precedence over retained data (S1) and hides SQLite/Java/TLC from primary status (S5)", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionDialog
        adapter="http"
        baseUrl="http://server-b.local:9000"
        ready={{
          data: { status: "ready", checker: "tlc-from-a", llm_provider: "openai" },
          error: new ApiError("http", "SQLite or Java/TLC is unavailable", { status: 503, code: "DEPENDENCY_UNAVAILABLE" }),
          loading: false,
        }}
        onApply={vi.fn()}
        onCheckReady={vi.fn(async () => ({ status: "ready", llm_provider: "openai" }))}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Подключение" });
    const clone = dialog.cloneNode(true) as HTMLElement;
    clone.querySelector("details")?.remove();
    const primaryText = clone.textContent ?? "";
    expect(primaryText).not.toContain("Сервер доступен");
    expect(primaryText).not.toContain("SQLite");
    expect(primaryText).not.toContain("Java/TLC");
    expect(primaryText).toContain("Сервер не готов к работе");

    await user.click(screen.getByText("Технические сведения"));
    const details = dialog.querySelector("details")!;
    expect(within(details).getByText(/SQLite or Java\/TLC is unavailable/)).toBeInTheDocument();
  });

  it("clears the cancelled candidate probe without showing saved API readiness (S3)", async () => {
    const user = userEvent.setup();
    const pending = deferred<ReadyInfo>();
    render(
      <ConnectionDialog
        adapter="http"
        baseUrl="http://server-a.local:8000"
        ready={{ data: { status: "ready", llm_provider: "anthropic" }, error: null, loading: false }}
        onApply={vi.fn()}
        onCheckReady={vi.fn(() => pending.promise)}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Адрес API");
    await user.clear(input);
    await user.type(input, "http://server-b.local:9000");
    await user.click(screen.getByRole("button", { name: "Проверить" }));
    expect(screen.getByText("Проверка подключения…")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Демо на записанных данных/));
    await user.click(screen.getByLabelText(/Сервер Проверялки/));
    expect(screen.queryByText("Проверка подключения…")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Адрес API")).toHaveValue("http://server-b.local:9000");
    expect(screen.getByText(/Адрес изменён/)).toBeInTheDocument();
    expect(screen.queryByText(/Сервер доступен/)).not.toBeInTheDocument();
  });

  it.each([{ unrelated: true }, { status: "ready", llm_provider: { name: "openai" } }])("rejects malformed ready payload %j (S4)", async (payload) => {
    const api = new HttpApi("http://unrelated.example", vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    await expect(api.ready()).rejects.toThrow(/Ответ \/ready не подтверждает готовность/);
  });

  it("refreshes App readiness state when probing the active URL (S2) and preserves URL input focus on rerender (F12)", async () => {
    savePrefs({ adapter: "http", baseUrl: "", sidebarOpen: true });
    const activeProbe = deferred<Response>();
    let readyRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/openapi.json") {
        return new Response(JSON.stringify({
          paths: { "/api/sessions": {}, "/api/sessions/{session_id}/messages": {} },
          components: { schemas: {} },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/sessions?limit=200") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/ready") {
        const request = readyRequests++;
        if (request > 1) return activeProbe.promise;
        if (request === 1) return new Response(JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable" },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ status: "ready", checker: "TLC", agent_configured: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const user = userEvent.setup();
      render(<App />);

      expect(await screen.findByText(/Агент не настроен/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /Подключение/ }));

      await user.click(screen.getByRole("button", { name: "Проверить" }));
      expect(await screen.findByText("Сервер не готов к работе")).toBeInTheDocument();
      expect(screen.getByText(/Агент не настроен/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Проверить" }));
      await user.click(screen.getByText("Технические сведения"));
      const input = screen.getByLabelText("Адрес API");
      input.focus();
      await act(async () => {
        activeProbe.resolve(new Response(JSON.stringify({ status: "ready", llm_provider: "openai", agent_configured: true })));
      });
      expect(await screen.findByText("openai")).toBeInTheDocument();
      expect(input).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Отмена" }));
      await waitFor(() => expect(screen.queryByText(/Агент не настроен/)).not.toBeInTheDocument());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains readiness when connecting again to an equivalent API URL", async () => {
    const base = "http://server-a.local:8000";
    savePrefs({ adapter: "http", baseUrl: base, sidebarOpen: true });
    let readyRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = String(input).slice(base.length);
      if (path === "/openapi.json") {
        return Response.json({ paths: { "/api/sessions": {}, "/api/sessions/{session_id}/messages": {} } });
      }
      if (path === "/api/sessions?limit=200") return Response.json([]);
      if (path === "/api/auth/me") return Response.json({}, { status: 404 });
      if (path === "/ready" && readyRequests++ === 0) return Response.json({ status: "ready", agent_configured: false });
      return Response.json({}, { status: 503 });
    }));

    try {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText(/Агент не настроен/);
      await user.click(screen.getByRole("button", { name: /^Подключение/ }));
      await user.type(screen.getByLabelText("Адрес API"), "/");
      await user.click(screen.getByRole("button", { name: /^Подключить$/ }));
      expect(screen.getByText(/Агент не настроен/)).toBeInTheDocument();
      expect(readyRequests).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
