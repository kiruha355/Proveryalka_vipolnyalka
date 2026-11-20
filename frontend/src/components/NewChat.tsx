import { useRef, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import { newKey } from "../api/api";
import { ApiError } from "../api/errors";
import type { Session } from "../api/types";
import { loadLocal, updateLocal } from "../state/persist";
import { Composer, type ComposerHandle } from "./chat/Composer";
import { PaneSeparator, usePaneWidth } from "./PaneSeparator";
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
  const split = usePaneWidth("proveryalka:chat-width", .36, 250, 390, .65);
  const inFlight = useRef(false);
  const documentSession = useRef<{session: Session | null; sessionKey: string; uploadKey: string; file: File} | null>(null);
  const [documentError, setDocumentError] = useState(false);
  const [draft, setDraft] = useState(() => loadLocal(api.id, NEW).outbox?.text ?? loadLocal(api.id, NEW).draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const composer = useRef<ComposerHandle>(null);

  const blocked = !capabilities
    ? "Нет подключения к серверу"
    : !capabilities.agent
      ? capabilities.adapter === "demo" ? "Записанные данные: выберите пример слева." : "Агент не настроен. Проверьте подключение."
      : null;

  const start = async () => {
    const text = draft.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setDocumentError(false);
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
      inFlight.current = false;
      setBusy(false);
    }
  };

  const attach = async (file: File) => {
    if (inFlight.current || !api.uploadDocument) return;
    inFlight.current = true; setBusy(true); setError(null); setDocumentError(true);
    const saved = documentSession.current;
    const attempt = saved && saved.file === file ? saved : {session: saved?.session ?? null, sessionKey: newKey(), uploadKey: newKey(), file};
    documentSession.current = attempt;
    try {
      if (!attempt.session) attempt.session = await api.createSession({title: titleFrom(file.name)}, attempt.sessionKey);
      await api.uploadDocument(attempt.session.id, file, attempt.uploadKey);
      updateLocal(api.id, attempt.session.id, local => ({...local, draft}));
      updateLocal(api.id, NEW, local => ({...local, draft: "", outbox: null}));
      onCreated(attempt.session);
    } catch (failure) { setError(failure); }
    finally {inFlight.current = false; setBusy(false);}
  };

  return (
    <div className="session" ref={split.container} style={split.style}>
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
          <ErrorNotice error={error} title={documentError ? "Документ не загружен" : "Чат не создан"}
            action={documentError ? undefined : <button type="button" className="button button--small" onClick={() => void start()}>Повторить</button>} />
        )}
        <Composer ref={composer} value={draft} label="Описание поведения"
          onChange={(value) => { setDraft(value); updateLocal(api.id, NEW, (local) => ({ ...local, draft: value })); }}
          onSubmit={() => void start()} busy={busy} blockedReason={blocked}
          attach={capabilities?.documents ? {busy, onFile: file => void attach(file)} : null}
          placeholder="Например: заявку можно согласовать, отменить или исполнить…" />
      </div>
    </section>
    <PaneSeparator pane={split} label="Ширина чата"/>
    <section className="workspace" aria-label="Рабочая область">
      <header className="workspace__header workspace__header--plain">
        <div className="workspace__title-row"><h2 className="workspace__title">Рабочая область</h2></div>
      </header>
      <div className="workspace__body">
        <div className="view view--empty">
          <div className="empty">
            <h3 className="empty__title">Модель появится здесь</h3>
            <p className="empty__text">Агент построит её из описания; затем просмотрите процесс и правила и нажмите «Проверить».</p>
          </div>
        </div>
      </div>
    </section>
    </div>
  );
}
