import type { ComponentType, ReactNode } from "react";
import type {
  BehavioralModel,
  ModelVersion,
  Property,
  VerificationResult,
} from "../contracts/model";
import type { LooseBehavioralModel } from "../dsl/normalize";

/** Версия в типах ядра: origin/approved_by свойств необязательны (сервер их всегда отдаёт). */
export type HostModelVersion = Omit<ModelVersion, "spec"> & {
  spec: LooseBehavioralModel;
};
type HostProperty = Omit<Property, "origin" | "approved_by"> &
  Partial<Pick<Property, "origin" | "approved_by">>;

/**
 * Структурное подмножество публичного API ядра `@proveryalka/ui`
 * (frontend/src/public.ts, коммит 42e9a8b, reports/.../frontend-module-contract.md).
 * Расширение не импортирует ядро: TypeScript сверяет формы структурно, и пакет
 * собирается и тестируется отдельно. Здесь только поля, которые читаются.
 */

export type HostElementRef =
  | { kind: "variable"; id: string }
  | { kind: "transition"; id: string }
  | { kind: "property"; id: string }
  | { kind: "requirement"; id: string }
  | { kind: "value"; variable: string; value: string | number | boolean };

export interface HostTraceTarget {
  checkRunId: string;
  propertyId: string;
  step: number;
}

export interface HostCheckRunView {
  runId: string;
  versionId: string;
  results: VerificationResult[] | null;
}

export interface HostTraceFocus {
  check: HostCheckRunView;
  result: VerificationResult;
  property: HostProperty | undefined;
  step: number;
  focus: number | null;
}

export interface HostCapabilities {
  adapter: "http" | "demo";
}

export interface HostApi {
  readonly id: string;
  /** Нет в 42e9a8b; запрошено в extensions-module-contract.md. */
  createVersion?(
    modelId: string,
    body: { spec: BehavioralModel; parent_id: string },
    key: string,
    signal?: AbortSignal,
  ): Promise<HostModelVersion>;
}

export interface HostWorkspaceContext {
  api: HostApi;
  capabilities: HostCapabilities;
  versions: HostModelVersion[];
  version: HostModelVersion | null;
  checks: HostCheckRunView[];
  trace: HostTraceFocus | null;
  selection: {
    versionId: string | null;
    element: HostElementRef | null;
    trace: HostTraceTarget | null;
  };
  select(element: HostElementRef | null): void;
  focusTrace(
    target: { checkRunId: string; propertyId: string; step?: number } | null,
  ): void;
  setTraceStep(step: number): void;
  selectVersion(versionId: string): void;
  openView(viewId: string): void;
  /**
   * Нет в 42e9a8b; запрошено: создать версию (POST /api/models/{id}/versions),
   * обновить список версий ядра и выбрать новую. Без него правка недоступна.
   */
  createVersion?(
    modelId: string,
    body: { spec: BehavioralModel; parent_id: string },
    key: string,
  ): Promise<HostModelVersion>;
}

export interface HostViewProps {
  context: HostWorkspaceContext;
}

export interface HostWorkspaceView {
  id: string;
  label: string;
  icon?: ComponentType<{ size?: number }>;
  order?: number;
  /** Функциональный компонент: принимает контекст ядра, который шире HostWorkspaceContext. */
  component: (props: HostViewProps) => ReactNode;
  available?: (context: HostWorkspaceContext) => boolean;
}

export interface HostInspectorSection {
  id: string;
  label: string;
  order?: number;
  matches: (context: HostWorkspaceContext) => boolean;
  component: (props: HostViewProps) => ReactNode;
}
