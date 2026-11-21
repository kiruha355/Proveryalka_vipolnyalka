import { useCallback, useEffect, useState, type RefObject } from "react";

/** Tracks whether a horizontally scrollable element has hidden content to the left or right. */
export function useHorizontalScrollCue(ref: RefObject<HTMLElement | null>, contentKey?: string) {
  const [state, setState] = useState({ canLeft: false, canRight: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const canLeft = el.scrollLeft > 2;
    const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setState((prev) => (prev.canLeft === canLeft && prev.canRight === canRight ? prev : { canLeft, canRight }));
  }, [ref]);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(el);
    if (observer) for (const child of el.children) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [ref, update, contentKey]);

  return state;
}
