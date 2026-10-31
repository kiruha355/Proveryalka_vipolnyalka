import { useId, useRef, useState, type ReactNode } from "react";
/** Доля первой панели хранится отдельно для каждого назначения разделителя. */
export function SplitPane({
  children,
  label,
  storageKey,
  initial = 28,
  min = 15,
  max = 70,
  axis = "horizontal",
}: {
  children: [ReactNode, ReactNode];
  label: string;
  storageKey: string;
  initial?: number;
  min?: number;
  max?: number;
  axis?: "horizontal" | "vertical";
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const [size, setSize] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw === null ? initial : Number(raw);
      return Number.isFinite(n) ? clamp(n) : initial;
    } catch {
      return initial;
    }
  });
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const update = (n: number) => {
    const next = clamp(n);
    setSize(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* storage may be disabled */
    }
  };
  return (
    <div
      className={`pv-split pv-split--${axis}`}
      ref={root}
      style={{
        [axis === "horizontal" ? "gridTemplateColumns" : "gridTemplateRows"]:
          `minmax(0, ${size}fr) 6px minmax(0, ${100 - size}fr)`,
      }}
    >
      <div className="pv-split__pane" id={id}>
        {children[0]}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-controls={id}
        aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(size)}
        className="pv-split__handle"
        onKeyDown={(e) => {
          const inc = axis === "horizontal" ? "ArrowRight" : "ArrowDown",
            dec = axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
          if (![inc, dec, "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          update(
            e.key === "Home"
              ? min
              : e.key === "End"
                ? max
                : size + (e.key === inc ? 1 : -1) * (e.shiftKey ? 10 : 2),
          );
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const box = root.current!.getBoundingClientRect();
          const total = axis === "horizontal" ? box.width : box.height;
          if (total > 0)
            update(
              (100 *
                (axis === "horizontal"
                  ? e.clientX - box.left
                  : e.clientY - box.top)) /
                total,
            );
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onLostPointerCapture={() => {}}
      />
      <div className="pv-split__pane">{children[1]}</div>
    </div>
  );
}
