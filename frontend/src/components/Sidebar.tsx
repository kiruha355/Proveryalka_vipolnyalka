import { useMemo } from "react";
import type { Session } from "../api/types";
import type { Loadable } from "../state/types";
import { ErrorNotice } from "./Notice";
import { Chat, Menu, Plug, Plus } from "./icons";

interface Props {
  open: boolean;
  onToggle(): void;
  sessions: Loadable<Session[]>;
  currentId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onRetry(): void;
  connectionLabel: string;
  connectionTone: "ok" | "demo" | "error" | "pending";
  onConnection(): void;
}

const DAY = 24 * 60 * 60 * 1000;

function dayLabel(date: Date, now: Date): string {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(date)) / DAY);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function groupSessions(sessions: Session[], now = new Date()): { label: string; items: Session[] }[] {
  const sorted = [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const groups: { label: string; items: Session[] }[] = [];
  for (const session of sorted) {
    const date = new Date(session.created_at);
    const label = Number.isNaN(date.getTime()) ? "Без даты" : dayLabel(date, now);
    const group = groups.find((g) => g.label === label);
    if (group) group.items.push(session);
    else groups.push({ label, items: [session] });
  }
  return groups;
}

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function Sidebar(props: Props) {
  const { open, sessions } = props;
  const groups = useMemo(() => groupSessions(sessions.data ?? []), [sessions.data]);

  return (
    <nav className={`sidebar${open ? " sidebar--open" : ""}`} aria-label="Сессии">
      <div className="sidebar__top">
        <button type="button" className="icon-button" onClick={props.onToggle}
          aria-expanded={open} aria-controls="session-list" aria-label={open ? "Свернуть список сессий" : "Показать список сессий"}>
          <Menu />
        </button>
        {open ? (
          <button type="button" className="button button--soft sidebar__new" onClick={props.onNew}>
            <Plus size={16} /> Новый чат
          </button>
        ) : (
          <button type="button" className="icon-button" onClick={props.onNew} aria-label="Новый чат" title="Новый чат">
            <Plus />
          </button>
        )}
      </div>

      {open && (
        <div className="sidebar__list" id="session-list">
          {sessions.error !== null && !sessions.data && (
            <ErrorNotice error={sessions.error} title="Сессии не загружены"
              action={<button type="button" className="button button--small" onClick={props.onRetry}>Повторить</button>} />
          )}
          {sessions.loading && !sessions.data && <p className="quiet"><span className="spinner" aria-hidden="true" />Загрузка</p>}
          {sessions.data && sessions.data.length === 0 && <p className="sidebar__empty">Сессий пока нет</p>}
          {groups.map((group) => (
            <section key={group.label} className="sidebar__group" aria-label={group.label}>
              <h2 className="sidebar__day">{group.label}</h2>
              <ul>
                {group.items.map((session) => (
                  <li key={session.id}>
                    <button type="button" className="session-link" aria-current={session.id === props.currentId ? "page" : undefined}
                      onClick={() => props.onSelect(session.id)}>
                      <Chat size={16} />
                      <span className="session-link__title">{session.title}</span>
                      <span className="session-link__time">{time(session.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <div className="sidebar__bottom">
        <button type="button" className={`connection connection--${props.connectionTone}${open ? "" : " connection--rail"}`}
          onClick={props.onConnection} aria-label={`Подключение: ${props.connectionLabel}`} title={props.connectionLabel}>
          <Plug size={16} />
          {open && <span>{props.connectionLabel}</span>}
        </button>
      </div>
    </nav>
  );
}
