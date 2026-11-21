import { useEffect, useRef, useState } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import { newKey } from "../api/api";
import { ApiError, isAbort, requiresSignIn, validateDocumentFile } from "../api/errors";
import type { Session } from "../api/types";
import { loadLocal, updateLocal } from "../state/persist";
import { Composer, type ComposerHandle } from "./chat/Composer";
import { PaneSeparator, usePaneWidth } from "./PaneSeparator";
import { ErrorNotice } from "./Notice";
import { NewRepository } from "./repositories/NewRepository";

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
  onCreated(session: Session, snapshotId?: string): void;
}

export function NewChat({ api, capabilities, onCreated }: Props) {
  const split = usePaneWidth("proveryalka:chat-width", .36, 250, 390, .65);
  const inFlight = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const documentSession = useRef<{session: Session | null; sessionKey: string; uploadKey: string; file: File} | null>(null);
  const [documentError, setDocumentError] = useState(false);
  const [draft, setDraft] = useState(() => loadLocal(api, NEW).draft);
  const draftRevRef = useRef(0);
  const draftRef = useRef(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const composer = useRef<ComposerHandle>(null);

  const updateDraft = (value: string) => {
    draftRevRef.current += 1;
    draftRef.current = value;
    setDraft(value);
    updateLocal(api, NEW, (local) => ({ ...local, draft: value }));
  };

  const blocked = !capabilities
    ? "Нет подключения к серверу"
    : !capabilities.agent
      ? capabilities.adapter === "demo" ? "Записанные данные: выберите пример слева." : "Агент не настроен. Проверьте подключение."
      : null;

  const start = async () => {
    const text = draft.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    const rev = draftRevRef.current;
    setDocumentError(false);
    const saved = loadLocal(api, NEW).outbox;
    const outbox = saved && saved.text === text && saved.sessionKey
      ? saved
      : { text, questionId: null, key: newKey(), sessionKey: newKey(), sessionTitle: titleFrom(text) };
    updateLocal(api, NEW, (local) => ({ ...local, outbox }));
    setBusy(true);
    setError(null);
    const signal = lifetime.current.signal;
    try {
      const session = await api.createSession({ title: outbox.sessionTitle ?? titleFrom(text) }, outbox.sessionKey!, signal);
      if (signal.aborted) return;
      const unchanged = draftRevRef.current === rev;
      const remainingDraft = unchanged ? "" : draftRef.current;
      // The session view sends the message with the key reserved here.
      updateLocal(api, session.id, (local) => ({
        ...local,
        draft: remainingDraft,
        outbox: { text, questionId: null, key: outbox.key, autoSend: true },
      }));
      updateLocal(api, NEW, () => ({ agentRuns: [], checkRuns: [], draft: "", outbox: null }));
      if (unchanged) {
        draftRef.current = "";
        setDraft("");
      }
      onCreated(session);
    } catch (failure) {
      if (signal.aborted || isAbort(failure)) return;
      if (!(failure instanceof ApiError && (failure.retryable || requiresSignIn(failure)))) {
        updateLocal(api, NEW, (local) => ({
          ...local,
          outbox: null,
        }));
      }
      setError(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const attach = async (file: File, imageKey?: string) => {
    if (inFlight.current || (imageKey ? !api.uploadImage : !api.uploadDocument)) return;
    const validationError = imageKey ? null : validateDocumentFile(file);
    if (validationError) {
      documentSession.current = null;
      setDocumentError(true);
      setError(validationError);
      return;
    }
    inFlight.current = true; setBusy(true); setError(null); setDocumentError(!imageKey);
    const saved = documentSession.current;
    const attempt = saved && saved.file === file
      ? saved
      : { session: null, sessionKey: newKey(), uploadKey: newKey(), file };
    documentSession.current = attempt;
    const signal = lifetime.current.signal;
    try {
      const title = titleFrom(file.name);
      const createWithDocument = !imageKey && capabilities?.atomicDocumentUpload && api.createSessionFromDocument;
      const session = createWithDocument
        ? await createWithDocument.call(api, title, file, attempt.uploadKey, signal)
        : attempt.session ?? await api.createSession({title}, attempt.sessionKey, signal);
      if (signal.aborted) return;
      attempt.session = session;
      const image = imageKey ? await api.uploadImage!(session.id, file, imageKey, signal) : null;
      if (!imageKey && !createWithDocument) await api.uploadDocument!(session.id, file, attempt.uploadKey, signal);
      if (signal.aborted) return;
      const currentDraft = draftRef.current;
      updateLocal(api, session.id, local => ({...local, draft: currentDraft, openImageId: image?.id}));
      updateLocal(api, NEW, local => ({...local, draft: "", outbox: null}));
      documentSession.current = null;
      onCreated(session);
    } catch (failure) {
      if (signal.aborted || isAbort(failure)) return;
      if (!(failure instanceof ApiError && (failure.retryable || requiresSignIn(failure)))) {
        documentSession.current = null;
      }
      if (imageKey) throw failure;
      setError(failure);
    }
    finally {inFlight.current = false; setBusy(false);}
  };

  const documentToRetry = documentSession.current?.file;
  const retryError = documentError ? (documentToRetry ? () => void attach(documentToRetry) : null) : () => void start();
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
            updateDraft(EXAMPLE);
            composer.current?.focus();
          }}>
            Вставить пример из ТЗ
          </button>
        </div>
      </div>
      <div className="chat__footer">
        {error !== null && (
          <ErrorNotice error={error} title={documentError ? "Документ не загружен" : "Чат не создан"}
            action={retryError ? <button type="button" className="button button--small" onClick={retryError} disabled={busy}>Повторить</button> : undefined} />
        )}
        <Composer ref={composer} value={draft} label="Описание поведения"
          onChange={updateDraft}
          onSubmit={() => void start()} busy={busy} blockedReason={blocked}
          attach={capabilities?.documents && api.uploadDocument ? {busy, onFile: file => void attach(file)} : null}
          attachImage={capabilities?.images && api.uploadImage ? attach : undefined}
          footer={capabilities?.repositories && api.repositories ? <NewRepository api={api} repositories={api.repositories}
            connections={capabilities.gitConnections ? api.gitConnections : undefined} disabled={busy}
            onImported={(session, snapshotId) => {
              updateLocal(api, session.id, local => ({ ...local, draft }));
              updateLocal(api, NEW, local => ({ ...local, draft: "", outbox: null }));
              onCreated(session, snapshotId);
            }} /> : undefined}
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
