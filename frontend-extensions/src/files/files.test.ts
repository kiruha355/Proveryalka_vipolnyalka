import { execFileSync } from "node:child_process";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  RECORDED_GENERATION as g,
  RECORDED_TEST_RUN as run,
  CODEGEN_VERSION as version,
  createRecordedCodegenProvider,
} from "../fixtures/codegen";
import type { GeneratedFileEntry, Generation } from "./contract";
import { sha256Hex } from "../util/sha256";
import { checkArchivePath, findPathConflicts } from "./safe-path";
import {
  compareWithVersion,
  filesDigest,
  reviewManifest,
  testsProvenance,
} from "./manifest";
import {
  archiveBlockers,
  buildProjectArchive,
  downloadProjectArchive,
} from "./zip";
import { createCodegenProvider } from "./provider";
function entry(
  path: string,
  extra: Record<string, unknown> = {},
): GeneratedFileEntry {
  return {
    path,
    size: 0,
    sha256: sha256Hex(new Uint8Array()),
    role: "source",
    media_type: "text/plain",
    explanation: "",
    elements: [],
    requirement_ids: [],
    ...extra,
  } as GeneratedFileEntry;
}
function withFiles(files: GeneratedFileEntry[]): Generation {
  return {
    ...g,
    files,
    file_count: files.length,
    total_bytes: files.reduce((n, f) => n + f.size, 0),
    code_hash: filesDigest(files),
  };
}
describe("безопасные пути", () => {
  it.each([
    ["../evil.py", "выводит за пределы"],
    ["app/../../evil.py", "выводит за пределы"],
    ["./app/main.py", "выводит за пределы"],
    ["/etc/passwd", "абсолютный путь"],
    ["C:/Windows/system32/x.dll", "буквой диска"],
    ["c:evil.py", "буквой диска"],
    ["..\\..\\evil.py", "обратная косая черта"],
    ["app\\main.py", "обратная косая черта"],
    ["//server/share/x", "абсолютный путь"],
    ["~/.bashrc", "начинается с ~"],
    ["app//main.py", "пустой сегмент"],
    ["app/", "каталогу вместо файла"],
    ["", "пустой путь"],
    ["app/con.py", "зарезервированное имя"],
    ["NUL", "зарезервированное имя"],
    ["app/main.py.", "оканчивается точкой"],
    ["app/main.py ", "оканчивается точкой или пробелом"],
    ["file.txt:stream", "символы"],
    ["a\u0000b.py", "управляющие символы"],
    ["evil\u202Etxt.py", "смены направления"],
    [".git/hooks/post-checkout", ".git"],
    ["sub/.GIT/config", ".git"],
    ["cafe\u0301.py", "NFC"],
  ])("отклоняет %j", (path, reason) => {
    const result = checkArchivePath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it.each([
    "app/main.py",
    "tests/test_api.py",
    "README.md",
    ".github/workflows/ci.yml",
    "docs/Заявка.md",
    "a/b/c/d.e.f",
  ])("принимает %j", (path) =>
    expect(checkArchivePath(path)).toMatchObject({ ok: true }),
  );

  it("находит дубликаты без учёта регистра и конфликты файла с каталогом", () => {
    expect(
      findPathConflicts([
        "README.md",
        "readme.md",
        "app",
        "app/main.py",
        "x.py",
        "x.py",
      ]),
    ).toEqual([
      {
        path: "readme.md",
        reason: "совпадает с README.md без учёта регистра или нормализации",
      },
      { path: "x.py", reason: "путь повторяется" },
      {
        path: "app/main.py",
        reason: "app — файл, но используется как каталог",
      },
    ]);
  });
});

describe("manifest реального генератора", () => {
  it("проверяет состав, code_hash и provenance записи Docker", () => {
    expect(reviewManifest(g)).toMatchObject({
      fatal: [],
      rejected: [],
      warnings: [],
    });
    expect(filesDigest(g.files)).toBe(g.code_hash);
    expect(testsProvenance(run, g)).toEqual({ kind: "current" });
    expect(compareWithVersion(g, version)).toEqual({ kind: "same" });
    expect(
      compareWithVersion(g, { ...version, id: "other", number: 9 }),
    ).toMatchObject({ kind: "other_version" });
    expect(
      compareWithVersion(g, { ...version, spec_hash: "f".repeat(64) }),
    ).toEqual({ kind: "hash_mismatch" });
  });
  it.each(["generation_id", "version_id", "spec_hash", "code_hash"] as const)(
    "отклоняет тесты с другим %s",
    (key) => {
      expect(testsProvenance({ ...run, [key]: "other" }, g)).toEqual({
        kind: "stale",
      });
    },
  );
  it("не считает изменённый manifest текущим набором", () => {
    expect(
      testsProvenance(run, { ...g, files: [...g.files, entry("extra.py")] }),
    ).toEqual({ kind: "stale" });
  });
  it("отклоняет ссылки и особые файлы", () => {
    const m = withFiles([
      entry("ok.py"),
      entry("link.py", { type: "symlink", link_target: "/etc/passwd" }),
      entry("mode.py", { mode: 0o120777 }),
      entry("mode-string.py", { mode: "120755" }),
      entry("setuid.py", { mode: 0o104755 }),
      entry("regular.py", { mode: 0o100644, type: "file" }),
    ]);
    expect(reviewManifest(m).files.map((f) => f.path)).toEqual([
      "ok.py",
      "regular.py",
    ]);
    expect(reviewManifest(m).rejected).toHaveLength(4);
    expect(archiveBlockers(m)).toHaveLength(4);
  });
  it("отклоняет небезопасный корень, size/hash и дубликаты", () => {
    const m = {
      ...withFiles([
        entry("x.py"),
        entry("X.py"),
        entry("bad.py", { size: -1 }),
        entry("hash.py", { sha256: "invalid" }),
      ]),
      project_name: "../escape",
    };
    expect(reviewManifest(m).fatal.map((f) => f.path)).toContain(
      "project_name",
    );
    expect(reviewManifest(m).rejected).toHaveLength(3);
  });
});
describe("ZIP реального проекта", () => {
  it("проверяет и экспортирует серверный ZIP, совпадающий с manifest", async () => {
    const a = await downloadProjectArchive(createRecordedCodegenProvider(), g);
    const files = unzipSync(a.bytes);
    expect(Object.keys(files)).toHaveLength(g.file_count);
    for (const f of g.files)
      expect(sha256Hex(files[`${g.project_name}/${f.path}`]!)).toBe(f.sha256);
    const python = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import io,sys,zipfile,stat;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None;assert all(stat.S_ISREG(i.external_attr>>16) and stat.S_IMODE(i.external_attr>>16)==0o644 for i in z.infolist());print(len(z.infolist()))",
      ],
      { input: a.bytes },
    ).toString();
    expect(Number(python)).toBe(g.file_count);
  });
  it("проверяет каждый файл при локальной сборке", async () => {
    const p = createRecordedCodegenProvider();
    expect((await buildProjectArchive(p, g.generation_id, g)).files).toBe(
      g.file_count,
    );
    p.readFile = async () => ({
      bytes: new Uint8Array([1, 2]),
      sha256Header: null,
    });
    await expect(buildProjectArchive(p, g.generation_id, g)).rejects.toThrow(
      /не совпадает/,
    );
  });
  it("отклоняет подмену, лишние записи и symlink в ZIP", async () => {
    const p = createRecordedCodegenProvider();
    const raw = await p.downloadArchive(g.generation_id);
    const entries = unzipSync(raw.bytes);
    entries[`${g.project_name}/../evil.py`] = new Uint8Array();
    p.downloadArchive = async () => ({ ...raw, bytes: zipSync(entries) });
    await expect(downloadProjectArchive(p, g)).rejects.toThrow();
    delete entries[`${g.project_name}/../evil.py`];
    const first = Object.keys(entries)[0]!;
    p.downloadArchive = async () => ({
      ...raw,
      bytes: zipSync({
        ...entries,
        [first]: [entries[first]!, { os: 3, attrs: (0o120777 << 16) >>> 0 }],
      }),
    });
    await expect(downloadProjectArchive(p, g)).rejects.toThrow(/Небезопасная/);
    p.downloadArchive = async () => ({ ...raw, codeHash: "bad" });
    await expect(downloadProjectArchive(p, g)).rejects.toThrow(/X-Code-Hash/);
  });
});
describe("real HTTP adapter", () => {
  it("кодирует path/id, передаёт ключи, сохраняет структурную ошибку 409", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({
            error: {
              code: "VERIFICATION_REQUIRED",
              message: "Подтвердите",
              details: [{ property_id: "R", status: null, check_run_id: null }],
            },
          }),
          { status: 409 },
        );
      return new Response("body", { headers: { "X-Content-SHA256": "abc" } });
    });
    const p = createCodegenProvider({
      baseUrl: "http://localhost:8000/",
      fetch: mock as typeof fetch,
    });
    await p.readFile("gen #1", "docs/Заявка #1.md");
    expect(calls[0]![0]).toContain(
      "/api/generations/gen%20%231/files/docs/%D0%97%D0%B0%D1%8F%D0%B2%D0%BA%D0%B0%20%231.md",
    );
    await expect(
      p.createGeneration(version, { allowUnverified: true }, "key"),
    ).rejects.toMatchObject({
      code: "VERIFICATION_REQUIRED",
      details: [{ property_id: "R", status: null, check_run_id: null }],
    });
    expect(calls[1]![1]).toMatchObject({
      headers: { "Idempotency-Key": "key" },
      body: JSON.stringify({ allow_unverified: true }),
    });
    await expect(p.readFile("g", "../x")).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("не маскирует 503 под пустой список и называет отсутствующий router", async () => {
    const p = createCodegenProvider({
      fetch: vi.fn(
        async () => new Response("", { status: 404 }),
      ) as typeof fetch,
    });
    expect(await p.status()).toMatchObject({
      available: false,
      reason: expect.stringContaining("/api/codegen/status"),
    });
    const q = createCodegenProvider({
      fetch: vi.fn(
        async () => new Response("", { status: 503 }),
      ) as typeof fetch,
    });
    await expect(q.listGenerations(version)).rejects.toMatchObject({
      status: 503,
    });
  });
});
it("filesDigest совпадает с Python ensure_ascii для Unicode paths", () => {
  const files = [entry("docs/Заявка.md")];
  const expected = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest())",
    ],
    {
      input: JSON.stringify(
        files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      ),
      encoding: "utf8",
    },
  ).trim();
  expect(filesDigest(files)).toBe(expected);
});
