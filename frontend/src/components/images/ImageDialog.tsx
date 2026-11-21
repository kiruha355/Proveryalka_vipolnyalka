import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Close } from "../icons";
import "./images.css";

export function ImageDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    const trigger = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return createPortal(
    <dialog className="image-dialog" aria-labelledby={id} ref={dialog}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
      <header className="image-dialog__header">
        <h2 id={id}>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть изображение"><Close /></button>
      </header>
      <div className="image-dialog__body">{children}</div>
    </dialog>,
    document.body,
  );
}
