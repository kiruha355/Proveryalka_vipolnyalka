import { useEffect, useId, useRef, useState } from "react";
import type { CheckLimits, ModelVersion } from "../../api/types";
import { DEFAULT_LIMITS } from "../../api/types";
import { PROPERTY_KIND } from "../../domain/status";
import { Chevron, Play } from "../icons";

interface Props {
  version: ModelVersion;
  selected: string[];
  onSelect(ids: string[]): void;
  limits: CheckLimits;
  onLimits(limits: CheckLimits): void;
  customLimits: boolean;
  busy: boolean;
  onRun(): void;
}

export function CheckLauncher({ version, selected, onSelect, limits, onLimits, customLimits, busy, onRun }: Props) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const all = version.spec.properties;
  const count = selected.length;
  const label = count === all.length ? `Проверить версию ${version.number}` : `Проверить ${count} из ${all.length}`;

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const setLimit = (key: keyof CheckLimits, raw: string) => {
    if (key === "max_depth") {
      onLimits({ ...limits, max_depth: raw.trim() === "" ? null : Math.max(0, Math.floor(Number(raw))) });
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;
    onLimits({ ...limits, [key]: key === "max_states" ? Math.floor(value) : value });
  };

  return (
    <div className="launcher">
      <div className="split">
        <button type="button" className="button button--primary split__main" onClick={onRun} disabled={busy || count === 0}
          title={count === 0 ? "Выберите хотя бы одно свойство" : undefined}>
          {busy ? <span className="spinner spinner--light" aria-hidden="true" /> : <Play size={15} />} {label}
        </button>
        <button ref={trigger} type="button" className="button button--primary split__toggle" aria-haspopup="dialog" aria-expanded={open}
          aria-controls={id} aria-label="Выбрать свойства и лимиты" onClick={() => setOpen((v) => !v)}>
          <Chevron size={16} />
        </button>
      </div>
      {open && (
        <div className="popover launcher__panel" id={id} ref={panel} role="dialog" aria-label="Параметры проверки">
          <fieldset>
            <legend>Свойства</legend>
            {all.map((p) => (
              <label key={p.id} className="check-option">
                <input type="checkbox" checked={selected.includes(p.id)}
                  onChange={(e) => onSelect(all.map((x) => x.id).filter((x) => (x === p.id ? e.target.checked : selected.includes(x))))} />
                <span>{p.name}</span>
                <span className="muted small">{PROPERTY_KIND[p.kind].label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset disabled={!customLimits}>
            <legend>Лимиты TLC</legend>
            {!customLimits && <p className="muted small">Демо хранит ответы только для лимитов по умолчанию.</p>}
            <label className="limit">
              <span>Время, с</span>
              <input type="number" min={1} max={3600} step={1} value={limits.timeout_seconds} onChange={(e) => setLimit("timeout_seconds", e.target.value)} />
            </label>
            <label className="limit">
              <span>Состояний, не более</span>
              <input type="number" min={1} step={1000} value={limits.max_states} onChange={(e) => setLimit("max_states", e.target.value)} />
            </label>
            <label className="limit">
              <span>Глубина</span>
              <input type="number" min={0} step={1} value={limits.max_depth ?? ""} placeholder="без ограничения" onChange={(e) => setLimit("max_depth", e.target.value)} />
            </label>
            {(limits.timeout_seconds !== DEFAULT_LIMITS.timeout_seconds || limits.max_states !== DEFAULT_LIMITS.max_states || limits.max_depth !== null) && (
              <button type="button" className="button button--small button--ghost" onClick={() => onLimits(DEFAULT_LIMITS)}>Вернуть по умолчанию</button>
            )}
          </fieldset>
          <button type="button" className="button button--primary" disabled={busy || count === 0}
            onClick={() => { setOpen(false); onRun(); }}>
            <Play size={15} /> {label}
          </button>
        </div>
      )}
    </div>
  );
}
