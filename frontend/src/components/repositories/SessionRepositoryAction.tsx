import { useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../../api/api";
import type { SessionWorkspace } from "../../state/useSessionWorkspace";
import { RepositorySnapshots } from "./RepositorySnapshots";

export function SessionRepositoryAction({ api, capabilities, sessionId, snapshotId, onSelect, workspace }: {
  api: ProveryalkaApi;
  capabilities: ApiCapabilities;
  sessionId: string;
  snapshotId?: string;
  onSelect(id: string): void;
  workspace: SessionWorkspace;
}) {
  const [open, setOpen] = useState(Boolean(snapshotId));
  if (!capabilities.repositories || !api.repositories) return null;
  const blocked = !capabilities.agent ? "Агент не настроен."
    : workspace.activeAgentRun || workspace.send.sending ? "Дождитесь завершения текущего анализа."
    : workspace.history?.pending ? "Повторите или отмените незавершённый разбор в чате."
    : workspace.send.outbox ? "Повторите или отмените неотправленное сообщение в чате."
    : workspace.dialogue?.status === "limit_reached" ? "Лимит уточняющих раундов исчерпан."
    : !capabilities.sourceAttachments && workspace.dialogue?.status !== "not_started" ? "Сервер поддерживает анализ снимка в новом диалоге."
    : null;
  const runs = new Map(workspace.agentRuns.flatMap(view => view.run ? [[view.runId, view.run] as const] : []));
  return <>
    <button type="button" className="button button--small" onClick={() => setOpen(true)}>Репозитории</button>
    {open && <RepositorySnapshots api={api.repositories} capabilities={capabilities} sessionId={sessionId}
      snapshotId={snapshotId} onSelect={onSelect} onClose={() => setOpen(false)} blocked={blocked} runs={runs}
      connections={capabilities.gitConnections ? api.gitConnections : undefined} onRun={workspace.registerAgentRun} />}
  </>;
}
