import { useEffect, useRef, type ReactNode } from "react";

export function AccountDialog({ titleId, onCancel, children }: {
  titleId: string;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    node.querySelector<HTMLElement>("input, .dialog__footer button")?.focus();
    return () => {
      if (typeof node.close === "function") node.close();
      else node.removeAttribute("open");
      previous?.focus();
    };
  }, []);

  return <dialog ref={ref} className="dialog auth-card auth-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onCancel?.(); }}>
    {children}
  </dialog>;
}
