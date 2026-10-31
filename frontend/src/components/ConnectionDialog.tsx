import { useEffect, useId, useRef, useState } from "react";
import type { ReadyInfo } from "../api/types";
import type { Loadable } from "../state/types";
import { DEMO_RECORDING_META } from "../api/demo";
import { describeError } from "../api/errors";
import { Close } from "./icons";

interface Props {
  adapter: "http" | "demo";
  baseUrl: string;
  ready: Loadable<ReadyInfo>;
  onApply(adapter: "http" | "demo", baseUrl: string): void;
  onCheckReady(): void;
  onClose(): void;
}

export function ConnectionDialog({ adapter, baseUrl, ready, onApply, onCheckReady, onClose }: Props) {
  const [mode, setMode] = useState(adapter);
  const [url, setUrl] = useState(baseUrl);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const urlId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input:checked")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>("button, input, [href]")].filter((e) => !e.hasAttribute("disabled"));
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <header className="dialog__header">
          <h2 id={titleId}>Подключение</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть"><Close /></button>
        </header>

        <fieldset className="choice">
          <legend className="visually-hidden">Источник данных</legend>
          <label className="choice__option">
            <input type="radio" name="adapter" value="http" checked={mode === "http"} onChange={() => setMode("http")} />
            <span>
              <strong>Сервер Проверялки</strong>
              <span className="muted">Агент на GPT через backend, проверка TLC, сохранённые сессии.</span>
            </span>
          </label>
          {mode === "http" && (
            <div className="choice__detail">
              <label htmlFor={urlId}>Адрес API</label>
              <input id={urlId} className="input" value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="пусто — тот же адрес через proxy" spellCheck={false} />
              <div className="ready-line" aria-live="polite">
                {ready.loading && <span className="quiet"><span className="spinner" aria-hidden="true" />Проверка /ready</span>}
                {!ready.loading && ready.data && (
                  <span className="ready-line__ok">
                    Сервер готов{ready.data.checker ? `: ${ready.data.checker}` : ""}
                  </span>
                )}
                {!ready.loading && ready.error !== null && <span className="ready-line__error">{describeError(ready.error)}</span>}
                <button type="button" className="button button--small button--ghost" onClick={onCheckReady}>Проверить</button>
              </div>
            </div>
          )}
          <label className="choice__option">
            <input type="radio" name="adapter" value="demo" checked={mode === "demo"} onChange={() => setMode("demo")} />
            <span>
              <strong>Демо на записанных данных</strong>
              <span className="muted">
                Модели order_bug и order_fixed из тестов backend и ответы TLC, записанные {DEMO_RECORDING_META.recorded_at}.
                Агент и TLC не вызываются.
              </span>
            </span>
          </label>
        </fieldset>

        <footer className="dialog__footer">
          <button type="button" className="button button--ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="button button--primary" onClick={() => onApply(mode, url.trim())}>Подключить</button>
        </footer>
      </div>
    </div>
  );
}
