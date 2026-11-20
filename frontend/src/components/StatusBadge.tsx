import type { VerificationStatus } from "../api/types";
import { statusInfo } from "../domain/status";

interface Props {
  status: VerificationStatus | string;
  /** Compact form for dense lists. */
  size?: "sm" | "md";
}

/** Status of one property check. Inconclusive statuses are hatched and never green. */
export function StatusBadge({ status, size = "md" }: Props) {
  const info = statusInfo(status);
  return (
    <span className={`status status--${info.tone} status--${size}`} title={info.meaning}>
      <span className="status__mark" aria-hidden="true" />
      <span>{info.label}</span>
      {!info.conclusive && <span className="visually-hidden"> — вывод о свойстве не получен</span>}
    </span>
  );
}
