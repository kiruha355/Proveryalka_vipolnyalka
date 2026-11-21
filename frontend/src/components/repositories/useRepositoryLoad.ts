import { useEffect, useState } from "react";
import { isAbort } from "../../api/errors";

export function useRepositoryLoad<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null, loading: true });
    void load(controller.signal).then(
      data => { if (!controller.signal.aborted) setState({ data, error: null, loading: false }); },
      error => { if (!controller.signal.aborted && !isAbort(error)) setState({ data: null, error, loading: false }); },
    );
    return () => controller.abort();
  }, [load, revision]);
  return { ...state, reload: () => setRevision(count => count + 1) };
}
