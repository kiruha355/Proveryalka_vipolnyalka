import { useEffect, useId, useRef, type ReactNode } from "react";
import { Close } from "../icons";

export function RepositoryDialog({ title, onClose, busy, variant, children }: {
  title: string;
  onClose(): void;
  busy?: boolean;
  variant?: "drawer" | "snapshots";
  children: ReactNode;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = element.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog ref={element} className={`repository-dialog${variant ? ` repository-dialog--${variant}` : ""}`}
      aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="repository-dialog__header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" autoFocus className="icon-button" disabled={busy} onClick={onClose} aria-label="Закрыть"><Close /></button>
      </header>
      <div className="repository-dialog__body">{children}</div>
    </dialog>
  );
}
