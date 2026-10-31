import { useId, useMemo, useState } from "react";
import type {
  Assignment,
  BehavioralModel,
  Expression,
  Transition,
} from "../../contracts/model";
import {
  ExpressionSyntaxError,
  formatExpression,
  parseExpression,
} from "../../dsl/expression-text";
import { validateModel } from "../../dsl/validate";
import type { ModelIssue } from "../../dsl/validate";
import { cx } from "../../ui/cx";
import { CloseIcon, PlusIcon } from "../../ui/icons";
import { applyDraftAction } from "../draft";
import type { DraftAction } from "../draft";

type EffectRow = { key: number; variable: string; text: string };

type Parsed = { expression: Expression | null; error: string | null };

function parse(text: string): Parsed {
  try {
    return { expression: parseExpression(text), error: null };
  } catch (error) {
    if (error instanceof ExpressionSyntaxError) {
      return {
        expression: null,
        error: `${error.message} (символ ${error.offset + 1})`,
      };
    }
    return { expression: null, error: String(error) };
  }
}

/**
 * Форма guard и effects одного перехода. Изменения попадают в черновик
 * только кнопкой «Применить»; до этого форма показывает синтаксические
 * ошибки и ошибки типов, найденные той же проверкой, что и при сохранении.
 */
export function TransitionEditor({
  spec,
  transition,
  onApply,
  onRemove,
  onClose,
}: {
  spec: BehavioralModel;
  transition: Transition;
  onApply: (actions: DraftAction[]) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(transition.name);
  const [requirementIds, setRequirementIds] = useState<string[]>(
    transition.requirement_ids,
  );
  const [guardText, setGuardText] = useState(
    formatExpression(transition.guard),
  );
  const [rows, setRows] = useState<EffectRow[]>(
    transition.effects.map((effect, index) => ({
      key: index,
      variable: effect.variable,
      text: formatExpression(effect.value),
    })),
  );
  const [nextKey, setNextKey] = useState(transition.effects.length);

  const guard = useMemo(() => parse(guardText), [guardText]);
  const parsedRows = useMemo(
    () => rows.map((row) => ({ ...row, parsed: parse(row.text) })),
    [rows],
  );
  const syntaxOk =
    guard.expression !== null &&
    parsedRows.every((row) => row.parsed.expression !== null);

  const actions: DraftAction[] = useMemo(() => {
    if (!syntaxOk) return [];
    const effects: Assignment[] = parsedRows.map((row) => ({
      variable: row.variable,
      value: row.parsed.expression!,
    }));
    return [
      {
        type: "set_transition_meta",
        transitionId: transition.id,
        name,
        requirementIds,
      },
      {
        type: "set_guard",
        transitionId: transition.id,
        guard: guard.expression!,
      },
      { type: "set_effects", transitionId: transition.id, effects },
    ];
  }, [
    syntaxOk,
    parsedRows,
    transition.id,
    name,
    requirementIds,
    guard.expression,
  ]);

  const issues: ModelIssue[] = useMemo(() => {
    if (!syntaxOk) return [];
    const candidate = actions.reduce(applyDraftAction, spec);
    return validateModel(candidate).filter((issue) =>
      issue.path.startsWith(`transitions.${transition.id}`),
    );
  }, [syntaxOk, actions, spec, transition.id]);

  const issuesFor = (prefix: string) =>
    issues.filter(
      (issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`),
    );
  const guardIssues = issuesFor(`transitions.${transition.id}.guard`);
  const otherIssues = issues.filter(
    (issue) =>
      !issue.path.startsWith(`transitions.${transition.id}.guard`) &&
      !/\.effects\[\d+\]/.test(issue.path),
  );
  const assigned = new Set(rows.map((row) => row.variable));
  const free = spec.variables.filter((variable) => !assigned.has(variable.id));
  const canApply =
    syntaxOk &&
    issues.length === 0 &&
    name.trim() !== "" &&
    requirementIds.length > 0;

  return (
    <section
      className="pv-inspector__card pv-editor"
      aria-label={`Правка перехода ${transition.id}`}
    >
      <header className="pv-inspector__head">
        <h3>
          Правка перехода <span className="pv-mono">{transition.id}</span>
        </h3>
        <button
          type="button"
          className="pv-icon-button"
          onClick={onClose}
          aria-label="Закрыть правку"
        >
          <CloseIcon />
        </button>
      </header>
      <form
        className="pv-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApply) onApply(actions);
        }}
      >
        <label className="pv-field">
          <span>Название</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>

        <fieldset className="pv-field">
          <legend>Требования</legend>
          <div className="pv-toggle-list">
            {spec.requirements.map((requirement) => {
              const checked = requirementIds.includes(requirement.id);
              return (
                <label
                  key={requirement.id}
                  className={cx("pv-toggle", checked && "is-on")}
                  title={requirement.text}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setRequirementIds((current) =>
                        checked
                          ? current.filter((id) => id !== requirement.id)
                          : [...current, requirement.id],
                      )
                    }
                  />
                  {requirement.id}
                </label>
              );
            })}
          </div>
          {requirementIds.length === 0 && (
            <p className="pv-field-error">
              Нужна хотя бы одна ссылка на требование
            </p>
          )}
        </fieldset>

        <label className="pv-field">
          <span>Условие (guard)</span>
          <textarea
            className="pv-mono"
            rows={2}
            value={guardText}
            onChange={(event) => setGuardText(event.target.value)}
            spellCheck={false}
            aria-invalid={Boolean(guard.error || guardIssues.length)}
            aria-describedby={`${formId}-guard-help`}
          />
          <span id={`${formId}-guard-help`} className="pv-field-help">
            {guard.error ??
              guardIssues.map((issue) => issue.message).join("; ")}
          </span>
        </label>

        <fieldset className="pv-field">
          <legend>Эффекты</legend>
          {parsedRows.length === 0 && (
            <p className="pv-muted">Переход не меняет переменные.</p>
          )}
          {parsedRows.map((row, index) => {
            const rowIssues = issuesFor(
              `transitions.${transition.id}.effects[${index}]`,
            );
            const message =
              row.parsed.error ??
              rowIssues.map((issue) => issue.message).join("; ");
            return (
              <div key={row.key} className="pv-effect-row">
                <select
                  aria-label={`Переменная эффекта ${index + 1}`}
                  value={row.variable}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item) =>
                        item.key === row.key
                          ? { ...item, variable: event.target.value }
                          : item,
                      ),
                    )
                  }
                >
                  {spec.variables
                    .filter(
                      (variable) =>
                        variable.id === row.variable ||
                        !assigned.has(variable.id),
                    )
                    .map((variable) => (
                      <option key={variable.id} value={variable.id}>
                        {variable.id}
                      </option>
                    ))}
                </select>
                <span className="pv-assign" aria-hidden="true">
                  :=
                </span>
                <input
                  className="pv-mono"
                  aria-label={`Новое значение ${row.variable}`}
                  value={row.text}
                  spellCheck={false}
                  aria-invalid={Boolean(message)}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item) =>
                        item.key === row.key
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="pv-icon-button"
                  aria-label={`Убрать присваивание ${row.variable}`}
                  onClick={() =>
                    setRows((current) =>
                      current.filter((item) => item.key !== row.key),
                    )
                  }
                >
                  <CloseIcon />
                </button>
                {message && (
                  <span className="pv-field-help pv-effect-row__error">
                    {message}
                  </span>
                )}
              </div>
            );
          })}
          {free.length > 0 && (
            <button
              type="button"
              className="pv-button pv-button--quiet"
              onClick={() => {
                const variable = free[0]!;
                setRows((current) => [
                  ...current,
                  {
                    key: nextKey,
                    variable: variable.id,
                    text: formatExpression({
                      kind: "literal",
                      value: variable.initial_value,
                    }),
                  },
                ]);
                setNextKey((key) => key + 1);
              }}
            >
              <PlusIcon /> Присваивание
            </button>
          )}
        </fieldset>

        {otherIssues.length > 0 && (
          <ul className="pv-issues">
            {otherIssues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <code>{issue.path}</code> {issue.message}
              </li>
            ))}
          </ul>
        )}

        <div className="pv-form__actions">
          <button
            type="submit"
            className="pv-button pv-button--primary"
            disabled={!canApply}
          >
            Применить к черновику
          </button>
          <button
            type="button"
            className="pv-button pv-button--danger"
            onClick={onRemove}
          >
            Удалить переход
          </button>
        </div>
      </form>
    </section>
  );
}
