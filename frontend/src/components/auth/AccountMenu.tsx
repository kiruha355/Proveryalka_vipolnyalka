import { useId, useRef, useState } from "react";
import { User } from "../icons";

export type AccountAction = "change" | "logout" | "all";

interface Props {
  email: string;
  compact: boolean;
  onAction(action: AccountAction): void;
}

export function AccountMenu({ email, compact, onAction }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const act = (action: AccountAction) => {
    setOpen(false);
    trigger.current?.focus();
    onAction(action);
  };

  return (
    <div className="account" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}>
      <button ref={trigger} className={compact ? "icon-button" : "connection account__trigger"} type="button"
        aria-label={`Аккаунт ${email}`} title={email} aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}>
        <User size={16} />
        {!compact && <span>{email}</span>}
      </button>
      {open && <div className="account__actions" id={id}>
        {compact && <p>{email}</p>}
        <button type="button" onClick={() => act("change")}>Сменить пароль</button>
        <button type="button" onClick={() => act("logout")}>Выйти</button>
        <button type="button" onClick={() => act("all")}>Завершить все сессии</button>
      </div>}
    </div>
  );
}
