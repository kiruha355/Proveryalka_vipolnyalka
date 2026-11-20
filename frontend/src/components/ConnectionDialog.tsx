import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReadyInfo } from "../api/types";
import type { Loadable } from "../state/types";
import { DEMO_RECORDING_META } from "../api/demo";
import { ApiError, describeError, isAbort } from "../api/errors";
import { Close } from "./icons";

interface Props {
  adapter: "http" | "demo";
  baseUrl: string;
  ready: Loadable<ReadyInfo>;
  onApply(adapter: "http" | "demo", baseUrl: string): void;
  onCheckReady(baseUrl: string, signal: AbortSignal): Promise<ReadyInfo>;
  onClose(): void;
}

type ProbeState =
  | { kind: "idle"; edited: boolean }
  | { kind: "loading"; target: string }
  | { kind: "ok"; target: string; info: ReadyInfo }
  | { kind: "error"; target: string; error: unknown };

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function readyEndpoint(normalizedUrl: string): string {
  return normalizedUrl ? `${normalizedUrl}/ready` : "/ready";
}

function technicalError(error: unknown): string {
  if (error instanceof ApiError) {
    const parts: string[] = [error.kind];
    if (error.status !== null) parts.push(`HTTP ${error.status}`);
    if (error.code) parts.push(error.code);
    return `${parts.join(" · ")}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ConnectionDialog({ adapter, baseUrl, ready, onApply, onCheckReady, onClose }: Props) {
  const [mode, setMode] = useState(adapter);
  const [url, setUrl] = useState(baseUrl);
  const [probe, setProbe] = useState<ProbeState | null>(null);
  const probeController = useRef<AbortController | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const urlId = useId();

  const abortProbe = useCallback(() => {
    probeController.current?.abort();
    probeController.current = null;
  }, []);

  useEffect(() => () => abortProbe(), [abortProbe]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input:checked")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>("button, input, summary, [href]")].filter((e) => !e.hasAttribute("disabled"));
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

  const handleUrlChange = (nextUrl: string) => {
    abortProbe();
    setUrl(nextUrl);
    setProbe({ kind: "idle", edited: true });
  };

  const handleModeChange = (nextMode: "http" | "demo") => {
    if (nextMode !== "http") abortProbe();
    setMode(nextMode);
  };

  const handleCheck = () => {
    abortProbe();
    const target = normalizeBaseUrl(url);
    const controller = new AbortController();
    probeController.current = controller;
    setProbe({ kind: "loading", target });
    onCheckReady(target, controller.signal).then(
      (info) => {
        if (controller.signal.aborted || probeController.current !== controller) return;
        probeController.current = null;
        setProbe({ kind: "ok", target, info });
      },
      (error: unknown) => {
        if (controller.signal.aborted || probeController.current !== controller || isAbort(error)) return;
        probeController.current = null;
        setProbe({ kind: "error", target, error });
      },
    );
  };

  const normalizedInput = normalizeBaseUrl(url);
  const savedTarget = normalizeBaseUrl(baseUrl);

  const status: ProbeState = probe ?? (
    adapter === "http"
      ? ready.loading
        ? { kind: "loading", target: savedTarget }
        : ready.data && ready.data.status !== "demo"
          ? { kind: "ok", target: savedTarget, info: ready.data }
          : ready.error !== null
            ? { kind: "error", target: savedTarget, error: ready.error }
            : { kind: "idle", edited: false }
      : { kind: "idle", edited: false }
  );

  const diagnosticTarget = status.kind === "idle" ? normalizedInput : status.target;

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
            <input type="radio" name="adapter" value="http" checked={mode === "http"} onChange={() => handleModeChange("http")} />
            <span>
              <strong>Сервер Проверялки</strong>
              <span className="muted">Интерактивный анализ требований, проверка моделей и сохранённые сессии.</span>
            </span>
          </label>
          {mode === "http" && (
            <div className="choice__detail">
              <label htmlFor={urlId}>Адрес API</label>
              <input id={urlId} className="input" value={url} onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="Оставьте пустым для текущего адреса" spellCheck={false} />
              <div className="ready-line" aria-live="polite">
                {status.kind === "loading" && (
                  <span className="quiet"><span className="spinner" aria-hidden="true" />Проверка подключения…</span>
                )}
                {status.kind === "ok" && (
                  <span className="ready-line__ok">
                    Сервер доступен{status.target ? `: ${status.target}` : ""}
                  </span>
                )}
                {status.kind === "error" && (
                  <span className="ready-line__error">
                    {status.target ? `Ошибка для ${status.target}: ` : ""}{describeError(status.error)}
                  </span>
                )}
                {status.kind === "idle" && status.edited && (
                  <span className="muted">Адрес изменён — нажмите «Проверить»</span>
                )}
                <button type="button" className="button button--small button--ghost" onClick={handleCheck}>Проверить</button>
              </div>
              <details className="connection-details">
                <summary>Технические сведения</summary>
                <dl className="connection-details__list">
                  <div>
                    <dt>Конечная точка проверки</dt>
                    <dd><code>{readyEndpoint(diagnosticTarget)}</code></dd>
                  </div>
                  <div>
                    <dt>Режим маршрутизации</dt>
                    <dd>{diagnosticTarget ? "Прямой запрос по указанному адресу API" : "Тот же origin (через встроенный proxy сервера интерфейса)"}</dd>
                  </div>
                  {status.kind === "ok" && (
                    <>
                      <div>
                        <dt>Статус /ready</dt>
                        <dd><code>{status.info.status}</code></dd>
                      </div>
                      {status.info.checker && (
                        <div>
                          <dt>Движок проверки (checker)</dt>
                          <dd><code>{status.info.checker}</code></dd>
                        </div>
                      )}
                      {status.info.agent_configured !== undefined && (
                        <div>
                          <dt>Агент настроен</dt>
                          <dd><code>{status.info.agent_configured ? "да" : "нет"}</code></dd>
                        </div>
                      )}
                    </>
                  )}
                  {status.kind === "error" && (
                    <div>
                      <dt>Детали ошибки</dt>
                      <dd><code>{technicalError(status.error)}</code></dd>
                    </div>
                  )}
                </dl>
              </details>
            </div>
          )}
          <label className="choice__option">
            <input type="radio" name="adapter" value="demo" checked={mode === "demo"} onChange={() => handleModeChange("demo")} />
            <span>
              <strong>Демо на записанных данных</strong>
              <span className="muted">
                Модели order_bug и order_fixed и сохранённые результаты проверки от {DEMO_RECORDING_META.recorded_at}.
                Сервер и проверка моделей не вызываются.
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
