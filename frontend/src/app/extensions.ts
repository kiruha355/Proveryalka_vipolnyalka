import type { ComponentType } from "react";
import type { WorkspaceContextValue } from "./workspace";

// Extension points of the workspace. Core views (requirements, model, check)
// and feature packages (diagram #40, project files #49) register the same way.

export interface WorkspaceViewProps {
  context: WorkspaceContextValue;
}

export interface WorkspaceViewDefinition {
  /** URL-safe id, unique: appears in the route as view=<id>. */
  id: string;
  /** Tab label. */
  label: string;
  /** 16px line icon; receives currentColor. */
  icon?: ComponentType<{ size?: number }>;
  /** Tab order. Core: requirements 10, model 20, check 30. Extensions: 40+. */
  order?: number;
  component: ComponentType<WorkspaceViewProps>;
  /**
   * Hide the tab while the view has nothing real to show (for example, no
   * model version yet). Hidden views are never shown as empty placeholders.
   */
  available?: (context: WorkspaceContextValue) => boolean;
}

export interface InspectorSectionDefinition {
  id: string;
  /** Section heading inside the inspector. */
  label: string;
  order?: number;
  /** Rendered only when this returns true for the current selection. */
  matches: (context: WorkspaceContextValue) => boolean;
  component: ComponentType<WorkspaceViewProps>;
}

export interface ExtensionModule {
  workspaceViews?: WorkspaceViewDefinition[];
  inspectorSections?: InspectorSectionDefinition[];
}

const views = new Map<string, WorkspaceViewDefinition>();
const sections = new Map<string, InspectorSectionDefinition>();
const listeners = new Set<() => void>();

export function registerWorkspaceView(definition: WorkspaceViewDefinition): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(definition.id)) throw new Error(`Invalid workspace view id: ${definition.id}`);
  views.set(definition.id, definition);
  listeners.forEach((listener) => listener());
}

export function registerInspectorSection(definition: InspectorSectionDefinition): void {
  sections.set(definition.id, definition);
  listeners.forEach((listener) => listener());
}

export function registerExtension(module: ExtensionModule): void {
  module.workspaceViews?.forEach(registerWorkspaceView);
  module.inspectorSections?.forEach(registerInspectorSection);
}

export function workspaceViews(): WorkspaceViewDefinition[] {
  return [...views.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function inspectorSections(): InspectorSectionDefinition[] {
  return [...sections.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function subscribeExtensions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: drop everything registered so far. */
export function resetExtensions(): void {
  views.clear();
  sections.clear();
}
