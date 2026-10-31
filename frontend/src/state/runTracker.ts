import type { ProveryalkaApi } from "../api/api";
import { ApiError, isAbort } from "../api/errors";
import type { RunEvent } from "../api/types";

export type StreamStatus =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "reconnecting"; attempt: number; maxAttempts: number; delayMs: number }
  | { kind: "lost"; error: unknown }
  | { kind: "closed" };

export interface RunTrackerOptions {
  api: ProveryalkaApi;
  runId: string;
  /** Last event already applied (0 = replay everything). */
  after?: number;
  onEvent: (event: RunEvent) => void;
  onStatus: (status: StreamStatus) => void;
  /** Delays between reconnect attempts; length = max attempts. */
  backoffMs?: number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000];

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

/**
 * Follows one run's SSE stream until run_finished. Reconnects with
 * Last-Event-ID after network failures, drops events it has already seen,
 * and stops for good on abort (session switch, unmount).
 */
export class RunTracker {
  private readonly options: RunTrackerOptions;
  private controller = new AbortController();
  private lastEventId: number;
  private finished = false;
  private running = false;

  constructor(options: RunTrackerOptions) {
    this.options = options;
    this.lastEventId = options.after ?? 0;
  }

  get cursor(): number {
    return this.lastEventId;
  }

  get done(): boolean {
    return this.finished;
  }

  start(): void {
    if (this.running || this.finished) return;
    this.running = true;
    void this.loop();
  }

  /** Manual reconnect after the stream was reported lost. */
  reconnect(): void {
    if (this.running || this.finished) return;
    this.controller = new AbortController();
    this.start();
  }

  stop(): void {
    this.controller.abort();
  }

  private async loop(): Promise<void> {
    const { api, runId, onEvent, onStatus } = this.options;
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
    const sleep = this.options.sleep ?? defaultSleep;
    const signal = this.controller.signal;
    let attempt = 0;
    onStatus({ kind: "connecting" });
    try {
      while (!this.finished && !signal.aborted) {
        try {
          let received = false;
          for await (const event of api.streamEvents(runId, this.lastEventId, signal)) {
            if (!received) {
              received = true;
              onStatus({ kind: "open" });
            }
            attempt = 0;
            if (event.run_id !== runId || event.event_id <= this.lastEventId) continue;
            this.lastEventId = event.event_id;
            onEvent(event);
            if (event.type === "run_finished") {
              this.finished = true;
              break;
            }
          }
          if (this.finished) break;
          // Closed without run_finished. After progress reconnect at once; an
          // empty close counts as a failed attempt so it cannot spin.
          if (!received) throw new ApiError("network", "Поток событий закрыт до завершения запуска");
        } catch (error) {
          if (isAbort(error) || signal.aborted) return;
          if (error instanceof ApiError && error.code === "INVALID_CURSOR") {
            // History is shorter than our cursor; replay from the start, consumers dedupe by event key.
            this.lastEventId = 0;
            continue;
          }
          const transient = !(error instanceof ApiError) || error.retryable;
          if (!transient || attempt >= backoff.length) {
            onStatus({ kind: "lost", error });
            return;
          }
          const delayMs = backoff[attempt] ?? 1000;
          attempt += 1;
          onStatus({ kind: "reconnecting", attempt, maxAttempts: backoff.length, delayMs });
          await sleep(delayMs, signal);
        }
      }
      if (this.finished) onStatus({ kind: "closed" });
    } catch (error) {
      if (!isAbort(error)) onStatus({ kind: "lost", error });
    } finally {
      this.running = false;
    }
  }
}

/** Keeps the first copy of each (run_id, event_id) pair, in arrival order. */
export function mergeEvents(existing: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((e) => `${e.run_id}:${e.event_id}`));
  const added = incoming.filter((e) => {
    const key = `${e.run_id}:${e.event_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length ? [...existing, ...added] : existing;
}
