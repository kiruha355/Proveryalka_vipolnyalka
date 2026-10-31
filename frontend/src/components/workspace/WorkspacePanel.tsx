import { useState, type KeyboardEvent } from "react";
import { useCore } from "../../app/core";
import { workspaceViews, type WorkspaceViewDefinition } from "../../app/extensions";
import type { WorkspaceContextValue } from "../../app/workspace";
import { describeError } from "../../api/errors";
import { isTerminal } from "../../api/types";
import { summarizeResults } from "../../domain/status";
import { ErrorNotice, QuietStatus } from "../Notice";
import { Check } from "../icons";
import { ModelIssues } from "../views/ModelView";
import { boundResults } from "../views/CheckView";
import { CheckLauncher } from "./CheckLauncher";
import { Inspector } from "./Inspector";

interface Props {
  context: WorkspaceContextValue;
  viewId: string | undefined;
}

function VersionPicker({ context }: { context: WorkspaceContextValue }) {
  const core = useCore();
  const groups = core.workspace.models.data ?? [];
  if (!context.version) return null;
  const multiple = groups.length > 1;
  return (
    <label className="version-picker">
      <span className="visually-hidden">Версия модели</span>
      <select value={context.version.id} onChange={(e) => context.selectVersion(e.target.value)}>
        {groups.map((group) => {
          const options = group.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {multiple ? `${group.model.name} · ` : ""}версия {v.number}{v.approved ? " · согласована" : ""}
            </option>
          ));
          return multiple ? <optgroup key={group.model.id} label={group.model.name}>{options}</optgroup> : options;
        })}
      </select>
    </label>
  );
}

function Approval({ context }: { context: WorkspaceContextValue }) {
  const core = useCore();
  const [confirming, setConfirming] = useState(false);
  const version = context.version;
  if (!version) return null;
  if (version.approved) {
    return <span className="chip chip--holds"><Check size={14} /> Версия согласована</span>;
  }
  if (!confirming) {
    return <button type="button" className="button button--ghost button--small" onClick={() => setConfirming(true)}>Согласовать версию</button>;
  }
  return (
    <span className="confirm" role="group" aria-label="Подтверждение согласования">
      <span className="small">Согласование нельзя снять.</span>
      <button type="button" className="button button--small" autoFocus onClick={() => { setConfirming(false); void core.workspace.approve(version); }}>
        Согласовать v{version.number}
      </button>
      <button type="button" className="button button--small button--ghost" onClick={() => setConfirming(false)}>Отмена</button>
    </span>
  );
}

function Summary({ context }: { context: WorkspaceContextValue }) {
  const version = context.version;
  if (!version) return null;
  const running = context.checks.find((c) => c.run && !isTerminal(c.run.state));
  if (running) return <span className="chip chip--pending"><span className="spinner" aria-hidden="true" /> Идёт проверка</span>;
  const latest = context.checks.find((c) => (c.results?.length ?? 0) > 0);
  if (!latest) return null;
  const summary = summarizeResults(boundResults(latest, version.id, version.spec_hash).own);
  return <span className={`chip chip--${summary.tone}`}>{summary.label}</span>;
}

export function WorkspacePanel({ context, viewId }: Props) {
  const core = useCore();
  const { workspace } = core;
  const views = workspaceViews().filter((v) => (v.available ? v.available(context) : true));
  const active: WorkspaceViewDefinition | undefined = views.find((v) => v.id === viewId) ?? views.find((v) => v.id === (context.version ? "model" : "requirements")) ?? views[0];
  const title = context.version?.spec.name ?? core.history?.dialogue?.analysis.subject ?? "Рабочая область";
  const dialogue = core.history?.dialogue;

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = views.findIndex((v) => v.id === active?.id);
    const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length;
    const target = views[next];
    if (target) {
      context.openView(target.id);
      requestAnimationFrame(() => document.getElementById(`tab-${target.id}`)?.focus());
    }
  };

  const ActiveView = active?.component;
  const nothing = !context.version && !dialogue;

  return (
    <section className="workspace" aria-label="Рабочая область">
      <header className="workspace__header">
        <div className="workspace__title-row">
          <h1 className="workspace__title">{title}</h1>
          <Summary context={context} />
        </div>
        <div className="workspace__toolbar">
          <div className="workspace__version">
            <VersionPicker context={context} />
            <Approval context={context} />
          </div>
          {context.version && (
            <CheckLauncher version={context.version} selected={core.selectedProperties} onSelect={core.setSelectedProperties}
              limits={core.limits} onLimits={core.setLimits} customLimits={context.capabilities.customLimits}
              busy={workspace.checkStart.starting} onRun={core.runCheck} />
          )}
        </div>
        {workspace.checkStart.error !== null && (
          <ErrorNotice error={workspace.checkStart.error} title="Проверка не запущена"
            action={workspace.checkStart.retry
              ? <button type="button" className="button button--small" onClick={workspace.checkStart.retry}>Повторить запуск</button>
              : undefined} />
        )}
        {workspace.approveError !== null && <p className="warn-text" role="alert">Версия не согласована: {describeError(workspace.approveError)}</p>}
        {views.length > 0 && !nothing && (
          <div className="tabs" role="tablist" aria-label="Разделы рабочей области" onKeyDown={onTabKey}>
            {views.map((view) => {
              const Icon = view.icon;
              const selected = view.id === active?.id;
              return (
                <button key={view.id} id={`tab-${view.id}`} type="button" role="tab" aria-selected={selected}
                  aria-controls={`panel-${view.id}`} tabIndex={selected ? 0 : -1} className="tab"
                  onClick={() => context.openView(view.id)}>
                  {Icon && <Icon size={16} />} {view.label}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div className="workspace__body">
        {workspace.models.error !== null && !workspace.models.data && (
          <ErrorNotice error={workspace.models.error} title="Модели не загружены"
            action={<button type="button" className="button button--small" onClick={workspace.reloadModels}>Повторить</button>} />
        )}
        {workspace.models.loading && !workspace.models.data && <QuietStatus busy>Загрузка модели</QuietStatus>}
        {nothing && workspace.models.data && (
          <div className="view view--empty">
            <div className="empty">
              <h2 className="empty__title">Модель появится здесь</h2>
              <p className="empty__text">Агент построит её из описания; затем вы проверите таблицы и запустите TLC.</p>
            </div>
          </div>
        )}
        {!context.version && dialogue && (
          <ModelIssues issues={dialogue.analysis.model_issues} missing={dialogue.analysis.missing_information} />
        )}
        {ActiveView && !nothing && (
          <div role="tabpanel" id={`panel-${active!.id}`} aria-labelledby={`tab-${active!.id}`} className="workspace__view">
            <ActiveView context={context} />
          </div>
        )}
      </div>
      <Inspector context={context} />
    </section>
  );
}
