// Public surface for feature packages (frontend-extensions/). Import only from
// "@proveryalka/ui"; everything else in src/ may change without notice.

export type * from "./api/types";
export type { ApiCapabilities, MessageBody, ProveryalkaApi } from "./api/api";
export { ApiError, describeError, describeCode } from "./api/errors";

export type {
  ExtensionModule, InspectorSectionDefinition, WorkspaceViewDefinition, WorkspaceViewProps,
} from "./app/extensions";
export type { ElementRef, TraceFocus, TraceTarget, WorkspaceContextValue, WorkspaceSelection } from "./app/workspace";
export { useWorkspace } from "./app/workspace";
export type { AgentRunView, CheckRunView, Loadable } from "./state/types";

export { evaluate, formatDomain, formatExpression, formatValue, variablesOf } from "./domain/expression";
export { buildSteps, focusIndex, guardFacts, type StepView, type Change } from "./domain/trace";
export { PROPERTY_KIND, STATUS, statusInfo, summarizeResults, traceRole, type TraceRole } from "./domain/status";
export { indexRequirements, type RequirementIndex } from "./domain/requirements";

export { StatusBadge } from "./components/StatusBadge";
export { RequirementChips } from "./components/RequirementChips";
export { Expr, Val } from "./components/Expr";
export * as Icons from "./components/icons";
