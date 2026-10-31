export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental parser for text/event-stream (WHATWG HTML §9.2.6). */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private sawCarriageReturn = false;

  feed(chunk: string): SseMessage[] {
    let text = chunk;
    // A CRLF split across chunks must not produce an extra empty line.
    if (this.sawCarriageReturn && text.startsWith("\n")) text = text.slice(1);
    this.sawCarriageReturn = text.endsWith("\r");
    this.buffer += text;
    const out: SseMessage[] = [];
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = this.line(line);
      if (message) out.push(message);
    }
    return out;
  }

  /** Flush at end of stream: an unterminated event is discarded per spec. */
  end(): void {
    this.buffer = "";
    this.data = [];
    this.event = "";
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const message = { id: this.id, event: this.event || "message", data: this.data.join("\n") };
      this.data = [];
      this.event = "";
      return message;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const message of parser.feed(decoder.decode(value, { stream: true }))) yield message;
    }
    parser.end();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
