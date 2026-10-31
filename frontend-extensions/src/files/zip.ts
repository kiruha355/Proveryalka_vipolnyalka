import { zipSync } from "fflate";
import type { Zippable } from "fflate";
import { sha256Hex } from "../util/sha256";
import type { Generation } from "./contract";
import { reviewManifest } from "./manifest";
import type { CodegenProvider } from "./provider";
import { checkArchivePath } from "./safe-path";

export class ArchiveRefused extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[]) {
    super(message);
    this.name = "ArchiveRefused";
    this.problems = problems;
  }
}

/** Почему архив сейчас собрать нельзя; пустой список — можно. */
export function archiveBlockers(manifest: Generation): string[] {
  const review = reviewManifest(manifest);
  const problems = [
    ...review.fatal.map((issue) => `${issue.path}: ${issue.message}`),
    ...review.rejected.map((file) => `${file.path}: ${file.reason}`),
  ];
  if (manifest.total_bytes > 32 * 1024 * 1024 || manifest.file_count > 10000)
    problems.push("Проект превышает предел экспорта 32 МиБ / 10000 файлов");
  if (review.files.length === 0) problems.push("В проекте нет файлов");
  return problems;
}

const REGULAR_FILE_ATTRS = (0o100644 << 16) >>> 0;
const DOS_EPOCH = new Date("1980-01-01T00:00:00Z");

/**
 * Время записей ZIP (DOS time хранится без часового пояса): поля даты берутся
 * из UTC created_at, чтобы архив не зависел от часового пояса браузера.
 */
function archiveTime(createdAt: string): Date {
  const parsed = new Date(createdAt);
  const date =
    Number.isNaN(parsed.getTime()) || parsed < DOS_EPOCH ? DOS_EPOCH : parsed;
  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );
}

/**
 * Собирает ZIP из файлов manifest. Каждый файл читается из источника и
 * сверяется с size и sha256 из manifest; любое расхождение отменяет архив.
 * Все записи — обычные файлы 0644 под одной корневой папкой, с одним временем
 * изменения из manifest: одинаковые manifest и файлы дают одинаковый архив.
 */
export async function buildProjectArchive(
  provider: CodegenProvider,
  generationId: string,
  manifest: Generation,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; fileName: string; files: number }> {
  const blockers = archiveBlockers(manifest);
  if (blockers.length > 0)
    throw new ArchiveRefused("Архив не собран", blockers);
  const review = reviewManifest(manifest);
  const mtime = archiveTime(manifest.created_at);
  const entries: Zippable = Object.create(null);
  const mismatched: string[] = [];
  for (const file of review.files) {
    const check = checkArchivePath(file.path);
    if (!check.ok)
      throw new ArchiveRefused("Архив не собран", [
        `${file.path}: ${check.reason}`,
      ]);
    const { bytes } = await provider.readFile(generationId, file.path, signal);
    if (bytes.length !== file.size)
      mismatched.push(
        `${file.path}: размер ${bytes.length}, в manifest ${file.size}`,
      );
    else if (sha256Hex(bytes) !== file.sha256)
      mismatched.push(`${file.path}: sha256 не совпадает с manifest`);
    entries[`${manifest.project_name}/${file.path}`] = [
      bytes,
      { mtime, os: 3, attrs: REGULAR_FILE_ATTRS },
    ];
  }
  if (mismatched.length > 0)
    throw new ArchiveRefused(
      "Содержимое файлов не совпадает с manifest",
      mismatched,
    );
  const bytes = zipSync(entries, { level: 6, mtime });
  return {
    bytes,
    fileName: `${manifest.project_name}-v${manifest.version_number}.zip`,
    files: review.files.length,
  };
}

/** Сохранение файла в браузере без сторонних библиотек. */
export function saveBytes(
  bytes: Uint8Array,
  fileName: string,
  type = "application/zip",
): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Проверяет ZIP сервера до распаковки: размеры, обычные файлы, точный manifest. */
export async function downloadProjectArchive(
  provider: CodegenProvider,
  generation: Generation,
) {
  const problems = archiveBlockers(generation);
  if (problems.length) throw new ArchiveRefused("Архив недоступен", problems);
  const archive = await provider.downloadArchive(generation.generation_id);
  if (archive.codeHash !== null && archive.codeHash !== generation.code_hash)
    throw new Error("X-Code-Hash не совпадает с генерацией");
  const bytes = archive.bytes;
  if (
    bytes.length > 32 * 1024 * 1024 ||
    generation.total_bytes > 32 * 1024 * 1024
  )
    throw new Error("Архив превышает предел просмотра 32 МиБ");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(end, true) !== 0x06054b50
  )
    end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50)
    throw new Error("Неверный ZIP");
  const count = view.getUint16(end + 10, true),
    offset = view.getUint32(end + 16, true);
  if (
    count !== generation.files.length ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true)
  )
    throw new Error("Неверный состав ZIP");
  let at = offset,
    total = 0;
  const expected = new Map(
    generation.files.map((f) => [`${generation.project_name}/${f.path}`, f]),
  );
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      throw new Error("Неверный каталог ZIP");
    const length = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true);
    if (at + 46 + length + extra + comment > end)
      throw new Error("Неверный каталог ZIP");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(at + 46, at + 46 + length),
    );
    const mode = view.getUint32(at + 38, true) >>> 16,
      size = view.getUint32(at + 24, true);
    const file = expected.get(name);
    if (
      !checkArchivePath(name).ok ||
      !file ||
      names.has(name) ||
      size !== file.size ||
      ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000) ||
      mode & 0o6000
    )
      throw new Error("Небезопасная запись ZIP или расхождение с manifest");
    total += size;
    names.add(name);
    at += 46 + length + extra + comment;
  }
  if (
    total !== generation.total_bytes ||
    at !== offset + view.getUint32(end + 12, true)
  )
    throw new Error("Размер ZIP не совпадает с manifest");
  const { unzipSync } = await import("fflate");
  // Фильтр ограничивает распаковку также при расхождении local и central headers.
  const extracted = unzipSync(bytes, {
    filter: (f) => {
      const expectedFile = expected.get(f.name);
      if (!expectedFile || f.originalSize !== expectedFile.size)
        throw new Error("Локальная запись ZIP расходится с manifest");
      return true;
    },
  });
  if (Object.keys(extracted).length !== count) throw new Error("Неполный ZIP");
  for (const [name, file] of expected) {
    const data = extracted[name];
    if (!data || data.length !== file.size || sha256Hex(data) !== file.sha256)
      throw new Error(`Файл ${name} не совпадает с manifest`);
  }
  // Пересобираем только проверенные байты с обычными правами 0644.
  const clean: Zippable = Object.create(null);
  for (const [name, data] of Object.entries(extracted))
    clean[name] = [
      data,
      {
        os: 3,
        attrs: REGULAR_FILE_ATTRS,
        mtime: archiveTime(generation.created_at),
      },
    ];
  return {
    bytes: zipSync(clean),
    fileName: `${generation.project_name}-${generation.generation_id.replace(/[^a-zA-Z0-9_-]/g, "_")}.zip`,
  };
}
