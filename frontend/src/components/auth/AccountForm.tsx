import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, describeError } from "../../api/errors";
import { Close } from "../icons";
import { AccountDialog } from "./AccountDialog";

type Field = "email" | "password" | "current_password" | "new_password" | "confirm";
type Errors = Partial<Record<Field | "form", string>>;
export type AccountValues = Record<Field, string>;
export type AccountFormMode = "login" | "register" | "request" | "reset" | "change";

const forms: Record<AccountFormMode, {title: string; submit: string; pending: string; fields: Field[]}> = {
  login: {title: "Вход", submit: "Войти", pending: "Вход…", fields: ["email", "password"]},
  register: {title: "Регистрация", submit: "Создать аккаунт", pending: "Создание аккаунта…", fields: ["email", "password", "confirm"]},
  request: {title: "Восстановление доступа", submit: "Отправить ссылку", pending: "Отправка…", fields: ["email"]},
  reset: {title: "Установка нового пароля", submit: "Установить пароль", pending: "Сохранение…", fields: ["password", "confirm"]},
  change: {title: "Смена пароля", submit: "Сменить пароль", pending: "Сохранение…", fields: ["current_password", "new_password", "confirm"]},
};

function fieldLabel(field: Field, mode: AccountFormMode) {
  if (field === "email") return "Электронная почта";
  if (field === "confirm") return "Повторите пароль";
  if (field === "current_password") return "Текущий пароль";
  return field === "new_password" || mode === "reset" ? "Новый пароль" : "Пароль";
}

function validate(values: AccountValues, fields: Field[]): Errors {
  const errors: Errors = {};
  for (const field of fields) {
    const value = values[field];
    if (field === "email") {
      if (value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) errors.email = "Введите корректный адрес почты.";
    } else if (field === "confirm") {
      if (value !== (values.new_password || values.password)) errors.confirm = "Пароли должны совпадать.";
    } else {
      const length = [...value].length;
      if (field === "current_password") {
        if (!length || length > 128) errors[field] = "Введите текущий пароль длиной до 128 символов.";
      } else if (length < 12 || length > 128) {
        errors[field] = "Введите пароль длиной от 12 до 128 символов.";
      }
    }
  }
  return errors;
}

function formErrors(error: unknown, mode: AccountFormMode, fields: Field[]): Errors {
  if (!(error instanceof ApiError)) return { form: describeError(error) };
  switch (error.code) {
    case "ACCOUNT_EXISTS": return { email: "Аккаунт с этой почтой уже существует." };
    case "INVALID_CREDENTIALS": return mode === "change"
      ? { current_password: "Неверный текущий пароль." }
      : { password: "Неверная почта или пароль." };
    case "RESET_INVALID": return { form: "Ссылка недействительна или устарела. Запросите новую." };
    case "AUTH_RATE_LIMIT": return { form: "Слишком много попыток. Повторите позже." };
    case "CSRF_INVALID": return { form: "Сервер отклонил запрос. Проверьте адрес приложения и обновите страницу." };
    case "INVALID_REQUEST": {
      const errors: Errors = {};
      for (const detail of error.details) {
        const path = (detail as {path?: unknown} | null)?.path;
        const field = Array.isArray(path) && path[0] === "body" ? path[1] : null;
        if (fields.includes(field)) errors[field as Field] = `Проверьте поле «${fieldLabel(field, mode)}».`;
      }
      return Object.keys(errors).length ? errors : { form: describeError(error) };
    }
    default: return { form: describeError(error) };
  }
}

interface Props {
  mode: AccountFormMode;
  initialEmail?: string;
  notice?: string;
  onSubmit(values: AccountValues): Promise<void>;
  children?: ReactNode;
  dialog?: {title: string; onClose?: () => void};
}

export function AccountForm({ mode, initialEmail, notice, onSubmit, children, dialog }: Props) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const focusError = useRef(false);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const { title, submit, fields } = forms[mode];

  useEffect(() => {
    if (!dialog) form.current?.querySelector("input")?.focus();
  }, [dialog]);

  useEffect(() => {
    if (!focusError.current) return;
    focusError.current = false;
    const invalid = fields.find((field) => errors[field]);
    if (invalid) form.current?.querySelector<HTMLInputElement>(`input[name="${invalid}"]`)?.focus();
  }, [errors, fields]);

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    const value = (field: Field) => String(data.get(field) ?? "");
    const values: AccountValues = {
      email: value("email").trim(), password: value("password"), confirm: value("confirm"),
      current_password: value("current_password"), new_password: value("new_password"),
    };
    const invalid = validate(values, fields);
    focusError.current = true;
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    submitting.current = true;
    setPending(true);
    try {
      await onSubmit(values);
    } catch (error) {
      focusError.current = true;
      setErrors(formErrors(error, mode, fields));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const content = (
    <>
      <header className="dialog__header">
        <h1 id={`${id}-title`}>{dialog?.title ?? title}</h1>
        {dialog?.onClose && <button type="button" className="icon-button" aria-label="Закрыть" onClick={dialog.onClose} disabled={pending}><Close /></button>}
      </header>
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      <form ref={form} className="auth-form" onSubmit={submitForm} noValidate>
        {fields.map((field) => {
          const email = field === "email";
          const current = field === "current_password" || mode === "login";
          return <div className="auth-field" key={field}>
            <label htmlFor={`${id}-${field}`}>{fieldLabel(field, mode)}</label>
            <input id={`${id}-${field}`} className="input" name={field} type={email ? "email" : "password"}
              autoComplete={email ? "username" : current ? "current-password" : "new-password"}
              defaultValue={email ? initialEmail : undefined} readOnly={pending} required
              aria-invalid={errors[field] ? true : undefined}
              aria-describedby={errors[field] ? `${id}-${field}-error` : undefined}
              onChange={() => setErrors((previous) => ({ ...previous, [field]: undefined, form: undefined }))} />
            {errors[field] && <p className="auth-error" id={`${id}-${field}-error`}>{errors[field]}</p>}
          </div>;
        })}
        {errors.form && <p className="auth-error" role="alert">{errors.form}</p>}
        <button type="submit" className="button button--primary" disabled={pending}>{pending ? forms[mode].pending : submit}</button>
        {pending && <span className="visually-hidden" role="status">{forms[mode].pending}</span>}
      </form>
      {children && <div className="auth-links" inert={pending || undefined}>{children}</div>}
    </>
  );
  return dialog ? (
    <AccountDialog titleId={`${id}-title`} onCancel={pending ? undefined : dialog.onClose}>{content}</AccountDialog>
  ) : (
    <main className="auth-screen"><section className="auth-card" aria-labelledby={`${id}-title`}>{content}</section></main>
  );
}
