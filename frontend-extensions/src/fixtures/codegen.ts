import recording from "./codegen-recording.json";
import { ApiError } from "../api/http";
import type { CodegenProvider } from "../files/provider";
import type {
  CodegenStatus,
  Generation,
  TestRun,
  VersionRef,
} from "../files/contract";
export const CODEGEN_RECORDING_PROVENANCE = recording._provenance;
export const RECORDED_GENERATION = recording.generations[0] as Generation;
export const RECORDED_TEST_RUN = recording.test_runs[
  RECORDED_GENERATION.generation_id as keyof typeof recording.test_runs
][0] as TestRun;
export const RECORDED_VERSION = recording.versions[0] as VersionRef & {
  number: number;
};
// Запись использует version DTO (number), сохраняя настоящие идентификаторы.
export const CODEGEN_VERSION: VersionRef = {
  id: RECORDED_GENERATION.version_id,
  model_id: RECORDED_GENERATION.model_id,
  number: RECORDED_GENERATION.version_number,
  spec_hash: RECORDED_GENERATION.spec_hash,
  approved: true,
};
/** Только replay ранее сохранённого backend/TLC/Docker прогона; новые операции запрещены. */
export function createRecordedCodegenProvider(): CodegenProvider {
  const g = RECORDED_GENERATION;
  const check = (id: string) => {
    if (id !== g.generation_id)
      throw new ApiError(404, "NOT_FOUND", "В записи нет такой генерации");
  };
  const readonly = async (): Promise<never> => {
    throw new ApiError(
      409,
      "RECORDING_READ_ONLY",
      "Запись прогона доступна только для чтения",
    );
  };
  return {
    label: "Запись прогона генератора и Docker; не live",
    status: async () => ({
      available: true,
      status: recording.status as CodegenStatus,
    }),
    listGenerations: async (v) =>
      v.model_id === g.model_id && v.number === g.version_number ? [g] : [],
    getGeneration: async (id) => {
      check(id);
      return g;
    },
    readFile: async (id, path) => {
      check(id);
      const f = (
        recording.files[
          g.generation_id as keyof typeof recording.files
        ] as Record<string, string>
      )[path];
      if (f === undefined)
        throw new ApiError(404, "FILE_NOT_FOUND", "Файла нет в записи");
      return {
        bytes: new TextEncoder().encode(f),
        sha256Header: g.files.find((f) => f.path === path)?.sha256 ?? null,
      };
    },
    downloadArchive: async (id) => {
      check(id);
      const a =
        recording.archives[g.generation_id as keyof typeof recording.archives];
      return {
        bytes: Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0)),
        fileName: a.file_name,
        codeHash: a.code_hash,
      };
    },
    listTestRuns: async (id) => {
      check(id);
      return [RECORDED_TEST_RUN];
    },
    getTestRun: async (id) => {
      if (id !== RECORDED_TEST_RUN.test_run_id)
        throw new ApiError(404, "NOT_FOUND", "Запуск не записан");
      return RECORDED_TEST_RUN;
    },
    getTestLog: async (id) => {
      const text = (recording.logs as Record<string, string>)[id];
      if (text === undefined)
        throw new ApiError(404, "LOG_NOT_FOUND", "Журнал не записан");
      return text;
    },
    createGeneration: readonly,
    startTestRun: readonly,
    cancelTestRun: readonly,
  };
}
