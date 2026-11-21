import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { DemoApi, LIVE_RECORDING } from "../api/demo";
import { HttpApi } from "../api/http";
import { loadLocal, updateLocal, loadLastSession, saveLastSession, savePrefs } from "../state/persist";

const PASSWORD = "Password for tests 123";
const TOKEN = "z".repeat(43);
const alice = { id: "alice", email: "alice@example.com" };
const bob = { id: "bob", email: "bob@example.com" };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const failure = (status: number, code: string, details?: unknown[]) => json({ error: { code, message: code, details } }, status);
const empty = () => new Response(null, { status: 204 });

function server(initial: typeof alice | null = null, enabled = true) {
  let user = initial;
  let csrf = "csrf-me";
  let loginCount = 0;
  let holdRegistration: Promise<Response> | null = null;
  let documentUploaded = false;
  let nextRead: { path: string; response: Promise<Response> } | null = null;
  const accounts = new Map([[alice.email, alice], [bob.email, bob]]);
  const session = () => ({
    id: `chat-${user?.id ?? "local"}`, title: `Чат ${user?.id ?? "local"}`,
    created_at: "2026-10-31T10:00:00Z", mode: "analyzer",
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).split("?")[0]!;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (path === "/ready") return json({ status: "ready" });
    if (path === "/openapi.json") return json({
      paths: { "/api/sessions": {}, "/api/sessions/{session_id}/messages": {}, "/api/sessions/{session_id}/documents": {} },
      components: { schemas: { MessageCreate: { properties: { base_version_id: {} } } } },
    });
    if (path === "/api/auth/me") return !enabled ? failure(404, "HTTP_ERROR")
      : user ? json({ user, csrf_token: csrf }) : failure(401, "AUTH_REQUIRED");
    if (path === "/api/auth/login") {
      const body = JSON.parse(String(init?.body));
      const account = accounts.get(body.email);
      if (!account || body.password !== PASSWORD) return failure(401, "INVALID_CREDENTIALS");
      user = account;
      csrf = `csrf-login-${++loginCount}`;
      return json({ user, csrf_token: csrf });
    }
    if (path === "/api/auth/register") return holdRegistration ?? json({}, 201);
    if (path === "/api/auth/password/reset-request") return json({}, 202);
    if (path === "/api/auth/password/reset") return JSON.parse(String(init?.body)).token === TOKEN ? empty() : failure(400, "RESET_INVALID");
    if (enabled && !user) return failure(401, "AUTH_REQUIRED");
    if (enabled && method === "GET" && headers.has("X-CSRF-Token") && headers.get("X-CSRF-Token") !== csrf) {
      return failure(401, "AUTH_REQUIRED");
    }
    if (enabled && method !== "GET" && headers.get("X-CSRF-Token") !== csrf) return failure(403, "CSRF_INVALID");
    if (method === "GET" && nextRead?.path === path) {
      const { response } = nextRead;
      nextRead = null;
      return response;
    }
    if (path === "/api/auth/sessions" || path === "/api/auth/logout") {
      user = null;
      return empty();
    }
    if (path === "/api/auth/password") return JSON.parse(String(init?.body)).current_password === PASSWORD
      ? empty() : failure(401, "INVALID_CREDENTIALS");
    if (path === "/api/sessions") return json([session()]);
    if (path === `/api/sessions/${session().id}`) return json({
      ...session(), messages: [], sources: [], requirements: [],
      documents: documentUploaded ? [{ source_id: "uploaded-source", filename: "rules.txt", size_bytes: 14, characters: 7 }] : [],
    });
    if (path === `/api/sessions/${session().id}/models`) return json([]);
    if (path === `/api/sessions/${session().id}/documents` && method === "POST") {
      documentUploaded = true;
      return json({
        source: { id: "uploaded-source", text: "Правила", session_id: session().id },
        document: { source_id: "uploaded-source", filename: "rules.txt", size_bytes: 14, characters: 7 },
      }, 201);
    }
    if (path === `/api/sessions/${session().id}/messages` && method === "POST") {
      return json({ run_id: "saved-send", session_id: session().id, state: "completed", version_id: null, error_code: null }, 202);
    }
    return failure(404, "NOT_FOUND");
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    expire: () => { user = null; },
    registration: (response: Promise<Response>) => { holdRegistration = response; },
    nextRead: (path: string, response: Promise<Response>) => { nextRead = { path, response }; },
    requests: (path: string) => fetcher.mock.calls.filter(([url]) => String(url) === path).map(([, init]) => init!),
  };
}

const fill = (field: string, value: string, scope = screen) => fireEvent.change(scope.getByLabelText(field, { exact: true }), { target: { value } });

function signIn(email: string, dialog?: HTMLElement) {
  const scope = dialog ? within(dialog) : screen;
  fireEvent.change(scope.getByLabelText("Электронная почта"), { target: { value: email } });
  fireEvent.change(scope.getByLabelText("Пароль", { exact: true }), { target: { value: PASSWORD } });
  fireEvent.click(scope.getByRole("button", { name: "Войти" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

it("reopens the workspace without a login on a local backend and keeps anonymous legacy drafts", async () => {
  const service = server(null, false);
  localStorage.setItem("proveryalka:v1:http:same-origin:session:__new__", JSON.stringify({ draft: "До добавления аккаунтов" }));
  render(<App />);
  expect(await screen.findByRole("textbox", { name: "Описание поведения" })).toHaveValue("До добавления аккаунтов");
  expect(await screen.findByRole("button", { name: /Чат local/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Аккаунт/ })).not.toBeInTheDocument();
  expect(service.requests("/api/auth/me")[0]?.credentials).toBe("include");
});

it("opens recorded demo from login without asking the protected backend for sessions", async () => {
  const service = server();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Посмотреть демо (без входа)" }));
  expect(await screen.findByRole("button", { name: /Заявка: отмена и исполнение/ })).toBeInTheDocument();
  expect(service.requests("/api/sessions?limit=200")).toEqual([]);
});

it("waits for demo capabilities before reopening the last recorded chat on an HTTP to demo switch", async () => {
  server(null, false);
  saveLastSession("demo", LIVE_RECORDING.session.id);
  const demoCapabilities = await new DemoApi().capabilities();
  let finishDiscovery!: () => void;
  vi.spyOn(DemoApi.prototype, "capabilities").mockImplementation(
    () => new Promise((resolve) => { finishDiscovery = () => resolve(demoCapabilities); }),
  );
  const openRecordedChat = vi.spyOn(DemoApi.prototype, "getSession");
  render(<App />);
  await screen.findByRole("textbox", { name: "Описание поведения" });
  fireEvent.click(screen.getByRole("button", { name: /Подключение: Сервер/ }));
  const connection = within(screen.getByRole("dialog", { name: "Подключение" }));
  fireEvent.click(connection.getByRole("radio", { name: /Демо на записанных данных/ }));
  fireEvent.click(connection.getByRole("button", { name: "Подключить" }));
  expect(openRecordedChat).not.toHaveBeenCalled();
  await act(async () => finishDiscovery());
  const timeline = within(await screen.findByRole("list", { name: "История диалога" }));
  expect(await timeline.findByText("Проверка версии 1")).toBeInTheDocument();
  expect(await timeline.findByText("Проверка версии 2")).toBeInTheDocument();
  expect(openRecordedChat).toHaveBeenCalledWith(LIVE_RECORDING.session.id, expect.any(AbortSignal));
});

const aliceBookmark = "#/s/chat-alice?m=model-a&v=2&view=check&check=run-a&p=rule-a&step=3";

it("authorizes the bookmarked chat after an expired cookie and preserves the complete check route", async () => {
  const service = server(alice);
  service.expire();
  window.history.replaceState(null, "", aliceBookmark);
  saveLastSession({ id: "http:same-origin", ownerId: alice.id }, "previous-chat");
  let authorize!: () => void;
  service.nextRead("/api/sessions/chat-alice", new Promise((resolve) => {
    authorize = () => resolve(json({
      id: "chat-alice", title: "Чат alice", created_at: "2026-10-31T10:00:00Z", mode: "analyzer",
      messages: [], sources: [], requirements: [],
    }));
  }));
  render(<App />);
  await screen.findByRole("heading", { name: "Вход" });
  signIn(alice.email);

  await screen.findByText("Открываем чат");
  expect(service.requests("/api/sessions?limit=200")).toEqual([]);
  expect(new Headers(service.requests("/api/sessions/chat-alice")[0]?.headers).get("X-CSRF-Token")).toBe("csrf-login-1");
  await act(async () => authorize());
  expect(await screen.findByRole("heading", { name: "Чат alice" })).toBeInTheDocument();
  expect(window.location.hash).toBe(aliceBookmark);
});

it("falls back to the incoming owner's last chat when the bookmarked chat is forbidden by ownership", async () => {
  const service = server();
  const scope = { id: "http:same-origin", ownerId: bob.id };
  saveLastSession(scope, "chat-bob");
  window.history.replaceState(null, "", aliceBookmark);
  render(<App />);
  await screen.findByRole("heading", { name: "Вход" });
  signIn(bob.email);

  expect(await screen.findByRole("heading", { name: "Чат bob" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/s/chat-bob");
  expect(loadLastSession(scope)).toBe("chat-bob");
  expect(service.requests("/api/sessions/chat-alice")).toHaveLength(1);
  expect(service.requests("/api/sessions/chat-alice/models")).toEqual([]);
});

it("keeps the bookmarked route when authorization is temporarily unavailable and retries with the existing login", async () => {
  const service = server();
  service.nextRead("/api/sessions/chat-alice", Promise.resolve(failure(503, "STORAGE_UNAVAILABLE")));
  window.history.replaceState(null, "", aliceBookmark);
  render(<App />);
  await screen.findByRole("heading", { name: "Вход" });
  signIn(alice.email);

  expect(await screen.findByText("Не удалось открыть чат")).toBeInTheDocument();
  expect(window.location.hash).toBe(aliceBookmark);
  expect(service.requests("/api/sessions?limit=200")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

  expect(await screen.findByRole("heading", { name: "Чат alice" })).toBeInTheDocument();
  expect(window.location.hash).toBe(aliceBookmark);
  expect(service.requests("/api/auth/login")).toHaveLength(1);
});

it("keeps the same session and draft after reauthentication, then isolates a different user in the same browser", async () => {
  const service = server(alice);
  render(<StrictMode><App /></StrictMode>);
  fireEvent.click(await screen.findByRole("button", { name: /Чат alice/ }));
  const draft = await screen.findByRole("textbox", { name: "Сообщение агенту" });
  fireEvent.change(draft, { target: { value: "Черновик Алисы" } });

  service.expire();
  fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
  let dialog = await screen.findByRole("dialog", { name: "Войдите снова" });
  expect(draft.closest(".account-workspace")).toHaveAttribute("inert");
  expect(within(dialog).getByLabelText("Электронная почта")).toHaveValue(alice.email);
  signIn(alice.email, dialog);

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "Сообщение агенту" })).toBe(draft);
  expect(draft).toHaveValue("Черновик Алисы");
  const retry = screen.getByRole("button", { name: "Повторить отправку" });
  service.expire();
  fireEvent.click(retry);
  dialog = await screen.findByRole("dialog", { name: "Войдите снова" });
  signIn(bob.email, dialog);

  expect(await screen.findByRole("button", { name: /Чат bob/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Чат alice/ })).not.toBeInTheDocument();
  expect(draft).not.toBeInTheDocument();
  const bobDraft = screen.getByRole("textbox", { name: "Описание поведения" });
  expect(bobDraft).toHaveValue("");
  fireEvent.change(bobDraft, { target: { value: "Черновик Боба" } });

  const keyboard = userEvent.setup();
  const menu = screen.getByRole("button", { name: `Аккаунт ${bob.email}` });
  menu.focus();
  await keyboard.keyboard("{Enter}");
  await keyboard.tab();
  expect(screen.getByRole("button", { name: "Сменить пароль" })).toHaveFocus();
  await keyboard.keyboard("{Escape}");
  expect(menu).toHaveFocus();
  expect(menu).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(menu);
  fireEvent.click(screen.getByRole("button", { name: "Завершить все сессии" }));
  const confirm = screen.getByRole("dialog", { name: "Завершить все сессии?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Завершить все сессии" }));
  await screen.findByRole("heading", { name: "Вход" });
  signIn(alice.email);
  expect(await screen.findByRole("textbox", { name: "Сообщение агенту" })).toHaveValue("Черновик Алисы");
  expect(screen.queryByRole("button", { name: /Чат bob/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
  await waitFor(() => expect(service.requests("/api/sessions/chat-alice/messages")).toHaveLength(3));
  const sends = service.requests("/api/sessions/chat-alice/messages");
  expect(sends.map((init) => new Headers(init.headers).get("X-CSRF-Token")))
    .toEqual(["csrf-me", "csrf-login-1", "csrf-login-3"]);
  expect(sends[0]?.credentials).toBe("include");
  expect(new Set(sends.map((init) => new Headers(init.headers).get("Idempotency-Key"))).size).toBe(1);
  const all = service.requests("/api/auth/sessions")[0]!;
  expect(all.method).toBe("DELETE");
  expect(new Headers(all.headers).get("X-CSRF-Token")).toBe("csrf-login-2");
  const browserStorage = JSON.stringify([localStorage, sessionStorage]);
  expect(browserStorage).not.toContain("csrf-");
  expect(browserStorage).not.toContain(PASSWORD);
  expect(loadLocal({ id: "http:same-origin", ownerId: bob.id }, "__new__").draft).toBe("Черновик Боба");
});

it("retries an interrupted document upload in the existing chat with the same file and key", async () => {
  const service = server(alice);
  const { container } = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Чат alice/ }));
  await screen.findByRole("button", { name: "Приложить документ TXT, MD или DOCX" });
  const file = new File(["Правила"], "rules.txt");
  const picker = container.querySelector('input[type="file"]')!;
  const path = "/api/sessions/chat-alice/documents";
  service.expire();
  fireEvent.change(picker, { target: { files: [file] } });
  signIn(alice.email, await screen.findByRole("dialog", { name: "Войдите снова" }));
  fireEvent.click(await screen.findByRole("button", { name: "Повторить загрузку" }));

  expect(await screen.findByText("rules.txt")).toBeVisible();
  const uploads = service.requests(path);
  expect(uploads).toHaveLength(2);
  expect(new Headers(uploads[1]?.headers).get("Idempotency-Key"))
    .toBe(new Headers(uploads[0]?.headers).get("Idempotency-Key"));
  expect((uploads[1]?.body as FormData).get("file")).toBe(file);
});

it("validates registration fields, shows pending submission, and maps server errors to the field", async () => {
  const service = server();
  let decide!: (response: Response) => void;
  service.registration(new Promise((resolve) => { decide = resolve; }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Зарегистрироваться" }));
  const submit = screen.getByRole("button", { name: "Создать аккаунт" });
  fill("Электронная почта", "broken");
  fill("Пароль", PASSWORD);
  fill("Повторите пароль", "another password");
  fireEvent.click(submit);
  expect(screen.getByLabelText("Электронная почта")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Повторите пароль")).toHaveAccessibleDescription("Пароли должны совпадать.");
  expect(service.requests("/api/auth/register")).toHaveLength(0);

  fill("Электронная почта", alice.email);
  fill("Повторите пароль", PASSWORD);
  fireEvent.click(submit);
  expect(screen.getByRole("button", { name: "Создание аккаунта…" })).toBeDisabled();
  await act(async () => decide(failure(422, "INVALID_REQUEST", [{ path: ["body", "email"] }])));
  expect(screen.getByLabelText("Электронная почта")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Электронная почта")).toHaveFocus();

  service.registration(Promise.resolve(failure(409, "ACCOUNT_EXISTS")));
  fireEvent.click(submit);
  expect(await screen.findByText("Аккаунт с этой почтой уже существует.")).toBeInTheDocument();
  service.registration(Promise.resolve(json({ user: alice }, 201)));
  fireEvent.click(submit);
  expect(await screen.findByText("Аккаунт создан. Войдите с новым паролем.")).toBeInTheDocument();
  expect(screen.getByLabelText("Электронная почта")).toHaveValue(alice.email);
  expect(screen.getByLabelText("Пароль", { exact: true })).toHaveValue("");
});

it("requests recovery and opens a reset link at the server origin even when demo was selected", async () => {
  const service = server();
  const first = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Забыли пароль?" }));
  fill("Электронная почта", alice.email);
  fireEvent.click(screen.getByRole("button", { name: "Отправить ссылку" }));
  expect(await screen.findByText(/Если такой аккаунт существует/)).toBeInTheDocument();
  expect(JSON.parse(String(service.requests("/api/auth/password/reset-request")[0]?.body))).toEqual({ email: alice.email });
  first.unmount();

  savePrefs({ adapter: "demo", baseUrl: "http://other-origin.example", sidebarOpen: true });
  window.history.replaceState(null, "", `/reset-password#token=${TOKEN}`);
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Установка нового пароля" })).toBeInTheDocument();
  expect(window.location.pathname + window.location.hash).toBe("/");
  fill("Новый пароль", PASSWORD);
  fill("Повторите пароль", PASSWORD);
  fireEvent.click(screen.getByRole("button", { name: "Установить пароль" }));
  expect(await screen.findByText("Пароль обновлён. Войдите с новым паролем.")).toBeInTheDocument();
  expect(JSON.parse(String(service.requests("/api/auth/password/reset")[0]?.body))).toEqual({ password: PASSWORD, token: TOKEN });
  expect(JSON.stringify([localStorage, sessionStorage])).not.toContain(TOKEN);
});

it("shows an invalid current password in the password dialog and signs out after a successful change", async () => {
  const service = server(bob);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: `Аккаунт ${bob.email}` }));
  fireEvent.click(screen.getByRole("button", { name: "Сменить пароль" }));
  const dialog = screen.getByRole("dialog", { name: "Смена пароля" });
  const scope = within(dialog);
  fireEvent.change(scope.getByLabelText("Текущий пароль"), { target: { value: "wrong" } });
  fireEvent.change(scope.getByLabelText("Новый пароль"), { target: { value: PASSWORD + " new" } });
  fireEvent.change(scope.getByLabelText("Повторите пароль"), { target: { value: PASSWORD + " new" } });
  fireEvent.click(scope.getByRole("button", { name: "Сменить пароль" }));
  expect(await scope.findByText("Неверный текущий пароль.")).toBeInTheDocument();
  fireEvent.change(scope.getByLabelText("Текущий пароль"), { target: { value: PASSWORD } });
  fireEvent.click(scope.getByRole("button", { name: "Сменить пароль" }));
  expect(await screen.findByText("Пароль обновлён. Войдите с новым паролем.")).toBeInTheDocument();
  expect(service.requests("/api/auth/password").map((init) => new Headers(init.headers).get("X-CSRF-Token"))).toEqual(["csrf-me", "csrf-me"]);
});

it("scopes both drafts and all run/outbox metadata per account and keeps legacy lookups anonymous", () => {
  const adapter = new HttpApi().id;
  const owner = { id: adapter, ownerId: alice.id };
  const otherOwner = { id: adapter, ownerId: bob.id };
  const record = { draft: "draft", outbox: { text: "unsent", questionId: null, key: "key" },
    agentRuns: [{ runId: "run", text: "original", questionId: null, startedAt: "date" }],
    checkRuns: [{ runId: "check", versionId: "version", modelId: "model", number: 1, propertyIds: null, startedAt: "date" }] };
  localStorage.setItem("proveryalka:v1:prefs", JSON.stringify({ lastSession: { [adapter]: "legacy" } }));
  updateLocal(owner, "shared", () => record);
  saveLastSession(owner, "shared");
  expect(loadLocal(owner, "shared")).toMatchObject(record);
  expect(loadLocal(otherOwner, "shared")).toMatchObject({ draft: "", outbox: null, agentRuns: [], checkRuns: [] });
  expect(loadLocal(adapter, "shared")).toMatchObject({ draft: "", outbox: null, agentRuns: [], checkRuns: [] });
  expect(loadLastSession(owner)).toBe("shared");
  expect(loadLastSession(otherOwner)).toBeNull();
  expect(loadLastSession(adapter)).toBe("legacy");
});
