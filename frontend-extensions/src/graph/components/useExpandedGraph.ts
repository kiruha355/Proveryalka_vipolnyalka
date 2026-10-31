import {useEffect, useRef, useState} from "react";

/** Keep the same graph mounted while its shell fills the workspace. */
export function useExpandedGraph() {
  const [expanded, setExpanded] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded || !shell.current) return;
    const origin = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const siblings: {element: HTMLElement; inert: string | null}[] = [];
    let current: HTMLElement = shell.current;
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || !(sibling instanceof HTMLElement)) continue;
        siblings.push({element:sibling, inert:sibling.getAttribute("inert")});
        sibling.setAttribute("inert", "");
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    document.body.style.overflow = "hidden";
    close.current?.focus();
    return () => {
      for (const {element, inert} of siblings) {
        if (inert === null) element.removeAttribute("inert"); else element.setAttribute("inert", inert);
      }
      document.body.style.overflow = previousOverflow;
      if (origin?.isConnected) origin.focus(); else trigger.current?.focus();
    };
  }, [expanded]);
  return {expanded, setExpanded, shell, trigger, close,
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!expanded) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setExpanded(false); return;
      }
      if (event.key !== "Tab" || !shell.current) return;
      const targets = [...shell.current.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.closest('[hidden]') && getComputedStyle(el).display !== "none");
      const first=targets[0], last=targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus();}
    },
  };
}
