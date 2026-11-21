import { useRef, useState } from "react";
import { newKey, type ProveryalkaApi } from "../../api/api";
import type { GitConnectionsApi, RepositoryApi, RepositoryImport as ImportBody } from "../../api/repositories";
import type { Session } from "../../api/types";
import { RepositoryDialog } from "./RepositoryDialog";
import { RepositoryImport } from "./RepositoryImport";

export function NewRepository({ api, repositories, connections, disabled, onImported }: {
  api: ProveryalkaApi;
  repositories: RepositoryApi;
  connections?: GitConnectionsApi;
  disabled: boolean;
  onImported(session: Session, snapshotId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; title: string; session?: Session } | null>(null);

  async function submit(body: ImportBody, key: string) {
    const path = new URL(body.remote_url).pathname.replace(/\/$/, "");
    const existing = attempt.current ?? { key: newKey(), title: (path.split("/").at(-1) || "Репозиторий").slice(0, 200) };
    attempt.current = existing;
    existing.session ??= await api.createSession({ title: existing.title }, existing.key);
    const snapshot = await repositories.import(existing.session.id, body, key);
    onImported(existing.session, snapshot.id);
  }

  return <>
    <button type="button" className="button button--small" disabled={disabled} onClick={() => setOpen(true)}>Подключить репозиторий</button>
    {open && <RepositoryDialog title="Подключить репозиторий" onClose={() => setOpen(false)} busy={busy}>
      <RepositoryImport connections={connections} submit={submit} onBusy={setBusy} />
    </RepositoryDialog>}
  </>;
}
