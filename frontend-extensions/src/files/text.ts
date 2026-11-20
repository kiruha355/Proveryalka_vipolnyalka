/** Декодирование содержимого: строгий UTF-8, иначе файл считается двоичным. */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

export type Token = {
  text: string;
  kind:
    | "plain"
    | "keyword"
    | "string"
    | "comment"
    | "number"
    | "decorator"
    | "builtin";
};

const PYTHON_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(
    " ",
  ),
);
const PYTHON_BUILTINS = new Set(
  "self cls int str bool dict list set tuple len print isinstance super Exception ValueError".split(
    " ",
  ),
);

/**
 * Простая разметка строки Python для читаемости: ключевые слова, строки,
 * комментарии, числа. Многострочные строки и f-string подсвечиваются
 * упрощённо — это только оформление, содержимое показывается без изменений.
 */
export function tokenizePythonLine(line: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /(#.*$)|("""|'''|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)|(@[A-Za-z_][\w.]*)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last)
      tokens.push({ text: line.slice(last, index), kind: "plain" });
    const [text, comment, string, decorator, number, word] = match;
    if (comment) tokens.push({ text, kind: "comment" });
    else if (string) tokens.push({ text, kind: "string" });
    else if (decorator) tokens.push({ text, kind: "decorator" });
    else if (number) tokens.push({ text, kind: "number" });
    else if (word)
      tokens.push({
        text,
        kind: PYTHON_KEYWORDS.has(word)
          ? "keyword"
          : PYTHON_BUILTINS.has(word)
            ? "builtin"
            : "plain",
      });
    last = index + text.length;
  }
  if (last < line.length)
    tokens.push({ text: line.slice(last), kind: "plain" });
  return tokens;
}

export function languageOf(
  path: string,
  mediaType: string,
): "python" | "plain" {
  return path.endsWith(".py") || mediaType === "text/x-python"
    ? "python"
    : "plain";
}
