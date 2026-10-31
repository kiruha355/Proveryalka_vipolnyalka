import { useCore } from "../../app/core";
import type { ElementRef } from "../../app/workspace";
import type { WorkspaceViewProps } from "../../app/extensions";
import type { ModelIssue } from "../../api/types";
import { domainKindLabel, formatDomain } from "../../domain/expression";
import { PROPERTY_KIND } from "../../domain/status";
import { diffModels, sameJson, type ElementChange } from "../../domain/versionDiff";
import { Expr, Val } from "../Expr";
import { RequirementChips } from "../RequirementChips";

const SECTION_LABEL: Record<ElementChange["section"], string> = {
  requirements: "Требование", variables: "Переменная", transitions: "Переход", properties: "Свойство",
};
const FIELD_LABEL: Record<string, string> = {
  guard: "условие", effects: "изменения", predicate: "условие", domain: "область", initial_value: "начальное значение",
  requirement_ids: "требования", name: "название", text: "текст", source_refs: "цитаты", kind: "тип", explanation: "пояснение",
};

function isSelected(selection: ElementRef | null, kind: ElementRef["kind"], id: string) {
  return selection !== null && selection.kind === kind && "id" in selection && selection.id === id;
}

export function ModelIssues({ issues, missing }: { issues: ModelIssue[]; missing: string[] }) {
  if (issues.length === 0 && missing.length === 0) return null;
  return (
    <section className="model-issues" aria-label="Почему модель не собрана">
      <h3>Модель не собрана</h3>
      {missing.length > 0 && (
        <>
          <p>Не хватает сведений:</p>
          <ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </>
      )}
      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}><code>{issue.path}</code> {issue.message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ModelView({ context }: WorkspaceViewProps) {
  const core = useCore();
  const { version, versions, requirements, selection } = context;
  if (!version) return null;
  const spec = version.spec;
  const parent = version.parent_id ? versions.find((v) => v.id === version.parent_id) : undefined;
  const changes = parent ? diffModels(parent.spec, spec) : [];
  const changedIds = new Set(changes.map((c) => `${c.section}:${c.id}`));
  const select = (element: ElementRef) => context.select(element);
  const req = (ids: string[]) => <RequirementChips ids={ids} index={requirements} onSelect={(id) => select({ kind: "requirement", id })} />;
  const toggle = (id: string, on: boolean) => {
    const set = new Set(core.selectedProperties);
    if (on) set.add(id);
    else set.delete(id);
    core.setSelectedProperties(spec.properties.map((p) => p.id).filter((p) => set.has(p)));
  };
  const dialogue = core.history?.dialogue;
  const latestAnalysis = dialogue?.analysis.behavior;
  const newerAnalysis = dialogue && latestAnalysis && !sameJson(latestAnalysis, spec) && version.id === versions[versions.length - 1]?.id;

  return (
    <div className="view model-view">
      {parent && (
        <section className="diff" aria-label={`Изменения относительно версии ${parent.number}`}>
          <h3>Изменения относительно версии {parent.number}</h3>
          {changes.length === 0 ? (
            <p className="muted">Модель совпадает с версией {parent.number}.</p>
          ) : (
            <ul className="diff__list">
              {changes.map((c) => (
                <li key={`${c.section}:${c.id}`} className={`diff__item diff__item--${c.change}`}>
                  <span className="diff__kind">{c.change === "added" ? "добавлено" : c.change === "removed" ? "удалено" : "изменено"}</span>
                  {SECTION_LABEL[c.section]} «{c.name}»
                  {c.effects ? (
                    <span className="diff__effects">
                      {c.effects.added.map((l) => <span key={`+${l}`}> добавлено <code>{l}</code></span>)}
                      {c.effects.removed.map((l) => <span key={`-${l}`}> убрано <code>{l}</code></span>)}
                      {c.fields.filter((f) => f !== "effects").length > 0 && <span className="muted"> — также {c.fields.filter((f) => f !== "effects").map((f) => FIELD_LABEL[f] ?? f).join(", ")}</span>}
                    </span>
                  ) : c.fields.length > 0 && <span className="muted"> — {c.fields.map((f) => FIELD_LABEL[f] ?? f).join(", ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {newerAnalysis && (
        <p className="warn-text" role="note">Последний разбор агента отличается от этой версии; новая версия появится после завершения анализа.</p>
      )}

      <section className="model-section" aria-labelledby="vars-title">
        <h3 id="vars-title">Переменные и начальное состояние</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Переменная</th>
                <th scope="col">Тип</th>
                <th scope="col">Допустимые значения</th>
                <th scope="col">Начальное</th>
                <th scope="col">Требования</th>
              </tr>
            </thead>
            <tbody>
              {spec.variables.map((v) => (
                <tr key={v.id} className={`${isSelected(selection.element, "variable", v.id) ? "is-selected" : ""}${changedIds.has(`variables:${v.id}`) ? " is-changed" : ""}`}>
                  <th scope="row">
                    <button type="button" className="link-button" onClick={() => select({ kind: "variable", id: v.id })}>{v.name}</button>
                    <code className="cell-id">{v.id}</code>
                  </th>
                  <td>{domainKindLabel(v.domain)}</td>
                  <td><code className="expr">{formatDomain(v.domain)}</code></td>
                  <td><Val value={v.initial_value} /></td>
                  <td>{req(v.requirement_ids)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="model-section" aria-labelledby="transitions-title">
        <h3 id="transitions-title">Переходы</h3>
        {spec.transitions.length === 0 ? <p className="muted">В модели нет переходов.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Действие</th>
                  <th scope="col">Разрешено, если (guard)</th>
                  <th scope="col">Изменения (effects)</th>
                  <th scope="col">Требования</th>
                </tr>
              </thead>
              <tbody>
                {spec.transitions.map((t) => (
                  <tr key={t.id} className={`${isSelected(selection.element, "transition", t.id) ? "is-selected" : ""}${changedIds.has(`transitions:${t.id}`) ? " is-changed" : ""}`}>
                    <th scope="row">
                      <button type="button" className="link-button" onClick={() => select({ kind: "transition", id: t.id })}>{t.name}</button>
                      <code className="cell-id">{t.id}</code>
                    </th>
                    <td><Expr value={t.guard} /></td>
                    <td>
                      {t.effects.length === 0 ? <span className="muted">ничего не меняет</span> : (
                        <ul className="effects">
                          {t.effects.map((e) => <li key={e.variable}><code>{e.variable}</code> := <Expr value={e.value} /></li>)}
                        </ul>
                      )}
                    </td>
                    <td>{req(t.requirement_ids)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="model-section" aria-labelledby="props-title">
        <h3 id="props-title">Свойства для проверки</h3>
        {spec.properties.length === 0 ? <p className="muted">В модели нет свойств: проверять нечего.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="col-check"><span className="visually-hidden">Включить в проверку</span></th>
                  <th scope="col">Свойство</th>
                  <th scope="col">Тип</th>
                  <th scope="col">Условие</th>
                  <th scope="col">Смысл</th>
                  <th scope="col">Требования</th>
                </tr>
              </thead>
              <tbody>
                {spec.properties.map((p) => (
                  <tr key={p.id} className={`${isSelected(selection.element, "property", p.id) ? "is-selected" : ""}${changedIds.has(`properties:${p.id}`) ? " is-changed" : ""}`}>
                    <td className="col-check">
                      <input type="checkbox" checked={core.selectedProperties.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)}
                        aria-label={`Проверять «${p.name}»`} />
                    </td>
                    <th scope="row">
                      <button type="button" className="link-button" onClick={() => select({ kind: "property", id: p.id })}>{p.name}</button>
                      <code className="cell-id">{p.id}</code>
                      {p.origin === "proposal" && (
                        <span className={`tag ${p.approved_by ? "tag--confirmed" : "tag--proposal"}`}>
                          {p.approved_by ? "предложено, подтверждено" : "предложено агентом"}
                        </span>
                      )}
                    </th>
                    <td title={PROPERTY_KIND[p.kind].meaning}>{PROPERTY_KIND[p.kind].label}</td>
                    <td><Expr value={p.predicate} /></td>
                    <td>{p.explanation}</td>
                    <td>{req(p.requirement_ids)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
