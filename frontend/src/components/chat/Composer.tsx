import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ReactNode } from "react";
import { DOCUMENT_TYPES } from "../../api/api";
import { Close, Paperclip, Send } from "../icons";

export interface ComposerHandle {
  focus(): void;
}

interface Props {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  placeholder: string;
  label: string;
  /** Why sending is unavailable; shown under the field. */
  blockedReason?: string | null;
  busy?: boolean;
  reply?: { text: string; onClear(): void } | null;
  attach?: { onFile(file: File): void; busy: boolean } | null;
  footer?: ReactNode;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const { value, onChange, onSubmit, blockedReason, busy = false, reply, attach } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  // Grow with the text up to a limit; the composer stays pinned to the bottom.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [value]);

  const canSend = !blockedReason && !busy && value.trim().length > 0;
  const submit = () => {
    if (canSend) onSubmit();
  };

  return (
    <div className="composer">
      {reply && (
        <div className="composer__reply">
          <span className="composer__reply-label">Ответ на вопрос</span>
          <span className="composer__reply-text">{reply.text}</span>
          <button type="button" className="icon-button icon-button--small" onClick={reply.onClear} aria-label="Отвязать ответ от вопроса">
            <Close size={14} />
          </button>
        </div>
      )}
      <div className={`composer__box${busy ? " composer__box--busy" : ""}`}>
        {attach && (
          <>
            <button type="button" className="icon-button" onClick={() => file.current?.click()} disabled={attach.busy}
              aria-label="Приложить документ TXT, MD или DOCX" title="Приложить документ TXT, MD или DOCX">
              <Paperclip />
            </button>
            <input ref={file} type="file" hidden accept={DOCUMENT_TYPES.join(",")}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) attach.onFile(chosen);
                e.target.value = "";
              }} />
          </>
        )}
        <textarea
          ref={area}
          className="composer__input"
          rows={1}
          value={value}
          aria-label={props.label}
          placeholder={props.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-describedby={blockedReason ? "composer-blocked" : undefined}
        />
        <button type="button" className="send-button" onClick={submit} disabled={!canSend}
          aria-label={busy ? "Отправка" : "Отправить"} title="Отправить (Enter)">
          {busy ? <span className="spinner spinner--light" aria-hidden="true" /> : <Send size={18} />}
        </button>
      </div>
      {blockedReason && <p className="composer__blocked" id="composer-blocked">{blockedReason}</p>}
      {props.footer}
    </div>
  );
});
