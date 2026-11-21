import { useEffect, useState } from "react";
import { ApiError } from "../api/http";
import { isTerminalTestRun, type TestRun } from "./contract";
import { codegenErrorMessage, type CodegenProvider } from "./provider";

export function useRunPolling(
  provider: CodegenProvider,
  run: TestRun | null,
  update: (run: TestRun) => void,
  paused: boolean,
): string | null {
  const id = run?.test_run_id;
  const active = !!run && !isTerminalTestRun(run) && !paused;
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    setProblem(null);
    if (!id || !active) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const next = await provider.getTestRun(id, signal);
        if (signal.aborted) return;
        if (next.test_run_id !== id) {
          setProblem({ id, message: "Сервер вернул другой запуск. Обновите статус вручную." });
          return;
        }
        failures = 0;
        setProblem(null);
        update(next);
        if (!isTerminalTestRun(next)) timer = setTimeout(poll, 1000);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && error.status < 500 && ![408, 429].includes(error.status)) {
          setProblem({ id, message: codegenErrorMessage(error) });
          return;
        }
        failures++;
        if (failures >= 2) setProblem({ id, message: "Связь с сервером прервана. Статус обновится после восстановления." });
        timer = setTimeout(poll, Math.min(1000 * 2 ** failures, 8000));
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [provider, id, active, update]);
  return active && problem && problem.id === id ? problem.message : null;
}
