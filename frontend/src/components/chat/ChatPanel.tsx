import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCore } from "../../app/core";
import type { WorkspaceContextValue } from "../../app/workspace";
import { describeCode } from "../../api/errors";
import { isTerminal, type FileContextRef, type Question } from "../../api/types";
import { RUN_STATE } from "../../domain/status";
import { loadLocal, updateLocal } from "../../state/persist";
import { ErrorNotice, QuietStatus } from "../Notice";
import { Composer, type ComposerHandle } from "./Composer";
import { AgentBlock, AnalysisEntry, CheckCard, clock, UserBubble, QuestionCard } from "./entries";
import { Stop } from "../icons";
import { MessageText } from "./MessageText";
import { AgentTrace } from "./AgentTrace";
import type { AgentRunView } from "../../state/types";
import { DemoAnswers } from "./DemoAnswers";

interface Props {
  context: WorkspaceContextValue;
  fileContext: FileContextRef | null;
  onClearFile(): void;
  replyQuestionId: string | null;
  onReply(questionId: string | null): void;
  composerRef: React.RefObject<ComposerHandle | null>;
}

export function ChatPanel({ fileContext, onClearFile, context, replyQuestionId, onReply, composerRef }: Props) {
  const core = useCore();
  const { workspace, history } = core;
  const { api, capabilities, session } = context;
  const [draft, setDraft] = useState(() => loadLocal(api.id, session.id).draft);
  const list = useRef<HTMLOListElement>(null);
  const active = workspace.activeAgentRun;
  const pending = history?.pending ?? null;
  const last = workspace.lastAgentRun;

  const setDraftPersist = (value: string) => {
    setDraft(value);
    updateLocal(api.id, session.id, (local) => ({ ...local, draft: value }));
  };

  // Keep the newest entry in view while the reader is at the bottom.
  const count = (history?.entries.length ?? 0) + workspace.checks.length + (active ? active.events.length + 1 : 0);
  useEffect(() => {
    const el = list.current?.parentElement;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [count]);

  const openQuestions = history?.dialogue?.questions.filter((q) => q.status === "open") ?? [];
  const replyQuestion = openQuestions.find((q) => q.id === replyQuestionId) ?? null;

  const answer = (question: Question, prefill: string | null) => {
    onReply(capabilities.questionId ? question.id : null);
    if (prefill !== null) composerRef.current?.prefill(prefill);
    else composerRef.current?.focus();
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await workspace.sendMessage(text, fileContext ? null : replyQuestion?.id ?? null, fileContext);
    if (ok) {
      setDraftPersist("");
      onClearFile();
      onReply(null);
    }
  };

  let blocked: string | null = null;
  if (!capabilities.agent) blocked = capabilities.adapter === "demo" ? "Записанные данные: агент не вызывается." : "Агент не настроен. Проверьте подключение.";
  else if (active) blocked = "Агент ещё работает в этой сессии.";
  else if (workspace.send.outbox) blocked = "Повторите или отмените неотправленное сообщение.";
  else if (pending) blocked = "Повторите или отмените незавершённый разбор.";
  else if (history?.dialogue?.status === "limit_reached" && !fileContext) blocked = "Лимит уточняющих раундов исчерпан. Начните новый чат с уточнённым описанием.";

  const fileLink = (ref?: FileContextRef | null) => ref ? <button type="button" className="text-link small" onClick={()=>context.openGeneratedFile?.(ref)}>Файл {ref.path} · версия {ref.version_number ?? ref.version_id}</button> : null;
  const trace = (view: AgentRunView, action?: ReactNode) => <AgentTrace key={view.runId} trace={{
    runId: view.runId, run: view.run, events: view.events,
    createdAt: view.trace?.created_at, finishedAt: view.trace?.finished_at,
    eventsTruncated: view.trace?.events_truncated, stream: view.stream, cancelRequested: view.cancelRequested,
  }} action={action}/>;
  // Chronological timeline: stored history, then checks started from this browser.
  const items: { at: string; node: ReactNode; key: string; after?: string }[] = [];
  for (const entry of history?.entries ?? []) {
    if (entry.kind === "user") {
      const isPending = entry.status === "pending" && !active;
      const failure = isPending && last && last.text === entry.text && last.run && isTerminal(last.run.state) ? last.failure : null;
      items.push({
        at: entry.createdAt, key: entry.key,
        node: (
          <UserBubble key={entry.key} text={entry.text} time={clock(entry.createdAt)}>
            {fileLink(entry.fileContext)}
            {capabilities.adapter === "demo" && !session.recording_label && <p className="msg__note">Исходный текст записанного примера</p>}
            {entry.status === "discarded" && <p className="msg__note">Сообщение отменено и не разобрано</p>}
            {isPending && (
              <div className="msg__note msg__note--pending">
                <span>
                  {failure?.code === "CANCELLED" || last?.run?.state === "cancelled"
                    ? "Анализ остановлен до ответа"
                    : `Не разобрано${failure ? `: ${describeCode(failure.code) ?? failure.code}` : ""}`}
                </span>

              </div>
            )}
          </UserBubble>
        ),
      });
    } else if (entry.kind === "analysis") {
      items.push({
        at: entry.createdAt, key: entry.key,
        node: (
          <AnalysisEntry key={entry.key} state={entry.state} isLatest={entry.isLatest} time={clock(entry.createdAt)}
            versions={context.versions} context={context} replyQuestionId={replyQuestionId}
            canAnswer={capabilities.agent && !active && !pending} onAnswer={answer} />
        ),
      });
    } else if (entry.kind === "reply") {
      items.push({at: entry.createdAt, key: entry.key, node: <AgentBlock key={entry.key} time={clock(entry.createdAt)}>
        {workspace.agentRuns.filter(run => run.trace?.reply_entry_id === entry.key).map(run => trace(run))}
        <MessageText text={entry.text} />
        {fileLink(entry.fileContext)}
        {entry.questions.map(question => <QuestionCard key={question.id}
          question={history?.dialogue?.questions.find(q => q.id === question.id) ?? question}
          active={replyQuestionId === question.id} canAnswer={entry.isLatest && capabilities.agent && !active && !pending}
          onAnswer={answer}/>)}
      </AgentBlock>});
    } else if (entry.kind === "assistant_text") {
      items.push({ at: entry.createdAt, key: entry.key, node: <AgentBlock key={entry.key} time={clock(entry.createdAt)}><MessageText text={entry.text} /></AgentBlock> });
    } else if (entry.kind === "corrupt") {
      items.push({ at: entry.createdAt, key: entry.key, node: <AgentBlock key={entry.key}><p className="warn-text">Запись истории повреждена и не показана ({entry.wrapper}).</p></AgentBlock> });
    }
  }
  for (const run of workspace.agentRuns) {
    if (!run.run || !isTerminal(run.run.state)) continue;
    // Completed replies own their trace. A failed attempt belongs to its exact
    // persisted input, including retries of the same turn.
    if (run.trace?.reply_entry_id && history?.entries.some(entry => entry.key === run.trace?.reply_entry_id)) continue;
    if (!run.trace && run.events.length === 0) continue;
    const input = run.trace?.input_entry_id;
    items.push({key: `trace:${run.runId}`, at: run.trace?.created_at ?? run.startedAt,
      after: input && history?.entries.some(entry => entry.key === input) ? input : undefined,
      node: <AgentBlock key={`trace:${run.runId}`}>{trace(run)}</AgentBlock>});
  }
  for (const check of [...workspace.checks].reverse()) {
    const version = context.versions.find((v) => v.id === check.versionId);
    items.push({
      at: check.startedAt ?? "", key: check.runId, after: check.afterEntryId,
      node: <CheckCard key={check.runId} check={check} version={version} context={context}
        modelName={(workspace.models.data?.length ?? 0) > 1 ? workspace.models.data?.find((g) => g.model.id === check.modelId)?.model.name : undefined}
        onCancel={() => void workspace.cancelCheck(check.runId)} />,
    });
  }
  // Recorded checks without a client timestamp follow the dated timeline in their own order.
  const timeline = [
    ...items.filter((i) => i.at && !i.after).sort((a, b) => a.at.localeCompare(b.at)),
    ...items.filter((i) => !i.at && !i.after),
  ];

  const anchoredTimeline = timeline.flatMap(item => [item, ...items.filter(check => check.after === item.key)]);

  const activeInHistory = active && (history?.entries.some(entry => entry.key === active.trace?.input_entry_id)
    || pending && pending.text === active.text);

  return (
    <section className="chat" aria-labelledby="chat-title">
      <header className="chat__header">
        <h1 id="chat-title" className="chat__title">{session.title}</h1>
      </header>

      {session.recording_label && <p className="recording-caption">{session.recording_label} · новые вызовы не выполняются</p>}
      <div className="chat__body" tabIndex={-1}>
        {workspace.agentTraceHistory.error !== null && <ErrorNotice error={workspace.agentTraceHistory.error} title="Ход работы не загружен"
          action={<button type="button" className="button button--small" onClick={workspace.reloadAgentRuns}>Повторить</button>}/>}
        {workspace.agentTraceHistory.nextCursor !== null && <button type="button" className="button button--small button--ghost agent-trace-history"
          disabled={workspace.agentTraceHistory.loading} onClick={workspace.loadOlderAgentRuns}>Предыдущие запуски</button>}
        {workspace.detail.error !== null && !workspace.detail.data && (
          <ErrorNotice error={workspace.detail.error} title="История сессии не загружена"
            action={<button type="button" className="button button--small" onClick={workspace.reloadDetail}>Повторить</button>} />
        )}
        {workspace.detail.loading && !workspace.detail.data && <QuietStatus busy>Загрузка истории</QuietStatus>}
        {workspace.detail.data && timeline.length === 0 && !active && !workspace.send.outbox && (
          <div className="empty empty--chat">
            <h2 className="empty__title">С чего начнём?</h2>
            <p className="empty__text">Опишите поведение процесса: состояния, действия и что запрещено.</p>
          </div>
        )}
        <ol className="timeline" ref={list} aria-label="История диалога">
          {anchoredTimeline.map((item) => item.node)}
          {active && (
            <>
              {!activeInHistory && active.text && <UserBubble text={active.text} time={clock(active.startedAt)} />}
              <AgentBlock>
                {trace(active, active.run && (active.run.state === "queued" || active.run.state === "running") ? (
                    <button type="button" className="button button--small button--ghost" onClick={() => void workspace.cancelAgent()} disabled={active.cancelRequested}>
                      <Stop size={13} /> Остановить
                    </button>
                  ) : undefined)}
                {active.stream.kind === "lost" && (
                  <ErrorNotice error={active.stream.error} title="Нет связи с ходом анализа"
                    action={<button type="button" className="button button--small" onClick={() => workspace.reconnect(active.runId)}>Переподключиться</button>} />
                )}
                {active.delta && <MessageText text={active.delta}/>}
              </AgentBlock>
            </>
          )}
          {!active && last && !last.trace && last.events.length === 0 && last.run && last.run.state === "failed" && !pending && last.failure && (
            <AgentBlock>
              <p className="warn-text">Анализ не выполнен: {describeCode(last.failure.code) ?? last.failure.code}</p>
            </AgentBlock>
          )}
          {!active && last && !last.trace && last.events.length === 0 && last.run?.state === "cancelled" && !pending && (
            <AgentBlock><p className="quiet">{RUN_STATE.cancelled}</p></AgentBlock>
          )}
        </ol>
      </div>

      <div className="chat__footer">
        {workspace.send.error !== null && (
          <ErrorNotice error={workspace.send.error} title={workspace.send.outbox ? "Сообщение не отправлено" : "Сервер не принял сообщение"}
            action={workspace.send.outbox ? (
              <>
                <button type="button" className="button button--small" onClick={() => void workspace.retryOutbox()} disabled={workspace.send.sending}>Повторить отправку</button>
                <button type="button" className="button button--small button--ghost" onClick={workspace.discardOutbox}>Не отправлять</button>
              </>
            ) : undefined} />
        )}
        {workspace.upload.error !== null && <ErrorNotice error={workspace.upload.error} title="Документ не загружен"/>}
        {pending && !active && <div className="quiet">
          <button type="button" className="button button--small" disabled={workspace.send.sending} onClick={() => void workspace.retryPending()}>Повторить разбор</button>
          <button type="button" className="button button--small button--ghost" disabled={workspace.send.sending} onClick={() => void workspace.discardPending()}>Отменить разбор</button>
        </div>}
        {workspace.upload.documents.map(document => <div key={document.id} className="document-line">
          <span>{document.filename}</span>
          {workspace.dialogue?.status === "not_started" && <button type="button" className="button button--small" disabled={Boolean(blocked) || workspace.send.sending} onClick={() => void workspace.analyzeDocument(document)}>Разобрать документ</button>}
        </div>)}
        {workspace.upload.uploading && <QuietStatus busy>Загрузка {workspace.upload.uploading}</QuietStatus>}
        {fileContext && <div className="document-line"><span>Вопрос о {fileContext.path} · версия {fileContext.version_number ?? fileContext.version_id}</span><button type="button" className="button button--small" onClick={onClearFile}>Убрать контекст файла</button></div>}
        <Composer ref={composerRef} value={draft} onChange={setDraftPersist} onSubmit={() => void submit()}
          label="Сообщение агенту" placeholder={replyQuestion ? "Ваш ответ на выбранный вопрос…" : openQuestions.length > 0 ? "Ответьте на уточнение или добавьте правило…" : "Добавить правило или уточнение…"}
          blockedReason={blocked} busy={workspace.send.sending}
          reply={replyQuestion && capabilities.questionId ? { text: replyQuestion.text, onClear: () => onReply(null) } : null}
          attach={capabilities.documents && workspace.dialogue?.status === "not_started" ? { busy: workspace.upload.uploading !== null, onFile: (file) => void workspace.uploadDocument(file) } : null} />
        {new URLSearchParams(window.location.search).get("scenario") === "order" && (
          <DemoAnswers onChoose={(text) => composerRef.current?.prefill(text)} />
        )}
      </div>
    </section>
  );
}
