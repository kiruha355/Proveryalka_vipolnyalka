import { useRef, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import { newKey } from "../api/api";
import { ApiError } from "../api/errors";
import type { Session } from "../api/types";
import { loadLocal, updateLocal } from "../state/persist";
import { Composer, type ComposerHandle } from "./chat/Composer";
import { ErrorNotice } from "./Notice";

const NEW = "__new__";

// The example from the assignment (ТЗ, «Основной сценарий»).
const EXAMPLE = "Заявка после согласования может быть исполнена. Пользователь может отменить заявку до исполнения. Отменённая заявка не должна быть исполнена.";

export function titleFrom(text: string): string {
  const line = text.trim().split(/\n/)[0]?.trim() ?? "";
  if (line.length <= 60) return line || "Новый анализ";
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[,.;:]$/, "")}…`;
}

interface Props {
  api: ProveryalkaApi;
  capabilities: ApiCapabilities | null;
  onCreated(session: Session): void;
}

export function NewChat({ api, capabilities, onCreated }: Props) {
  const [draft, setDraft] = useState(() => loadLocal(api.id, NEW).outbox?.text ?? loadLocal(api.id, NEW).draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const composer = useRef<ComposerHandle>(null);

  const blocked = !capabilities
    ? "Нет подключения к серверу"
    : !capabilities.agent
      ? "В демо-режиме агент не вызывается. Откройте демо-сессию слева или подключите сервер."
      : null;

  const start = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const saved = loadLocal(api.id, NEW).outbox;
    const outbox = saved && saved.text === text && saved.sessionKey
      ? saved
      : { text, questionId: null, key: newKey(), sessionKey: newKey(), sessionTitle: titleFrom(text) };
    updateLocal(api.id, NEW, (local) => ({ ...local, outbox }));
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession({ title: outbox.sessionTitle ?? titleFrom(text) }, outbox.sessionKey!);
      // The session view sends the message with the key reserved here.
      updateLocal(api.id, session.id, (local) => ({ ...local, outbox: { text, questionId: null, key: outbox.key, autoSend: true } }));
      updateLocal(api.id, NEW, () => ({ agentRuns: [], checkRuns: [], draft: "", outbox: null }));
      onCreated(session);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.retryable)) updateLocal(api.id, NEW, (local) => ({ ...local, outbox: null, draft: text }));
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session">
    <section className="chat chat--new" aria-labelledby="new-chat-title">
      <header className="chat__header">
        <h1 id="new-chat-title" className="chat__title">Новый чат</h1>
      </header>
      <div className="chat__body chat__body--empty">
        <div className="empty">
          <h2 className="empty__title">С чего начнём?</h2>
          <p className="empty__text">Опишите поведение процесса: состояния, действия и что запрещено.</p>
          <button type="button" className="button button--ghost" onClick={() => {
            setDraft(EXAMPLE);
            updateLocal(api.id, NEW, (local) => ({ ...local, draft: EXAMPLE }));
            composer.current?.focus();
          }}>
            Вставить пример из ТЗ
          </button>
        </div>
      </div>
      <div className="chat__footer">
        {error !== null && (
          <ErrorNotice error={error} title="Чат не создан"
            action={<button type="button" className="button button--small" onClick={() => void start()}>Повторить</button>} />
        )}
        <Composer ref={composer} value={draft} label="Описание поведения"
          onChange={(value) => { setDraft(value); updateLocal(api.id, NEW, (local) => ({ ...local, draft: value })); }}
          onSubmit={() => void start()} busy={busy} blockedReason={blocked}
          placeholder="Например: заявку можно согласовать, отменить или исполнить…" />
      </div>
    </section>
    <section className="workspace" aria-label="Рабочая область">
      <header className="workspace__header workspace__header--plain">
        <div className="workspace__title-row"><h2 className="workspace__title">Рабочая область</h2></div>
      </header>
      <div className="workspace__body">
        <div className="view view--empty">
          <div className="empty">
            <h3 className="empty__title">Модель появится здесь</h3>
            <p className="empty__text">Агент построит её из описания; затем вы проверите таблицы и запустите TLC.</p>
          </div>
        </div>
      </div>
    </section>
    </div>
  );
}
