import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCore } from "../../app/core";
import type { WorkspaceContextValue } from "../../app/workspace";
import { describeCode } from "../../api/errors";
import { isTerminal, type Question } from "../../api/types";
import { RUN_STATE } from "../../domain/status";
import { loadLocal, updateLocal } from "../../state/persist";
import { ErrorNotice, QuietStatus } from "../Notice";
import { Composer, type ComposerHandle } from "./Composer";
import { AgentBlock, AnalysisEntry, CheckCard, clock, UserBubble } from "./entries";
import { Retry, Stop } from "../icons";

const MODE_LABEL: Record<string, string> = { analyzer: "Анализатор", debugger: "Дебаггер", overview: "Обзор проекта", codegen: "Генератор кода" };

interface Props {
  context: WorkspaceContextValue;
  replyQuestionId: string | null;
  onReply(questionId: string | null): void;
  composerRef: React.RefObject<ComposerHandle | null>;
}

export function ChatPanel({ context, replyQuestionId, onReply, composerRef }: Props) {
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
    if (prefill !== null) setDraftPersist(prefill);
    composerRef.current?.focus();
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await workspace.sendMessage(text, replyQuestion?.id ?? null);
    if (ok) {
      setDraftPersist("");
      onReply(null);
    }
  };

  let blocked: string | null = null;
  if (!capabilities.agent) blocked = "В демо-режиме агент не вызывается: таблицы и проверки показаны по записанным данным.";
  else if (active) blocked = "Агент ещё работает в этой сессии.";
  else if (pending) blocked = "Сначала повторите необработанное сообщение: сервер не примет новое, пока оно не разобрано.";
  else if (history?.dialogue?.status === "limit_reached") blocked = "Лимит уточняющих раундов исчерпан. Начните новый чат с уточнённым описанием.";

  // Chronological timeline: stored history, then checks started from this browser.
  const items: { at: string; node: ReactNode; key: string }[] = [];
  for (const entry of history?.entries ?? []) {
    if (entry.kind === "user") {
      const isPending = entry.status === "pending" && !active;
      const failure = isPending && last && last.text === entry.text && last.run && isTerminal(last.run.state) ? last.failure : null;
      items.push({
        at: entry.createdAt, key: entry.key,
        node: (
          <UserBubble key={entry.key} text={entry.text} time={clock(entry.createdAt)}>
            {entry.status === "discarded" && <p className="msg__note">Сообщение отменено и не разобрано</p>}
            {isPending && (
              <div className="msg__note msg__note--pending">
                <span>
                  {failure?.code === "CANCELLED" || last?.run?.state === "cancelled"
                    ? "Анализ остановлен до ответа"
                    : `Не разобрано${failure ? `: ${describeCode(failure.code) ?? failure.code}` : ""}`}
                </span>
                {capabilities.agent && (
                  <button type="button" className="button button--small" onClick={() => void workspace.retryPending()} disabled={workspace.send.sending}>
                    <Retry size={14} /> Повторить анализ
                  </button>
                )}
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
    } else if (entry.kind === "assistant_text") {
      items.push({ at: entry.createdAt, key: entry.key, node: <AgentBlock key={entry.key} time={clock(entry.createdAt)}><p className="msg__text">{entry.text}</p></AgentBlock> });
    } else if (entry.kind === "corrupt") {
      items.push({ at: entry.createdAt, key: entry.key, node: <AgentBlock key={entry.key}><p className="warn-text">Запись истории повреждена и не показана ({entry.wrapper}).</p></AgentBlock> });
    }
  }
  for (const check of [...workspace.checks].reverse()) {
    const version = context.versions.find((v) => v.id === check.versionId);
    items.push({
      at: check.startedAt ?? "", key: check.runId,
      node: <CheckCard key={check.runId} check={check} version={version} context={context}
        modelName={(workspace.models.data?.length ?? 0) > 1 ? workspace.models.data?.find((g) => g.model.id === check.modelId)?.model.name : undefined}
        onCancel={() => void workspace.cancelCheck(check.runId)} />,
    });
  }
  // Recorded checks without a client timestamp follow the dated timeline in their own order.
  const timeline = [
    ...items.filter((i) => i.at).sort((a, b) => a.at.localeCompare(b.at)),
    ...items.filter((i) => !i.at),
  ];

  const activeInHistory = active && pending && pending.text === active.text;

  return (
    <section className="chat" aria-labelledby="chat-title">
      <header className="chat__header">
        <h1 id="chat-title" className="chat__title">{session.title}</h1>
        <span className="chip chip--mode" title="Режим сессии; сейчас все режимы обрабатывает аналитик">{MODE_LABEL[session.mode] ?? session.mode}</span>
      </header>

      <div className="chat__body" tabIndex={-1}>
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
          {timeline.map((item) => item.node)}
          {active && (
            <>
              {!activeInHistory && <UserBubble text={active.text} time={clock(active.startedAt)} />}
              <AgentBlock>
                <div className="run-status" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    {active.cancelRequested || active.run?.state === "cancelling" ? "Останавливается"
                      : active.run?.state === "queued" ? "В очереди"
                        : "Агент разбирает описание"}
                  </span>
                  {active.run && (active.run.state === "queued" || active.run.state === "running") && (
                    <button type="button" className="button button--small button--ghost" onClick={() => void workspace.cancelAgent()} disabled={active.cancelRequested}>
                      <Stop size={13} /> Остановить
                    </button>
                  )}
                </div>
                {active.stream.kind === "reconnecting" && (
                  <p className="quiet">Связь прервана · повтор {active.stream.attempt}/{active.stream.maxAttempts}</p>
                )}
                {active.stream.kind === "lost" && (
                  <ErrorNotice error={active.stream.error} title="Нет связи с ходом анализа"
                    action={<button type="button" className="button button--small" onClick={() => workspace.reconnect(active.runId)}>Переподключиться</button>} />
                )}
                {active.delta && <p className="msg__text">{active.delta}</p>}
                {active.questions.length > 0 && <p className="small">Агент задаёт вопросов: {active.questions.length}</p>}
                {active.proposed.map((p) => (
                  <p key={p.version_id} className="small">Предложена версия модели {p.number}</p>
                ))}
              </AgentBlock>
            </>
          )}
          {!active && last && last.run && last.run.state === "failed" && !pending && last.failure && (
            <AgentBlock>
              <p className="warn-text">Анализ не выполнен: {describeCode(last.failure.code) ?? last.failure.code}</p>
            </AgentBlock>
          )}
          {!active && last?.run?.state === "cancelled" && !pending && (
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
        {workspace.upload.uploading && <QuietStatus busy>Загрузка {workspace.upload.uploading}</QuietStatus>}
        <Composer ref={composerRef} value={draft} onChange={setDraftPersist} onSubmit={() => void submit()}
          label="Сообщение агенту" placeholder={openQuestions.length > 0 ? "Ответьте на уточнение или добавьте правило…" : "Добавить правило или уточнение…"}
          blockedReason={blocked} busy={workspace.send.sending}
          reply={replyQuestion && capabilities.questionId ? { text: replyQuestion.text, onClear: () => onReply(null) } : null}
          attach={capabilities.documents ? { busy: workspace.upload.uploading !== null, onFile: (file) => void workspace.uploadDocument(file) } : null} />
      </div>
    </section>
  );
}
