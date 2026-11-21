import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/http";
import type {
  ApplicationMode,
  CodegenStatus,
  Generation,
  GenerationOptions,
  TechnicalConditions,
  VerificationState,
  VersionRef,
} from "../contract";
import { codegenErrorMessage, newActionKey, verificationDetails, type CodegenProvider } from "../provider";

const fields = {
  language: "Язык",
  platform: "Платформа",
  api_prefix: "Префикс API",
  storage: "Хранилище",
} as const;
const scalarFields = Object.keys(fields) as (keyof typeof fields)[];
const modes: Record<ApplicationMode, string> = {
  template: "Базовый каркас",
  agent: "Прикладной проект с агентом",
};

function conditionLabel(field: string, value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ") || "Без интеграций";
  if (field === "api_prefix" && value === "") return "Без префикса";
  return value ?? "";
}

export function generationLabel(generation: Generation): string {
  const conditions = generation.technical_conditions;
  return [
    `Версия ${generation.version_number}`,
    modes[generation.application_mode ?? "template"],
    generation.target,
    ...scalarFields.map((field) => conditionLabel(field, conditions[field])).filter(Boolean),
    conditionLabel("integrations", conditions.integrations),
    // Старые записи могут хранить только описание состояния процесса.
    conditions.storage === undefined ? conditions.state : undefined,
    new Date(generation.created_at).toLocaleString("ru-RU"),
    generation.generation_id.slice(-8),
  ].filter(Boolean).join(" · ");
}

export function GenerationForm({
  provider,
  version,
  status,
  verificationState,
  hidden,
  disabled,
  busy,
  onBusy,
  onCreated,
  onVerificationState,
}: {
  provider: CodegenProvider;
  version: VersionRef;
  status: CodegenStatus | null;
  verificationState: VerificationState | null;
  hidden: boolean;
  disabled: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onCreated: (generation: Generation) => void;
  onVerificationState: (state: VerificationState) => void;
}) {
  const [draft, setDraft] = useState<Partial<TechnicalConditions>>({});
  const [mode, setMode] = useState<ApplicationMode>("template");
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<ReturnType<typeof verificationDetails>>(null);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const supported = status?.supported_conditions;
  const conditions: TechnicalConditions = {
    language: draft.language ?? supported?.language?.[0] ?? "",
    platform: draft.platform ?? supported?.platform?.[0] ?? "",
    api_prefix: draft.api_prefix ?? supported?.api_prefix?.[0] ?? "",
    storage: draft.storage ?? supported?.storage?.[0] ?? "",
    integrations: draft.integrations ?? [],
  };
  const invalidField = supported && scalarFields.find((field) =>
    !supported[field]?.includes(conditions[field]),
  );
  const unsupportedIntegrations = conditions.integrations.filter((name) =>
    !supported?.integrations?.includes(name),
  );
  const refusal = invalidField
    ? `${fields[invalidField]}: ${supported[invalidField]?.length
      ? `доступно ${supported[invalidField].map((value) => conditionLabel(invalidField, value)).join(", ")}`
      : "сервер не объявил доступных значений"}`
    : unsupportedIntegrations.length > 0
      ? `Недоступные интеграции: ${unsupportedIntegrations.join(", ")}`
      : null;

  const edit = () => {
    setError(null);
    setGate(null);
  };
  const submit = async (allowUnverified: boolean) => {
    const signal = lifetime.current?.signal;
    onBusy(true);
    setError(null);
    const options: GenerationOptions = supported && status
      ? { allowUnverified, target: status.target, technicalConditions: conditions, applicationMode: mode }
      : { allowUnverified };
    const body = JSON.stringify(options);
    if (retry.current?.body !== body) retry.current = { body, key: newActionKey("generate") };
    try {
      const generation = await provider.createGeneration(version, options, retry.current.key, signal);
      if (signal?.aborted) return;
      retry.current = null;
      setGate(null);
      onCreated(generation);
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof ApiError) retry.current = null;
      const details = verificationDetails(cause);
      if (details) {
        const statuses = details.map(({ status }) => status);
        onVerificationState(!statuses.some(Boolean) ? "not_checked"
          : statuses.includes("PROPERTY_VIOLATED") ? "violated" : "inconclusive");
        setGate(details);
      } else {
        setError(codegenErrorMessage(cause));
      }
    } finally {
      if (!signal?.aborted) onBusy(false);
    }
  };
  const cannotSubmit = disabled || busy || !status || !version.approved || !!refusal;
  const integrations = [...new Set([...(supported?.integrations ?? []), ...conditions.integrations])];

  return (
    <form
      className="pv-generation-form"
      aria-label="Технические условия"
      hidden={hidden}
      onSubmit={(event) => {
        event.preventDefault();
        if (!cannotSubmit && !gate) void submit(false);
      }}
    >
      <p className="pv-generation-source">
        {version.approved ? "Утверждённая версия" : "Неутверждённая версия"} {version.number}
        {" · "}TLC: {verificationState ?? "состояние недоступно"}
      </p>
      {!version.approved && (
        <p className="pv-note">Утвердите версию модели, чтобы создать проект. Подтверждение не является результатом TLC.</p>
      )}
      {supported && status ? (
        <fieldset className="pv-generation-fields" disabled={disabled || busy}>
          <legend>Технические условия</legend>
          <span>Цель <code>{status.target}</code></span>
          {scalarFields.map((field) => {
            const values = supported[field] ?? [];
            const selected = conditions[field];
            const unavailable = !values.includes(selected);
            return (
              <label key={field}>
                {fields[field]}
                <select value={selected} aria-invalid={unavailable} onChange={(event) => {
                  setDraft({ ...draft, [field]: event.target.value });
                  edit();
                }}>
                  {unavailable && <option value={selected} disabled>{selected || "Недоступно"}</option>}
                  {values.map((value) => <option key={value} value={value}>{conditionLabel(field, value)}</option>)}
                </select>
              </label>
            );
          })}
          <fieldset>
            <legend>Интеграции</legend>
            {integrations.length === 0 ? (
              <span className="pv-muted">Внешние интеграции пока не поддерживаются.</span>
            ) : integrations.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={conditions.integrations.includes(name)}
                  onChange={(event) => {
                    setDraft({ ...draft, integrations: event.target.checked
                      ? [...conditions.integrations, name]
                      : conditions.integrations.filter((item) => item !== name) });
                    edit();
                  }}
                /> {name}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Режим генерации</legend>
            {(Object.keys(modes) as ApplicationMode[]).map((value) => (
              <label key={value}>
                <input type="radio" name="application-mode" checked={mode === value} onChange={() => {
                  setMode(value);
                  edit();
                }}/> {modes[value]}
              </label>
            ))}
          </fieldset>
        </fieldset>
      ) : status && <p className="pv-note">Сервер поддерживает базовый каркас с условиями по умолчанию.</p>}
      {refusal && <p role="alert">{refusal}</p>}
      {error && <p role="alert" className="pv-codegen-error">{error}</p>}
      {gate ? (
        <section className="pv-generation-gate" aria-label="Подтверждение генерации">
          <p>TLC не подтвердил все правила версии. Проект воспроизведёт модель с текущими результатами проверки.</p>
          {gate.length > 0 && (
            <ul>{gate.map((property) => (
              <li key={property.property_id}>{property.property_id}: {property.status ?? "не проверено"}</li>
            ))}</ul>
          )}
          <button type="button" className="pv-button" disabled={cannotSubmit} onClick={() => submit(true)}>
            {busy ? "Генерация…" : "Создать с текущими результатами TLC"}
          </button>{" "}
          <button type="button" className="pv-button" disabled={busy} onClick={() => setGate(null)}>Отмена</button>
        </section>
      ) : (
        <button type="submit" className="pv-button" disabled={cannotSubmit}>
          {busy ? "Генерация…" : "Создать проект"}
        </button>
      )}
    </form>
  );
}
