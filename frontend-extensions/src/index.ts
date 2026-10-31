import "./styles/extensions.css";

// Точка подключения к рабочей области ядра (frontend/src/extensions/load.ts):
// ядро читает workspaceViews и inspectorSections.
export {
  workspaceViews,
  inspectorSections,
  DiagramView,
  FilesView,
  StageSection,
  ImplementationSection,
} from "./host/views";
export {
  configureProjectFiles,
  setProjectFocus,
  implementationLinks,
} from "./host/project-files";
export type { ProjectFilesSource } from "./host/project-files";
export type * from "./host/contract";

// Контракты сервера (backend 62c12b8)
export type * from "./contracts/model";
export { IDENTIFIER_PATTERN } from "./contracts/model";

// DSL
export {
  formatExpression,
  parseExpression,
  ExpressionSyntaxError,
  expressionsEqual,
} from "./dsl/expression-text";
export {
  simplify,
  evaluate,
  domainValues,
  domainContains,
} from "./dsl/evaluate";
export { validateModel } from "./dsl/validate";
export type { ModelIssue } from "./dsl/validate";
export { computeSpecHash } from "./dsl/spec-hash";
export { normalizeSpec } from "./dsl/normalize";

// #40 диаграмма этапов
export { StateGraphWorkspace } from "./graph/components/StateGraphWorkspace";
export type { StateGraphWorkspaceProps } from "./graph/components/StateGraphWorkspace";
export { StateGraphCanvas } from "./graph/components/StateGraphCanvas";
export type { StateGraphCanvasProps } from "./graph/components/StateGraphCanvas";
export { TransitionTable } from "./graph/components/TransitionTable";
export {
  projectModel,
  defaultProjection,
  projectionCandidates,
  nodeForState,
  DEFAULT_MAX_PROJECTION_NODES,
} from "./graph/projection";
export type {
  StateProjection,
  ProjectionEdge,
  ProjectionNode,
  ProjectionResult,
} from "./graph/projection";
export { layoutProjection } from "./graph/layout";
export {
  analyzeTrace,
  bindReportToVersion,
  pickTraceResult,
} from "./graph/trace";
export type { TraceAnalysis, AnalyzedStep, ReportBinding } from "./graph/trace";
export {
  applyDraftAction,
  diffModels,
  draftIdempotencyKey,
  versionCreateBody,
} from "./graph/draft";
export type { DraftAction, ModelChange } from "./graph/draft";
export type { GraphSelection } from "./graph/flow-elements";

// HTTP для подтверждённых маршрутов версий
export {
  createHttpModelVersionsPort,
  ApiError,
  describeApiError,
} from "./api/http";
export type { ModelVersionsPort } from "./api/http";

// #49 файлы проекта
export type * from "./files/contract";
export { ProjectFilesView } from "./files/components/ProjectFilesView";
export type {
  ProjectFilesViewProps,
  ProjectFocus,
} from "./files/components/ProjectFilesView";
export {
  createCodegenProvider,
  encodePathSegments,
  verificationDetails,
} from "./files/provider";
export type {
  CodegenProvider,
  CodegenAvailability,
  CodegenHttpOptions,
} from "./files/provider";
export {
  reviewManifest,
  filesDigest,
  compareWithVersion,
  testsProvenance,
} from "./files/manifest";
export { checkArchivePath, findPathConflicts } from "./files/safe-path";
export {
  buildProjectArchive,
  downloadProjectArchive,
  archiveBlockers,
  ArchiveRefused,
} from "./files/zip";
