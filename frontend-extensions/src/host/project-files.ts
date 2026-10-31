import { useSyncExternalStore } from "react";
import type { ProjectFocus } from "../files/components/ProjectFilesView";
import type { Generation, ModelElementRef } from "../files/contract";
import type { CodegenProvider } from "../files/provider";
import type { HostElementRef, HostWorkspaceContext } from "./contract";

/**
 * Подключение источника файлов проекта к рабочей области ядра. Пока источник
 * не задан, вкладка «Файлы» скрыта (правило ядра: без реальных данных вкладки нет).
 * Источник задаёт хост: HTTP-адаптер по контракту генератора или пример данных
 * в демо-режиме.
 */
export type ProjectRef = { projectId: string };
export type ProjectFilesSource = {
  provider: CodegenProvider;
  /** Проект для выбранной версии; null — для неё проекта нет. */
  resolve?: (context: HostWorkspaceContext) => ProjectRef | null;
};

let source: ProjectFilesSource | null = null;
const manifests = new Map<string, Generation>();
const activeGenerations = new Map<string,string>();
let focus: ProjectFocus | null = null;
const listeners = new Set<() => void>();

let revision = 0;
const notify = () => {
  revision++;
  listeners.forEach((listener) => listener());
};

export function configureProjectFiles(next: ProjectFilesSource | null): void {
  source = next;
  focus = null;
  manifests.clear();
  activeGenerations.clear();
  notify();
}

export function projectFilesSource(): ProjectFilesSource | null {
  return source;
}

export function rememberManifest(ref: ProjectRef, manifest: Generation): void {
  if (manifests.get(ref.projectId) === manifest && activeGenerations.get(manifest.version_id) === ref.projectId) return;
  activeGenerations.set(manifest.version_id, ref.projectId);
  manifests.set(ref.projectId, manifest);
  notify();
}

export function cachedManifest(ref: ProjectRef | null): Generation | null {
  return ref ? (manifests.get(ref.projectId) ?? null) : null;
}
export function manifestForVersion(
  id: string,
  hash: string,
): Generation | null {
  const idOfGeneration=activeGenerations.get(id);
  const manifest=idOfGeneration ? manifests.get(idOfGeneration) : null;
  return manifest?.spec_hash === hash ? manifest : null;
}

export function setProjectFocus(next: ProjectFocus | null): void {
  focus = next;
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProjectFilesState(): {
  focus: ProjectFocus | null;
  version: number;
} {
  const version = useSyncExternalStore(subscribe, () => revision);
  return { focus, version };
}

export type ImplementationLink = {
  path: string;
  lines: { start: number; end: number } | null;
  via: "file" | "explanation";
};

function sameElement(ref: ModelElementRef, element: HostElementRef): boolean {
  if (element.kind === "value") return false;
  return ref.kind === element.kind && ref.id === element.id;
}

/** Где в файлах проекта реализован элемент модели — по elements и requirement_ids генератора. */
export function implementationLinks(
  manifest: Generation,
  element: HostElementRef,
): ImplementationLink[] {
  const links: ImplementationLink[] = [];
  for (const file of manifest.files) {
    for (const ref of file.elements) {
      if (sameElement(ref, element))
        links.push({
          path: file.path,
          lines: { start: ref.start_line, end: ref.end_line },
          via: "file",
        });
    }
    if (
      element.kind === "requirement" &&
      file.requirement_ids.includes(element.id) &&
      !links.some((l) => l.path === file.path)
    )
      links.push({ path: file.path, lines: null, via: "file" });
  }
  return links;
}
