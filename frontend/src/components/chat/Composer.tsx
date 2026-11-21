import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DOCUMENT_TYPES, newKey } from "../../api/api";
import { ApiError, describeError, requiresSignIn } from "../../api/errors";
import { IMAGE_ACCEPT, imageFileError } from "../images/imageFile";
import { Close, Paperclip, Picture, Send } from "../icons";

export interface ComposerHandle {
  focus(): void;
  prefill(text: string): void;
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
  attachImage?: (file: File, key: string) => Promise<void>;
  footer?: ReactNode;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const { value, onChange, onSubmit, blockedReason, busy = false, reply, attach } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<{ text: string; retry?: { file: File; key: string } } | null>(null);

  const uploadImage = async (chosen: File, key: string) => {
    if (!props.attachImage || uploading.current) return;
    const invalid = imageFileError(chosen);
    if (invalid) { setImageError({ text: invalid }); return; }
    uploading.current = true;
    setImageError(null);
    setImageBusy(true);
    try {
      await props.attachImage(chosen, key);
    } catch (error) {
      const canRetry = error instanceof ApiError && (error.retryable || requiresSignIn(error));
      setImageError({ text: describeError(error), retry: canRetry ? { file: chosen, key } : undefined });
    } finally {
      uploading.current = false;
      setImageBusy(false);
    }
  };
  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    prefill: (text) => {
      onChange(value.trim() ? `${value}\n\n${text}` : text);
      area.current?.focus();
    },
  }), [value, onChange]);

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
          <div className="composer__reply-content">
            <span className="composer__reply-label">Ответ на вопрос</span>
            <p className="composer__reply-text">{reply.text}</p>
          </div>
          <button type="button" className="icon-button icon-button--small" onClick={reply.onClear} aria-label="Отвязать ответ от вопроса">
            <Close size={14} />
          </button>
        </div>
      )}
      <div className={`composer__box${busy ? " composer__box--busy" : ""}`}>
        {attach && (
          <>
            <button type="button" className="icon-button" onClick={() => file.current?.click()} disabled={attach.busy || imageBusy}
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
        {props.attachImage && (
          <>
            <button type="button" className="icon-button" disabled={busy || imageBusy} onClick={() => image.current?.click()}
              aria-label="Приложить изображение PNG, JPEG или WebP" title="Приложить изображение PNG, JPEG или WebP">
              {imageBusy ? <span className="spinner" aria-hidden="true" /> : <Picture />}
            </button>
            <input ref={image} type="file" hidden accept={IMAGE_ACCEPT} onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen) void uploadImage(chosen, newKey());
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
      {imageBusy && <span className="quiet" role="status">Загрузка изображения</span>}
      {imageError && <div className="image-upload-error" role="alert">
        <span>Изображение не загружено. {imageError.text}</span>
        {imageError.retry && <button type="button" className="link-button" disabled={busy}
          onClick={() => { const retry = imageError.retry; if (retry) void uploadImage(retry.file, retry.key); }}>Повторить</button>}
      </div>}
      {blockedReason && <p className="composer__blocked" id="composer-blocked">{blockedReason}</p>}
      {props.footer}
    </div>
  );
});
