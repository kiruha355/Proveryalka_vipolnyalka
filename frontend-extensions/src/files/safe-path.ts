/**
 * Проверка путей файлов перед показом и упаковкой в ZIP.
 * Путь отклоняется, если при распаковке на Linux, macOS или Windows он может
 * выйти за корень проекта, совпасть с другим файлом или подменить служебные
 * каталоги. Пути не исправляются молча: неподходящий путь — отказ с причиной.
 */

export type PathCheck =
  | { ok: true; path: string; key: string }
  | { ok: false; reason: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BIDI = /[‪-‮⁦-⁩‎‏]/;
const MAX_PATH = 1024;
const MAX_SEGMENT_BYTES = 255;

const encoder = new TextEncoder();

/** Ключ сравнения: NFC и нижний регистр — так совпадут README.md и readme.md на macOS/Windows. */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function checkSegment(segment: string): string | null {
  if (segment === "") return "пустой сегмент пути";
  if (segment === "." || segment === "..")
    return `сегмент «${segment}» выводит за пределы каталога`;
  if (encoder.encode(segment).length > MAX_SEGMENT_BYTES)
    return "имя длиннее 255 байт";
  if (WINDOWS_FORBIDDEN.test(segment))
    return 'символы < > : " | ? * недопустимы в Windows';
  if (/[. ]$/.test(segment))
    return "имя оканчивается точкой или пробелом (Windows их отбрасывает)";
  if (WINDOWS_RESERVED.test(segment))
    return `«${segment}» — зарезервированное имя устройства Windows`;
  if (segment.toLowerCase() === ".git")
    return "каталог .git в проекте может подменить репозиторий и его hooks";
  return null;
}

export function checkArchivePath(path: unknown): PathCheck {
  if (typeof path !== "string") return { ok: false, reason: "путь не строка" };
  if (path.length === 0) return { ok: false, reason: "пустой путь" };
  if (path.length > MAX_PATH)
    return { ok: false, reason: `путь длиннее ${MAX_PATH} символов` };
  if (CONTROL.test(path))
    return { ok: false, reason: "управляющие символы в пути" };
  if (BIDI.test(path))
    return { ok: false, reason: "символы смены направления текста в пути" };
  if (path.includes("\\"))
    return {
      ok: false,
      reason: "обратная косая черта: в Windows это разделитель каталогов",
    };
  if (path.startsWith("/")) return { ok: false, reason: "абсолютный путь" };
  if (/^[A-Za-z]:/.test(path))
    return { ok: false, reason: "путь с буквой диска" };
  if (path.startsWith("~")) return { ok: false, reason: "путь начинается с ~" };
  if (path !== path.normalize("NFC"))
    return { ok: false, reason: "путь не в форме Unicode NFC" };
  if (path.endsWith("/"))
    return { ok: false, reason: "путь к каталогу вместо файла" };
  for (const segment of path.split("/")) {
    const problem = checkSegment(segment);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, path, key: pathKey(path) };
}

export type PathConflict = { path: string; reason: string };

/**
 * Совпадения после нормализации и конфликты «файл и каталог с одним именем»
 * (app и app/main.py) среди уже проверенных путей.
 */
export function findPathConflicts(paths: string[]): PathConflict[] {
  const conflicts: PathConflict[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = pathKey(path);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      conflicts.push({
        path,
        reason:
          earlier === path
            ? "путь повторяется"
            : `совпадает с ${earlier} без учёта регистра или нормализации`,
      });
    } else {
      seen.set(key, path);
    }
  }
  const files = new Set(seen.keys());
  for (const [key, path] of seen) {
    const parts = key.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      if (files.has(prefix)) {
        conflicts.push({
          path,
          reason: `${seen.get(prefix)} — файл, но используется как каталог`,
        });
        break;
      }
    }
  }
  return conflicts;
}
