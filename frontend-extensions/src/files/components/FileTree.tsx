import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { cx } from "../../ui/cx";
import { ChevronIcon, FileIcon, FolderIcon } from "../../ui/icons";
import type { TreeFolder } from "../tree";
import { visibleItems } from "../tree";

/** Дерево файлов по шаблону WAI-ARIA tree: стрелки, Home/End, Enter открывает файл. */
export function FileTree({
  root,
  rootLabel,
  expanded,
  onToggle,
  selectedPath,
  onOpen,
}: {
  root: TreeFolder;
  rootLabel: string;
  expanded: Set<string>;
  onToggle: (path: string, open?: boolean) => void;
  selectedPath: string | null;
  onOpen: (path: string) => void;
}) {
  const rows = useMemo(() => visibleItems(root, expanded), [root, expanded]);
  const [active, setActive] = useState<string | null>(
    selectedPath ?? rows[0]?.item.path ?? null,
  );
  const refs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (selectedPath) setActive(selectedPath);
  }, [selectedPath]);

  const activePath = rows.some((row) => row.item.path === active)
    ? active
    : (rows[0]?.item.path ?? null);

  const focus = (path: string | undefined) => {
    if (!path) return;
    setActive(path);
    refs.current.get(path)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rows.findIndex((row) => row.item.path === activePath);
    if (index < 0) return;
    const row = rows[index]!;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowDown":
        handled();
        focus(rows[index + 1]?.item.path);
        break;
      case "ArrowUp":
        handled();
        focus(rows[index - 1]?.item.path);
        break;
      case "Home":
        handled();
        focus(rows[0]?.item.path);
        break;
      case "End":
        handled();
        focus(rows[rows.length - 1]?.item.path);
        break;
      case "ArrowRight":
        handled();
        if (row.item.kind === "folder") {
          if (!expanded.has(row.item.path)) onToggle(row.item.path, true);
          else focus(rows[index + 1]?.item.path);
        }
        break;
      case "ArrowLeft":
        handled();
        if (row.item.kind === "folder" && expanded.has(row.item.path))
          onToggle(row.item.path, false);
        else if (row.parent) focus(row.parent);
        break;
      case "Enter":
      case " ":
        handled();
        if (row.item.kind === "folder") onToggle(row.item.path);
        else onOpen(row.item.path);
        break;
    }
  };

  return (
    <div className="pv-tree">
      <div className="pv-tree__root">
        <FolderIcon /> {rootLabel}/
      </div>
      <ul
        role="tree"
        aria-label={`Файлы проекта ${rootLabel}`}
        onKeyDown={onKeyDown}
      >
        {rows.map(({ item, depth }) => {
          const isFolder = item.kind === "folder";
          const open = isFolder && expanded.has(item.path);
          return (
            <li
              key={item.path}
              ref={(element) => {
                if (element) refs.current.set(item.path, element);
                else refs.current.delete(item.path);
              }}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isFolder ? open : undefined}
              aria-selected={
                item.kind === "file" ? item.path === selectedPath : undefined
              }
              tabIndex={item.path === activePath ? 0 : -1}
              className={cx(
                "pv-tree__item",
                item.path === selectedPath && "is-selected",
              )}
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => {
                setActive(item.path);
                if (isFolder) onToggle(item.path);
                else onOpen(item.path);
              }}
              onFocus={() => setActive(item.path)}
            >
              {isFolder ? (
                <>
                  <ChevronIcon
                    className={cx("pv-tree__chevron", open && "is-open")}
                    size={14}
                  />
                  <FolderIcon />
                </>
              ) : (
                <>
                  <span className="pv-tree__spacer" />
                  <FileIcon />
                </>
              )}
              <span className="pv-tree__name">{item.name}</span>
              {item.kind === "file" && item.entry.role === "test" && (
                <span className="pv-tree__role">тест</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
