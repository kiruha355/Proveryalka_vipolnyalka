import type { GeneratedFileEntry } from "./contract";

export type TreeFolder = {
  kind: "folder";
  name: string;
  path: string;
  children: TreeItem[];
};
export type TreeFile = {
  kind: "file";
  name: string;
  path: string;
  entry: GeneratedFileEntry;
};
export type TreeItem = TreeFolder | TreeFile;

const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/** Дерево каталогов из проверенных путей; каталоги выше файлов, имена по алфавиту. */
export function buildFileTree(files: GeneratedFileEntry[]): TreeFolder {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const entry of files) {
    const parts = entry.path.split("/");
    let folder = root;
    parts.slice(0, -1).forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let next = folder.children.find(
        (child): child is TreeFolder =>
          child.kind === "folder" && child.name === part,
      );
      if (!next) {
        next = { kind: "folder", name: part, path, children: [] };
        folder.children.push(next);
      }
      folder = next;
    });
    folder.children.push({
      kind: "file",
      name: parts[parts.length - 1]!,
      path: entry.path,
      entry,
    });
  }
  const sort = (folder: TreeFolder) => {
    folder.children.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "folder"
          ? -1
          : 1
        : collator.compare(a.name, b.name),
    );
    folder.children.forEach((child) => child.kind === "folder" && sort(child));
  };
  sort(root);
  return root;
}

/** Видимые строки дерева с учётом раскрытых каталогов — для клавиатурной навигации. */
export function visibleItems(
  root: TreeFolder,
  expanded: Set<string>,
): Array<{ item: TreeItem; depth: number; parent: string | null }> {
  const rows: Array<{ item: TreeItem; depth: number; parent: string | null }> =
    [];
  const walk = (folder: TreeFolder, depth: number) => {
    for (const child of folder.children) {
      rows.push({ item: child, depth, parent: folder.path || null });
      if (child.kind === "folder" && expanded.has(child.path))
        walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

export function allFolderPaths(root: TreeFolder): string[] {
  const paths: string[] = [];
  const walk = (folder: TreeFolder) => {
    for (const child of folder.children) {
      if (child.kind === "folder") {
        paths.push(child.path);
        walk(child);
      }
    }
  };
  walk(root);
  return paths;
}
