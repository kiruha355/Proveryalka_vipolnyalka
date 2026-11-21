import { useMemo } from "react";
import type { RepositoryFile, RepositoryRange } from "../../api/repositories";

interface Directory {
  name: string;
  children: Map<string, Directory>;
  files: RepositoryFile[];
}

function tree(files: RepositoryFile[]) {
  const root: Directory = { name: "", children: new Map(), files: [] };
  for (const file of files) {
    let directory = root;
    for (const name of file.path.split("/").slice(0, -1)) {
      const child = directory.children.get(name) ?? { name, children: new Map(), files: [] };
      directory.children.set(name, child);
      directory = child;
    }
    directory.files.push(file);
  }
  return root;
}

interface TreeProps {
  ranges: RepositoryRange[];
  onToggle(file: RepositoryFile): void;
  onOpen?: (file: RepositoryFile) => void;
}

function Files({ directory, depth, ranges, onToggle, onOpen }: TreeProps & { directory: Directory; depth: number }) {
  return <ul className="repository-tree">
    {[...directory.children.values()].map(child => <li key={child.name}>
      <details open={depth === 0}><summary>{child.name}/</summary>
        <Files directory={child} depth={depth + 1} ranges={ranges} onToggle={onToggle} onOpen={onOpen} />
      </details>
    </li>)}
    {directory.files.map(file => {
      const selected = ranges.some(range => range.path === file.path);
      const name = file.path.split("/").at(-1);
      return <li key={file.path} className="repository-tree__file">
        <input type="checkbox" checked={selected} disabled={file.lines === 0 || (!selected && ranges.length >= 20)}
          aria-label={`Выбрать ${file.path}`} onChange={() => onToggle(file)} />
        {onOpen ? <button type="button" className="repository-quote" title={file.path} onClick={() => onOpen(file)}><code>{name}</code></button> : <code>{name}</code>}
        <span className="muted small">{file.lines} стр.</span>
      </li>;
    })}
  </ul>;
}

export function RepositoryTree({ files, ...props }: TreeProps & { files: RepositoryFile[] }) {
  const directory = useMemo(() => tree(files), [files]);
  return files.length ? <Files directory={directory} depth={0} {...props} /> : <p className="muted">Нет доступных файлов</p>;
}
