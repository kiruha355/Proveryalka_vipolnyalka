import type {
  ArtifactEntry, DocumentSource, DialogueView, CheckRequest, CheckRun, Model, ModelVersion, ReadyInfo, Run, RunEvent, Session, SessionDetail,
} from "./types";

export interface ApiCapabilities {
  /** "demo" data comes from recorded fixtures; never a live LLM or TLC. */
  adapter: "http" | "demo";
  /** Messages reach the analyst agent. */
  agent: boolean;
  /** MessageCreate accepts question_id (addressed answer to one clarification). */
  questionId: boolean;
  /** Checks accept limits other than the defaults. */
  customLimits: boolean;
  /** Diagnostic files of a check can be listed and downloaded. */
  artifacts: boolean;
  /** Check runs of a version can be discovered from the server. */
  checkDiscovery: boolean;
  /** TXT/MD/DOCX upload with server-side text extraction. */
  documents: boolean;
  dialogue?: boolean;
  explanations?: boolean;
}

export const DOCUMENT_TYPES = [".txt", ".md", ".docx"] as const;

export interface MessageBody {
  text?: string;
  source_id?: string;
  question_id?: string;
}

/**
 * Transport-neutral client used by the UI. HttpApi talks to the FastAPI
 * backend; DemoApi serves recorded fixtures. Components never call fetch.
 */
export interface ProveryalkaApi {
  /** Namespace for client-side persistence (run ids, drafts). */
  readonly id: string;
  capabilities(signal?: AbortSignal): Promise<ApiCapabilities>;
  ready(signal?: AbortSignal): Promise<ReadyInfo>;

  listSessions(signal?: AbortSignal): Promise<Session[]>;
  createSession(body: { title: string }, key: string, signal?: AbortSignal): Promise<Session>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>;
  sendMessage(sessionId: string, body: MessageBody, key: string, signal?: AbortSignal): Promise<Run>;

  getDialogue?(sessionId: string, signal?: AbortSignal): Promise<DialogueView>;
  retryPending?(sessionId: string, key: string, signal?: AbortSignal): Promise<Run>;
  discardPending?(sessionId: string, signal?: AbortSignal): Promise<DialogueView>;
  retryExplanation?(runId: string, key: string, signal?: AbortSignal): Promise<Run>;

  getRun(runId: string, signal?: AbortSignal): Promise<Run>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<Run>;
  /** Replays events with event_id > after, then follows the live stream until the server closes it. */
  streamEvents(runId: string, after: number, signal: AbortSignal): AsyncIterable<RunEvent>;

  listModels(sessionId: string, signal?: AbortSignal): Promise<Model[]>;
  listVersions(modelId: string, signal?: AbortSignal): Promise<ModelVersion[]>;
  createVersion?(modelId: string, body: {spec: ModelVersion["spec"]; parent_id?: string | null}, key: string, signal?: AbortSignal): Promise<ModelVersion>;
  approveVersion(modelId: string, number: number, signal?: AbortSignal): Promise<ModelVersion>;

  createCheck(modelId: string, number: number, body: CheckRequest, key: string, signal?: AbortSignal): Promise<Run>;
  getCheck(runId: string, signal?: AbortSignal): Promise<CheckRun>;
  listArtifacts(runId: string, signal?: AbortSignal): Promise<ArtifactEntry[]>;
  artifactUrl(runId: string, name: string): string;
  /** Only when capabilities().checkDiscovery is true. */
  listCheckRuns?(versionId: string, signal?: AbortSignal): Promise<string[]>;
  /** Only when capabilities().documents is true. A failed extraction resolves with status "failed". */
  uploadDocument?(sessionId: string, file: File, key: string, signal?: AbortSignal): Promise<DocumentSource>;
}

export function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
