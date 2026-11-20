import type { ReactNode } from "react";

/** Provider text stays escaped; only code fences, inline code and emphasis are formatted. */
export function MessageText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let lines: string[] = [], code = false;
  const flush = () => {
    if (!lines.length) return;
    const value = lines.join("\n");
    blocks.push(code
      ? <pre key={blocks.length}><code>{value}</code></pre>
      : <p key={blocks.length} className="msg__text">{value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code>
          : part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}</p>);
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (/^```[\w+-]*\s*$/.test(line)) { flush(); code = !code; }
    else lines.push(line);
  }
  flush();
  return <div className="msg__formatted">{blocks}</div>;
}
