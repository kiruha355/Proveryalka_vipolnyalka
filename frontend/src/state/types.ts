import type {
  ArtifactEntry, ExplanationView, Model, ModelVersion, Question, Run, RunEvent, VerificationResult,
} from "../api/types";
import type { StreamStatus } from "./runTracker";

export interface Loadable<T> {
  data: T | null;
  error: unknown | null;
  loading: boolean;
}

export const idle = <T,>(): Loadable<T> => ({ data: null, error: null, loading: false });

export interface RunFailure {
  code: string;
  message: string;
}

export interface AgentRunView {
  runId: string;
  text: string;
  questionId: string | null;
  startedAt: string;
  run: Run | null;
  events: RunEvent[];
  stream: StreamStatus;
  /** Concatenated message_delta text, as delivered. */
  delta: string;
  /** clarification_requested payloads of this run. */
  questions: Question[];
  proposed: { model_id: string; version_id: string; number: number }[];
  failure: RunFailure | null;
  cancelRequested: boolean;
}

export interface CheckRunView {
  explanation?: ExplanationView;
  runId: string;
  versionId: string;
  modelId: string;
  number: number;
  propertyIds: string[] | null;
  /** Client time the check was requested; null for runs discovered on the server. */
  startedAt: string | null;
  run: Run | null;
  /** null until GET /api/checks/{id} answered; [] means the server has no report yet. */
  results: VerificationResult[] | null;
  resultsError: unknown | null;
  stream: StreamStatus;
  failure: RunFailure | null;
  artifacts: Loadable<ArtifactEntry[]>;
  cancelRequested: boolean;
}

export interface ModelGroup {
  model: Model;
  versions: ModelVersion[];
}
