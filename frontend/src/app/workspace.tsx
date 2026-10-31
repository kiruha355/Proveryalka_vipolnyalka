import { createContext, useContext } from "react";
import type { ApiCapabilities, ProveryalkaApi } from "../api/api";
import type { ModelVersion, Property, Session, VerificationResult } from "../api/types";
import type { RequirementIndex } from "../domain/requirements";
import type { TraceRole } from "../domain/status";
import type { StepView } from "../domain/trace";
import type { CheckRunView } from "../state/types";

/** What the inspector shows and what feature views highlight. */
export type ElementRef =
  | { kind: "variable"; id: string }
  | { kind: "transition"; id: string }
  | { kind: "property"; id: string }
  | { kind: "requirement"; id: string }
  /** One value of an enum/boolean variable, e.g. a process stage status=Cancelled. */
  | { kind: "value"; variable: string; value: string | number | boolean };

export interface TraceTarget {
  checkRunId: string;
  propertyId: string;
  /** Index into the trace (0 = initial state). */
  step: number;
}

export interface WorkspaceSelection {
  /** Selected immutable model version; checks and tables always refer to it. */
  versionId: string | null;
  element: ElementRef | null;
  trace: TraceTarget | null;
}

/** A trace resolved against the version it was checked on. */
export interface TraceFocus {
  check: CheckRunView;
  result: VerificationResult;
  property: Property | undefined;
  role: TraceRole;
  steps: StepView[];
  /** Current step index (selection.trace.step, clamped). */
  step: number;
  /** Step that violates the property / reaches the target, if any. */
  focus: number | null;
}

export interface WorkspaceContextValue {
  api: ProveryalkaApi;
  capabilities: ApiCapabilities;
  session: Session;
  /** All versions of all models of the session, ordered by model then number. */
  versions: ModelVersion[];
  version: ModelVersion | null;
  /** Requirement labels/lookup for the selected version. */
  requirements: RequirementIndex | null;
  /** Check runs of the selected version, newest first. Results of other versions never appear here. */
  checks: CheckRunView[];
  trace: TraceFocus | null;
  selection: WorkspaceSelection;
  select(element: ElementRef | null): void;
  focusTrace(target: Omit<TraceTarget, "step"> & { step?: number } | null): void;
  setTraceStep(step: number): void;
  createVersion?(modelId: string, body: {spec: ModelVersion["spec"]; parent_id?: string | null}, key: string): Promise<ModelVersion>;
  selectVersion(versionId: string): void;
  openView(viewId: string): void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace() must be used inside the session workspace");
  return value;
}
