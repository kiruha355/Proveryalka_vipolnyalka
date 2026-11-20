import type { ModelVersion } from "../contracts/model";
import { canonicalJson } from "../util/canonical-json";
import { sha256Hex } from "../util/sha256";
import type { GeneratedFileEntry, Generation, TestRun } from "./contract";
import { checkArchivePath, checkSegment, findPathConflicts } from "./safe-path";

export type ManifestIssue = { path: string; message: string };
export type RejectedFile = { path: string; reason: string };

export type ManifestReview = {
  /** Ошибки структуры manifest, из-за которых его нельзя показывать. */
  fatal: ManifestIssue[];
  /** Замечания: неверные ссылки объяснений и тестов на файлы и строки. */
  warnings: ManifestIssue[];
  /** Файлы с безопасными путями и метаданными. */
  files: GeneratedFileEntry[];
  /** Файлы, отклонённые из-за пути или метаданных; архив с ними не собирается. */
  rejected: RejectedFile[];
};

const HEX64 = /^[0-9a-f]{64}$/;
const LINK_KEYS = [
  "type",
  "kind",
  "link_target",
  "symlink_target",
  "linkname",
  "target",
  "is_symlink",
  "hardlink",
];
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

/**
 * Метаданные, которые превращают запись в ссылку или особый файл. В ZIP файл
 * всегда пишется обычным (0644), но manifest с такими полями — признак
 * попытки подменить файл ссылкой, поэтому запись отклоняется целиком.
 */
function linkLikeReason(entry: Record<string, unknown>): string | null {
  for (const key of LINK_KEYS) {
    if (!(key in entry)) continue;
    const value = entry[key];
    if (key === "type" || key === "kind") {
      if (value === "file" || value === "regular") continue;
      return `тип записи «${String(value)}» вместо обычного файла`;
    }
    if (value === false || value === null || value === undefined) continue;
    return `поле ${key}: запись описывает ссылку`;
  }
  if ("mode" in entry) {
    const mode = entry.mode;
    const numeric = typeof mode === "string" ? Number.parseInt(mode, 8) : mode;
    if (typeof numeric !== "number" || !Number.isInteger(numeric))
      return "поле mode не число";
    if ((numeric & S_IFMT) !== 0 && (numeric & S_IFMT) !== S_IFREG)
      return "mode описывает не обычный файл (ссылку, каталог или устройство)";
    if ((numeric & 0o6000) !== 0) return "mode содержит setuid/setgid";
  }
  return null;
}

export function reviewManifest(manifest: Generation): ManifestReview {
  const fatal: ManifestIssue[] = [],
    warnings: ManifestIssue[] = [],
    rejected: RejectedFile[] = [];
  const accepted: GeneratedFileEntry[] = [];
  if (
    typeof manifest.project_name !== "string" ||
    checkSegment(manifest.project_name) !== null ||
    /[/\\]/.test(manifest.project_name)
  )
    fatal.push({
      path: "project_name",
      message: "Недопустимое имя корневой папки",
    });
  if (!manifest.version_id || !HEX64.test(manifest.spec_hash ?? ""))
    fatal.push({ path: "version_id", message: "Нет привязки к версии модели" });
  if (!Array.isArray(manifest.files))
    return {
      fatal: [...fatal, { path: "files", message: "Нет списка файлов" }],
      warnings,
      files: [],
      rejected,
    };
  for (const [index, entry] of manifest.files.entries()) {
    const raw = entry as unknown as Record<string, unknown>;
    const path = typeof raw.path === "string" ? raw.path : `files[${index}]`;
    const checked = checkArchivePath(raw.path);
    const reason = !checked.ok ? checked.reason : linkLikeReason(raw);
    if (reason) {
      rejected.push({ path, reason });
      continue;
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !HEX64.test(entry.sha256 ?? "")
    ) {
      rejected.push({ path, reason: "Неверные size/sha256" });
      continue;
    }
    if (
      !Array.isArray(entry.elements) ||
      !Array.isArray(entry.requirement_ids)
    ) {
      rejected.push({ path, reason: "Нет связей с моделью" });
      continue;
    }
    if (
      entry.elements.some(
        (e) =>
          !Number.isInteger(e.start_line) ||
          !Number.isInteger(e.end_line) ||
          e.start_line < 1 ||
          e.end_line < e.start_line,
      )
    )
      warnings.push({ path, message: "Неверный диапазон строк элемента" });
    accepted.push(entry);
  }
  const conflicts = findPathConflicts(accepted.map((e) => e.path));
  rejected.push(...conflicts);
  const bad = new Set(conflicts.map((e) => e.path));
  const files = accepted.filter((e) => !bad.has(e.path));
  if (
    manifest.file_count !== manifest.files.length ||
    manifest.total_bytes !== manifest.files.reduce((n, e) => n + e.size, 0)
  )
    fatal.push({
      path: "files",
      message: "Число файлов или общий размер не совпадает с manifest",
    });
  if (manifest.code_hash !== filesDigest(manifest.files))
    fatal.push({
      path: "code_hash",
      message: "Хеш списка файлов не совпадает с code_hash",
    });
  return { fatal, warnings, rejected, files };
}

/** SHA-256 канонического JSON списка {path,size,sha256}, контракт генератора. */
export function filesDigest(
  files: Pick<GeneratedFileEntry, "path" | "size" | "sha256">[],
): string {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalJson(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      ).replace(
        /[\u007f-\uffff]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      ),
    ),
  );
}

export type VersionMatch =
  | { kind: "same" }
  | { kind: "other_version"; generatedFor: number; selected: number }
  | { kind: "hash_mismatch" }
  | { kind: "unknown" };

/** Совпадает ли версия, для которой созданы файлы, с выбранной в рабочей области. */
export function compareWithVersion(
  manifest: Generation,
  selected:
    | Pick<ModelVersion, "id" | "number" | "spec_hash">
    | null
    | undefined,
): VersionMatch {
  if (!selected) return { kind: "unknown" };
  if (manifest.version_id !== selected.id) {
    return {
      kind: "other_version",
      generatedFor: manifest.version_number,
      selected: selected.number,
    };
  }
  if (manifest.spec_hash !== selected.spec_hash)
    return { kind: "hash_mismatch" };
  return { kind: "same" };
}

export type TestsProvenance =
  | { kind: "none" }
  | { kind: "current" }
  | { kind: "stale" };

/** Проверяется вся цепочка generation/version/spec/code, а не только счётчик тестов. */
export function testsProvenance(
  tests: TestRun | null,
  generation: Generation,
): TestsProvenance {
  if (!tests) return { kind: "none" };
  return {
    kind:
      tests.generation_id === generation.generation_id &&
      tests.version_id === generation.version_id &&
      tests.spec_hash === generation.spec_hash &&
      tests.code_hash === generation.code_hash &&
      generation.code_hash === filesDigest(generation.files)
        ? "current"
        : "stale",
  };
}
