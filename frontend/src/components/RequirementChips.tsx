import type { RequirementIndex } from "../domain/requirements";

interface Props {
  ids: string[];
  index: RequirementIndex | null;
  onSelect?: (id: string) => void;
}

/** Requirement references as short labels; the full text is the accessible name and tooltip. */
export function RequirementChips({ ids, index, onSelect }: Props) {
  if (ids.length === 0) return <span className="muted">—</span>;
  return (
    <span className="req-chips">
      {ids.map((id) => {
        const requirement = index?.byId.get(id);
        const label = index?.label(id) ?? id;
        const title = requirement ? `${label}: ${requirement.text}` : `${label}: нет в каталоге требований версии`;
        return onSelect ? (
          <button key={id} type="button" className={`req-chip${requirement ? "" : " req-chip--missing"}`} title={title}
            aria-label={title} onClick={() => onSelect(id)}>
            {label}
          </button>
        ) : (
          <span key={id} className={`req-chip${requirement ? "" : " req-chip--missing"}`} title={title}>{label}</span>
        );
      })}
    </span>
  );
}
