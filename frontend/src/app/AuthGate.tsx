import { useEffect, useId, useState, type ReactNode } from "react";
import { ApiError, isAbort } from "../api/errors";
import { HttpApi, type AuthSession, type AuthUser } from "../api/http";
import { ErrorNotice, QuietStatus } from "../components/Notice";
import { AccountDialog } from "../components/auth/AccountDialog";
import { AccountForm, type AccountFormMode, type AccountValues } from "../components/auth/AccountForm";
import type { AccountAction } from "../components/auth/AccountMenu";
import { loadLastSession } from "../state/persist";
import { formatRoute } from "./route";

type SignedIn = { kind: "signedIn"; user: AuthUser; api: HttpApi; locked: boolean; resume: number };

type Access =
  | { kind: "checking" | "local" | "signedOut" }
  | { kind: "failed"; error: unknown }
  | SignedIn;

export interface WorkspaceAccount {
  user: AuthUser;
  onAction(action: AccountAction): void;
}

interface Props {
  transport: HttpApi;
  baseUrl: string;
  recovery: { token: string | null } | null;
  onDemo(): void;
  onConnection(): void;
  children(api: HttpApi, account?: WorkspaceAccount, resume?: number): ReactNode;
}

export function AuthGate({ transport, baseUrl, recovery, onDemo, onConnection, children }: Props) {
  const [access, setAccess] = useState<Access>({ kind: recovery ? "signedOut" : "checking" });
  const [token, setToken] = useState(recovery?.token ?? null);
  const [screen, setScreen] = useState<AccountFormMode>(recovery ? recovery.token ? "reset" : "request" : "login");
  const [notice, setNotice] = useState(recovery && !recovery.token ? "Ссылка недействительна. Запросите новую." : "");
  const [email, setEmail] = useState("");
  const [action, setAction] = useState<AccountAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const titleId = useId();

  function accountAccess(session: AuthSession): SignedIn {
    const api = new HttpApi(baseUrl, undefined, {
      ownerId: session.user.id,
      csrfToken: session.csrf_token,
      onAuthError: () => {
        setAction(null);
        setAccess((current) => current.kind === "signedIn" && current.api === api ? { ...current, locked: true } : current);
      },
    });
    return { kind: "signedIn", user: session.user, api, locked: false, resume: 0 };
  }

  const checking = access.kind === "checking";
  useEffect(() => {
    if (!checking) return;
    const controller = new AbortController();
    transport.me(controller.signal).then(
      (session) => { if (!controller.signal.aborted) setAccess(accountAccess(session)); },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        if (error instanceof ApiError && error.status === 404) setAccess({ kind: "local" });
        else if (error instanceof ApiError && error.status === 401) setAccess({ kind: "signedOut" });
        else setAccess({ kind: "failed", error });
      },
    );
    return () => controller.abort();
  }, [transport, checking]);

  const present = (mode: AccountFormMode, message = "") => {
    setScreen(mode);
    setNotice(message);
    if (mode !== "reset") setToken(null);
  };

  const login = async (values: AccountValues) => {
    const session = await transport.login(values.email, values.password);
    setActionError(null);
    if (access.kind === "signedIn" && access.user.id === session.user.id) {
      access.api.resumeAccount(session);
      setAccess({ ...access, user: session.user, locked: false, resume: access.resume + 1 });
    } else {
      const next = accountAccess(session);
      window.history.replaceState(null, "", formatRoute({ sessionId: loadLastSession(next.api) }));
      setAccess(next);
    }
  };

  const submit = async (values: AccountValues) => {
    switch (screen) {
      case "register":
        await transport.register(values.email, values.password);
        setEmail(values.email);
        present("login", "Аккаунт создан. Войдите с новым паролем.");
        break;
      case "request":
        await transport.requestPasswordReset(values.email);
        setNotice("Если такой аккаунт существует, мы отправим ссылку на указанную почту.");
        break;
      case "reset":
        if (!token) return;
        await transport.resetPassword(token, values.password);
        present("login", "Пароль обновлён. Войдите с новым паролем.");
        break;
      default:
        await login(values);
    }
  };

  if (access.kind === "local") return children(transport);
  if (access.kind === "checking") return <main className="auth-screen"><QuietStatus busy>Подключение к серверу</QuietStatus></main>;
  if (access.kind === "failed") return (
    <main className="auth-screen"><section className="auth-card">
      <ErrorNotice title="Не удалось подключиться к Проверялке" error={access.error} />
      <div className="auth-links">
        <button type="button" className="button" onClick={() => setAccess({ kind: "checking" })}>Повторить</button>
        <button type="button" className="button button--ghost" onClick={onConnection}>Подключение</button>
        <button type="button" className="button button--ghost" onClick={onDemo}>Посмотреть демо (без входа)</button>
      </div>
    </section></main>
  );

  if (access.kind === "signedIn") {
    const finish = (message = "") => {
      access.api.suspendAccount();
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setAction(null);
      setEmail(access.user.email);
      present("login", message);
      setAccess({ kind: "signedOut" });
    };
    const logout = async (all: boolean) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        await access.api.logout(all);
        finish();
      } catch (error) {
        setActionError(error);
      } finally {
        setBusy(false);
      }
    };
    const onAction = (next: AccountAction) => {
      setActionError(null);
      if (next === "logout") void logout(false);
      else setAction(next);
    };
    return <>
      <div className="account-workspace" inert={access.locked || action !== null || busy || undefined}>
        {children(access.api, { user: access.user, onAction }, access.resume)}
        {!access.locked && action === null && actionError !== null &&
          <div className="account-error"><ErrorNotice title="Не удалось выйти" error={actionError}
            action={<button type="button" className="button button--small" onClick={() => setActionError(null)}>Закрыть</button>} /></div>}
      </div>
      {access.locked ? (
        <AccountForm key="reauth" mode="login" dialog={{ title: "Войдите снова" }} initialEmail={access.user.email}
          onSubmit={login} />
      ) : action === "change" ? (
        <AccountForm key="change" mode="change" dialog={{ title: "Смена пароля", onClose: () => setAction(null) }}
          onSubmit={async (values) => {
            await access.api.changePassword(values.current_password, values.new_password);
            finish("Пароль обновлён. Войдите с новым паролем.");
          }} />
      ) : action === "all" ? (
        <AccountDialog titleId={titleId} onCancel={busy ? undefined : () => setAction(null)}>
          <header className="dialog__header"><h1 id={titleId}>Завершить все сессии?</h1></header>
          <p>Вы выйдете из аккаунта на всех устройствах.</p>
          {actionError !== null && <ErrorNotice title="Не удалось завершить сессии" error={actionError} />}
          <footer className="dialog__footer">
            <button type="button" className="button button--ghost" onClick={() => setAction(null)} disabled={busy}>Отмена</button>
            <button type="button" className="button button--primary" onClick={() => void logout(true)} disabled={busy}>
              {busy ? "Завершение…" : "Завершить все сессии"}
            </button>
          </footer>
        </AccountDialog>
      ) : null}
    </>;
  }

  return (
    <AccountForm key={screen} mode={screen} initialEmail={email} notice={notice} onSubmit={submit}>
      {screen === "login" ? <>
        <button type="button" className="text-link" onClick={() => present("register")}>Зарегистрироваться</button>
        <button type="button" className="text-link" onClick={() => present("request")}>Забыли пароль?</button>
        <button type="button" className="button button--ghost auth-demo" onClick={onDemo}>Посмотреть демо (без входа)</button>
      </> : <>
        <button type="button" className="text-link" onClick={() => present("login")}>Вернуться ко входу</button>
        {screen === "reset" && <button type="button" className="text-link" onClick={() => present("request")}>Запросить новую ссылку</button>}
      </>}
    </AccountForm>
  );
}
