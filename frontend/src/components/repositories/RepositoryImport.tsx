import { useCallback, useRef, useState, type FormEvent } from "react";
import { newKey } from "../../api/api";
import type { GitConnectionsApi, RepositoryImport as ImportBody } from "../../api/repositories";
import { ErrorNotice, QuietStatus } from "../Notice";
import { GitConnections } from "./GitConnections";
import { useRepositoryLoad } from "./useRepositoryLoad";

function canonicalUrl(url: string) {
  return url.trim().replace(/\/$/, "").replace(/\.git$/, "");
}

export function RepositoryImport({ connections, refreshUrl, submit, onBusy }: {
  connections?: GitConnectionsApi;
  refreshUrl?: string;
  submit(body: ImportBody, key: string): Promise<void>;
  onBusy(busy: boolean): void;
}) {
  const [remote, setRemote] = useState(refreshUrl ?? "");
  const [ref, setRef] = useState("");
  const [credential, setCredential] = useState("");
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const list = useRepositoryLoad(useCallback(signal => connections ? connections.list(signal) : Promise.resolve([]), [connections]));
  const available = list.data?.filter(connection =>
    connection.state === "active" && (!remote.trim() || canonicalUrl(remote) === connection.remote_url)) ?? [];
  const chosen = available.some(connection => connection.id === credential) ? credential : "";

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = { remote_url: remote.trim(), ref: ref.trim() || "HEAD", ...(chosen ? { credential_ref: chosen } : {}) };
    const encoded = JSON.stringify(body);
    if (attempt.current?.body !== encoded) attempt.current = { body: encoded, key: newKey() };
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      await submit(body, attempt.current.key);
      attempt.current = null;
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  if (manage && connections) return <GitConnections api={connections} initialRemote={remote} fixedRemote={!!refreshUrl} onBusy={onBusy}
    onCreated={connection => {
      setRemote(connection.remote_url);
      setCredential(connection.id);
      setManage(false);
      list.reload();
    }}
    onBack={() => { setManage(false); list.reload(); }} />;

  return <form className="repository-form" onSubmit={event => void send(event)}>
    <label>URL репозитория<input type="url" className="input" required maxLength={500} value={remote} readOnly={Boolean(refreshUrl)}
      onChange={event => { setRemote(event.target.value); setCredential(""); }} /></label>
    <label>Ветка или commit<input className="input" value={ref} maxLength={200} placeholder="HEAD" onChange={event => setRef(event.target.value)} /></label>
    {connections && <>
      <label>Приватное подключение
        <select className="input" value={chosen} disabled={busy || list.loading} onChange={event => {
          const connection = available.find(item => item.id === event.target.value);
          setCredential(connection?.id ?? "");
          if (connection && !remote.trim()) setRemote(connection.remote_url);
        }}>
          <option value="">Без подключения</option>
          {available.map(connection => <option key={connection.id} value={connection.id}>{connection.remote_url}</option>)}
        </select>
      </label>
      {list.error !== null && <ErrorNotice title="Подключения не загружены" error={list.error}
        action={<button type="button" className="button button--small" onClick={list.reload}>Повторить</button>} />}
      <button type="button" className="button button--small" disabled={busy} onClick={() => setManage(true)}>+ Добавить подключение</button>
    </>}
    {error !== null && <ErrorNotice title={refreshUrl ? "Снимок не обновлён" : "Репозиторий не загружен"} error={error} />}
    {busy ? <QuietStatus busy>Загрузка снимка</QuietStatus>
      : <button className="button button--primary" disabled={!!credential && list.loading}>{error !== null ? "Повторить" : refreshUrl ? "Создать новый снимок" : "Загрузить снимок"}</button>}
  </form>;
}
