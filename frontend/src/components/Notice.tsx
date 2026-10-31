import type { ReactNode } from "react";
import { describeError } from "../api/errors";
import { Alert } from "./icons";

interface ErrorProps {
  error?: unknown;
  /** Used instead of the error description when there is no error object. */
  detail?: string;
  /** What failed, e.g. "Не удалось загрузить сессию". */
  title: string;
  action?: ReactNode;
}

/** The one place a real failure is shown, with its next action. */
export function ErrorNotice({ error, detail, title, action }: ErrorProps) {
  const text = error !== undefined && error !== null ? describeError(error) : detail;
  return (
    <div className="notice notice--error" role="alert">
      <Alert size={18} />
      <div className="notice__body">
        <strong>{title}</strong>
        {text && <span>{text}</span>}
      </div>
      {action && <div className="notice__action">{action}</div>}
    </div>
  );
}

export function QuietStatus({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <p className="quiet" role="status" aria-live="polite">
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </p>
  );
}
