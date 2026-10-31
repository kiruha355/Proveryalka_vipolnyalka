import {useEffect, useRef, useState, type CSSProperties} from "react";

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
/** Fractions survive viewport changes; physical minima are enforced on every resize. */
export function usePaneWidth(key: string, initial: number, minPx: number, remainingPx: number, maxFraction = .7) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [fraction, setFraction] = useState(() => {
    try { const n = Number(localStorage.getItem(key)); return n > 0 && n < 1 ? n : initial; } catch { return initial; }
  });
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width || 1200);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const min = Math.min(minPx / width, .45);
  const max = Math.max(min, Math.min(maxFraction, 1 - (remainingPx + 6) / width));
  const current = clamp(fraction, min, max);
  const change = (n: number) => {
    const next = clamp(n, min, max); setFraction(next);
    try { localStorage.setItem(key, String(next)); } catch { /* Width remains usable without storage. */ }
  };
  return {container, width, fraction: current, min, max, change,
    style: {"--pane-width": `${current * 100}%`} as CSSProperties};
}

export function PaneSeparator({pane, label}: {pane: ReturnType<typeof usePaneWidth>; label: string}) {
  const drag = useRef<{id: number; x: number; fraction: number} | null>(null);
  return <div className="pane-separator" role="separator" aria-label={label} aria-orientation="vertical"
    tabIndex={0} aria-valuenow={Math.round(pane.fraction * 100)} aria-valuemin={Math.round(pane.min * 100)}
    aria-valuemax={Math.round(pane.max * 100)} aria-valuetext={`${Math.round(pane.fraction * 100)} процентов`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {id: event.pointerId, x: event.clientX, fraction: pane.fraction};
    }} onPointerMove={event => {
      if (drag.current?.id === event.pointerId) pane.change(drag.current.fraction + (event.clientX - drag.current.x) / pane.width);
    }} onPointerUp={event => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => {drag.current = null;}} onLostPointerCapture={() => {drag.current = null;}}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      pane.change(event.key === "Home" ? pane.min : event.key === "End" ? pane.max : pane.fraction + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? .05 : .01));
    }} />;
}
