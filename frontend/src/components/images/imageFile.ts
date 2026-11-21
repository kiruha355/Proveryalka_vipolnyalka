const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
export const IMAGE_ACCEPT = Object.keys(TYPES).map(extension => `.${extension}`).join(",");
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function imageFileError(file: File): string | null {
  const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  const type = extension ? TYPES[extension] : undefined;
  if (!type || (file.type && file.type !== "application/octet-stream" && file.type !== type)) {
    return "Выберите изображение в формате PNG, JPEG или WebP.";
  }
  if (file.size === 0) return "Файл пуст.";
  if (file.size > MAX_IMAGE_BYTES) return "Файл превышает 8 МиБ. Уменьшите его размер и выберите снова.";
  return null;
}
