import { useCallback, useRef, useState, type FormEvent } from "react";
import type { GitConnection, GitConnectionsApi } from "../../api/repositories";
import { ErrorNotice, QuietStatus } from "../Notice";
import { useRepositoryLoad } from "./useRepositoryLoad";

const STATE = { active: "Действует", expired: "Срок истёк", revoked: "Отозвано" };
const time = (seconds: number) => new Date(seconds * 1000).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });

export function GitConnections({ api, initialRemote, fixedRemote, onCreated, onBack, onBusy }: {
  api: GitConnectionsApi;
  initialRemote?: string;
  fixedRemote?: boolean;
  onCreated?(connection: GitConnection): void;
  onBack?(): void;
  onBusy?(busy: boolean): void;
}) {
  const list = useRepositoryLoad(useCallback(signal => api.list(signal), [api]));
  const [editing, setEditing] = useState(initialRemote !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; error: unknown } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const token = useRef<HTMLInputElement>(null);

  async function perform(title: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    onBusy?.(true);
    setError(null);
    try {
      await operation();
      list.reload();
    } catch (failure) {
      setError({ title, error: failure });
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !token.current) return;
    const form = new FormData(event.currentTarget);
    const body = {
      remote_url: String(form.get("remote")).trim(),
      expires_at: new Date(String(form.get("expires"))).getTime() / 1000,
      token: token.current.value,
    };
    token.current.value = "";
    void perform("Подключение не сохранено", async () => {
      const connection = await api.create(body);
      setEditing(false);
      onCreated?.(connection);
    });
  }

  return <>
    {onBack && <button type="button" className="button button--small" onClick={onBack} disabled={busy}>К импорту</button>}
    {list.loading && <QuietStatus busy>Загрузка подключений</QuietStatus>}
    {list.error !== null && <ErrorNotice title="Подключения не загружены" error={list.error}
      action={<button type="button" className="button button--small" onClick={list.reload}>Повторить</button>} />}
    {list.data?.length === 0 && <p className="muted">Нет сохранённых подключений</p>}
    {list.data && list.data.length > 0 && <ul className="git-connections">
      {list.data.map(connection => <li key={connection.id}>
        <strong>{connection.remote_url}</strong>
        <p className="small muted">{STATE[connection.state]} · до {time(connection.expires_at)}</p>
        {connection.last_checked_at !== null && <p className={`small ${connection.last_error ? "warn-text" : "muted"}`}>
          {connection.last_error ? `Доступ не подтверждён · ${connection.last_error}` : "Доступ подтверждён"} · {time(connection.last_checked_at)}
        </p>}
        {connection.state !== "revoked" && <div className="repository-actions">
          <button type="button" className="button button--small" disabled={busy || connection.state !== "active"} onClick={() =>
            void perform("Проверка доступа не выполнена", async () => { await api.check(connection.id); })}>Проверить доступ</button>
          {confirmRevoke === connection.id ? <>
            <button type="button" className="button button--small" disabled={busy} onClick={() => void perform("Подключение не отозвано", async () => {
              await api.revoke(connection.id);
              setConfirmRevoke(null);
            })}>Удалить токен</button>
            <button type="button" className="button button--small button--ghost" disabled={busy} onClick={() => setConfirmRevoke(null)}>Отмена</button>
          </> : <button type="button" className="button button--small button--ghost" disabled={busy}
            onClick={() => setConfirmRevoke(connection.id)}>Отозвать</button>}
        </div>}
      </li>)}
    </ul>}
    {error && <ErrorNotice title={error.title} error={error.error} />}
    {editing ? (
      <form className="repository-form" autoComplete="off" onSubmit={create}>
        <label>URL репозитория<input name="remote" type="url" className="input" defaultValue={initialRemote} readOnly={fixedRemote} required maxLength={500} /></label>
        <label>Токен для чтения<input ref={token} type="password" className="input" autoComplete="off" required minLength={10} maxLength={4096} /></label>
        <label>Действует до<input name="expires" type="datetime-local" className="input" required /></label>
        <div className="repository-actions">
          <button className="button button--primary" disabled={busy}>Сохранить подключение</button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
        </div>
      </form>
    ) : <button type="button" className="button" disabled={busy} onClick={() => setEditing(true)}>+ Добавить подключение</button>}
    {busy && <QuietStatus busy>Обновление подключения</QuietStatus>}
  </>;
}
