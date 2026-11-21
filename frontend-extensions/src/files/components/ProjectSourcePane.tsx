import { useSyncExternalStore, type ReactNode, type Ref } from "react";
import { SplitPane } from "../../ui/SplitPane";

const query = "(max-width: 640px)";
const isNarrow = () => window.matchMedia?.(query).matches ?? false;
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

type SourceView = "files" | "code";

export function ProjectSourcePane({ children, view, onViewChange, hasFile, codeButtonRef }: {
  children: [ReactNode, ReactNode];
  view: SourceView;
  onViewChange: (view: SourceView) => void;
  hasFile: boolean;
  codeButtonRef: Ref<HTMLButtonElement>;
}) {
  const narrow = useSyncExternalStore(subscribe, isNarrow, () => false);
  if (!narrow) {
    return (
      <SplitPane label="Ширина дерева файлов" storageKey="pv-files-tree-width" initial={27} min={15} max={60}>
        {children}
      </SplitPane>
    );
  }
  return (
    <div className="pv-source-mobile">
      <div className="pv-segmented" role="group" aria-label="Просмотр проекта">
        <button type="button" aria-pressed={view === "files"} onClick={() => onViewChange("files")}>
          Файлы
        </button>
        <button ref={codeButtonRef} type="button" aria-pressed={view === "code"} disabled={!hasFile} onClick={() => onViewChange("code")}>
          Код
        </button>
      </div>
      {children[view === "files" ? 0 : 1]}
    </div>
  );
}
