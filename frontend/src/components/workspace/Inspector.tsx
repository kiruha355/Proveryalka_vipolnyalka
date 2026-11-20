import { useEffect, useRef, type ReactNode } from "react";
import { inspectorSections } from "../../app/extensions";
import type { WorkspaceContextValue } from "../../app/workspace";
import type { BehavioralModel, ExtractedRequirement } from "../../api/types";
import { domainKindLabel, formatDomain, variablesOf } from "../../domain/expression";
import { PROPERTY_KIND } from "../../domain/status";
import { Expr, Val } from "../Expr";
import { RequirementChips } from "../RequirementChips";
import { StatusBadge } from "../StatusBadge";
import { Close } from "../icons";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Quotes({ requirement, model }: { requirement: ExtractedRequirement; model: BehavioralModel }) {
  return (
    <ul className="quotes">
      {requirement.source_refs.map((ref) => {
        const index = model.sources.findIndex((s) => s.id === ref.source_id);
        const origin = index === 0 ? "из описания пользователя" : ref.source_id.startsWith("answer_") ? "из ответа на уточнение" : "из источника";
        return <li key={`${ref.source_id}:${ref.start}`}><q>{ref.quote}</q> <span className="muted small">{origin}</span></li>;
      })}
    </ul>
  );
}

function RequirementTexts({ ids, context }: { ids: string[]; context: WorkspaceContextValue }) {
  const model = context.version?.spec;
  if (!model || ids.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="inspector__reqs">
      {ids.map((id) => {
        const requirement = context.requirements?.byId.get(id);
        return (
          <li key={id}>
            <RequirementChips ids={[id]} index={context.requirements} onSelect={(rid) => context.select({ kind: "requirement", id: rid })} />
            {requirement ? <span>{requirement.text}</span> : <span className="warn-text">нет в каталоге версии</span>}
            {requirement && <Quotes requirement={requirement} model={model} />}
          </li>
        );
      })}
    </ul>
  );
}

function ElementLinks({ items, context }: { items: { kind: "variable" | "transition" | "property"; id: string; name: string }[]; context: WorkspaceContextValue }) {
  if (items.length === 0) return <span className="muted">—</span>;
  return (
    <span className="inline-links">
      {items.map((item) => (
        <button key={`${item.kind}:${item.id}`} type="button" className="link-button" onClick={() => context.select({ kind: item.kind, id: item.id })}>
          {item.name}
        </button>
      ))}
    </span>
  );
}

export function Inspector({ context }: { context: WorkspaceContextValue }) {
  const element = context.selection.element;
  const model = context.version?.spec;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement)) context.select(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [element, context]);

  if (!element || !model) return null;

  let title = "";
  let kind = "";
  let body: ReactNode = null;

  if (element.kind === "variable") {
    const v = model.variables.find((x) => x.id === element.id);
    if (!v) return null;
    title = v.name; kind = "Переменная";
    body = (
      <dl>
        <Row label="Идентификатор"><code>{v.id}</code></Row>
        <Row label="Тип">{domainKindLabel(v.domain)}: <code className="expr">{formatDomain(v.domain)}</code></Row>
        <Row label="Начальное значение"><Val value={v.initial_value} /></Row>
        <Row label="Проверяется в условиях"><ElementLinks context={context} items={model.transitions.filter((t) => variablesOf(t.guard).has(v.id)).map((t) => ({ kind: "transition", id: t.id, name: t.name }))} /></Row>
        <Row label="Меняется переходами"><ElementLinks context={context} items={model.transitions.filter((t) => t.effects.some((e) => e.variable === v.id)).map((t) => ({ kind: "transition", id: t.id, name: t.name }))} /></Row>
        <Row label="Требования"><RequirementTexts ids={v.requirement_ids} context={context} /></Row>
      </dl>
    );
  } else if (element.kind === "transition") {
    const t = model.transitions.find((x) => x.id === element.id);
    if (!t) return null;
    title = t.name; kind = "Переход";
    body = (
      <dl>
        <Row label="Идентификатор"><code>{t.id}</code></Row>
        <Row label="Разрешено, если"><Expr value={t.guard} /></Row>
        <Row label="Изменения">
          {t.effects.length === 0 ? <span className="muted">ничего не меняет</span> : (
            <ul className="effects">{t.effects.map((e) => <li key={e.variable}><code>{e.variable}</code> := <Expr value={e.value} /></li>)}</ul>
          )}
        </Row>
        <Row label="Требования"><RequirementTexts ids={t.requirement_ids} context={context} /></Row>
      </dl>
    );
  } else if (element.kind === "property") {
    const p = model.properties.find((x) => x.id === element.id);
    if (!p) return null;
    title = p.name; kind = "Свойство";
    const latest = context.checks.flatMap((c) => c.results ?? []).find((r) => r.property_id === p.id && r.version_id === context.version?.id);
    body = (
      <dl>
        <Row label="Идентификатор"><code>{p.id}</code></Row>
        <Row label="Тип">{PROPERTY_KIND[p.kind].label}. {PROPERTY_KIND[p.kind].meaning}</Row>
        <Row label="Условие"><Expr value={p.predicate} /></Row>
        <Row label="Смысл">{p.explanation}</Row>
        {p.origin === "proposal" && (
          <Row label="Происхождение">
            Предложено агентом{p.approved_by ? <>, подтверждено ответом <q>{p.approved_by.quote}</q></> : ", не подтверждено"}
          </Row>
        )}
        <Row label="Последний результат">{latest ? <StatusBadge status={latest.status} size="sm" /> : <span className="muted">не проверялось</span>}</Row>
        <Row label="Требования"><RequirementTexts ids={p.requirement_ids} context={context} /></Row>
      </dl>
    );
  } else if (element.kind === "requirement") {
    const r = context.requirements?.byId.get(element.id);
    title = context.requirements?.label(element.id) ?? element.id; kind = "Требование";
    if (!r) {
      body = <p className="warn-text">Требования нет в каталоге выбранной версии.</p>;
    } else {
      const users = [
        ...model.variables.filter((x) => x.requirement_ids.includes(r.id)).map((x) => ({ kind: "variable" as const, id: x.id, name: x.name })),
        ...model.transitions.filter((x) => x.requirement_ids.includes(r.id)).map((x) => ({ kind: "transition" as const, id: x.id, name: x.name })),
        ...model.properties.filter((x) => x.requirement_ids.includes(r.id)).map((x) => ({ kind: "property" as const, id: x.id, name: x.name })),
      ];
      body = (
        <dl>
          <Row label="Текст">{r.text}</Row>
          <Row label="Цитаты"><Quotes requirement={r} model={model} /></Row>
          <Row label="Элементы модели"><ElementLinks context={context} items={users} /></Row>
        </dl>
      );
    }
  } else {
    const v = model.variables.find((x) => x.id === element.variable);
    title = `${v?.name ?? element.variable}: ${String(element.value)}`; kind = "Значение";
    const sets = model.transitions.filter((t) => t.effects.some((e) => e.variable === element.variable && e.value.kind === "literal" && e.value.value === element.value));
    body = (
      <dl>
        <Row label="Переменная"><code>{element.variable}</code> = <Val value={element.value} /></Row>
        <Row label="Устанавливают"><ElementLinks context={context} items={sets.map((t) => ({ kind: "transition", id: t.id, name: t.name }))} /></Row>
        <Row label="Начальное">{v && v.initial_value === element.value ? "да" : "нет"}</Row>
      </dl>
    );
  }

  const sections = inspectorSections().filter((s) => s.matches(context));

  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <header className="inspector__header">
        <div>
          <span className="inspector__kind">{kind}</span>
          <h2 id="inspector-title" ref={heading} tabIndex={-1}>{title}</h2>
        </div>
        <button type="button" className="icon-button" onClick={() => context.select(null)} aria-label="Закрыть инспектор"><Close /></button>
      </header>
      <div className="inspector__body">
        {body}
        {sections.map((section) => {
          const Section = section.component;
          return (
            <section key={section.id} className="inspector__section" aria-label={section.label}>
              <h3>{section.label}</h3>
              <Section context={context} />
            </section>
          );
        })}
      </div>
    </aside>
  );
}
