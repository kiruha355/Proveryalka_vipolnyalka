import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProveryalkaApi } from "../../api/api";
import type { ImageProvenance } from "../../api/images";
import type { SourceRef } from "../../api/types";
import { ImageCanvas } from "./ImageCanvas";
import { ImageDialog } from "./ImageDialog";

type Location = Pick<SourceRef, "source_id" | "start" | "end">;
const CitationContext = createContext<{
  load(ref: Location): Promise<ImageProvenance | null> | undefined;
  open(image: ImageProvenance): void;
} | null>(null);

export function ImageCitationProvider({ api, sessionId, linkedIds, children }: {
  api: ProveryalkaApi; sessionId: string; linkedIds?: string[]; children: ReactNode;
}) {
  const [open, setOpen] = useState<ImageProvenance | null>(null);
  const pending = useMemo(() => new Map<string, Promise<ImageProvenance | null>>(), [api, sessionId]);
  const context = useMemo(() => {
    const linked = new Set(linkedIds);
    return {
      load(ref: Location) {
        if (!linked.has(ref.source_id) || !api.getImageContentUrl || !api.getImageProvenance) return;
        const cached = pending.get(ref.source_id);
        if (cached) return cached;
        const request = api.getImageProvenance(sessionId, ref);
        pending.set(ref.source_id, request);
        void request.catch(() => pending.delete(ref.source_id));
        return request;
      },
      open: setOpen,
    };
  }, [api, linkedIds, pending, sessionId]);
  const url = open && api.getImageContentUrl?.(sessionId, open.image_source_id);
  return <CitationContext.Provider value={context}>
    {children}
    {open && url && <ImageDialog title={open.filename} onClose={() => setOpen(null)}>
      <ImageCanvas key={open.image_source_id} src={url} filename={open.filename} width={open.width} height={open.height}
        region={open.region} highlightWhole />
    </ImageDialog>}
  </CitationContext.Provider>;
}

function ImageSourceButton({ location, children, fallback }: {
  location: Location; children(image: ImageProvenance): ReactNode; fallback?: ReactNode;
}) {
  const context = useContext(CitationContext);
  const { source_id, start, end } = location;
  const [resolved, setResolved] = useState<{ sourceId: string; image: ImageProvenance } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    context?.load({ source_id, start, end })?.then(
      image => { if (current) setResolved(image ? { sourceId: source_id, image } : null); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [context, end, retry, source_id, start]);
  const image = resolved?.sourceId === source_id ? resolved.image : null;
  if (image && context) return (
    <button type="button" className="link-button" title={`Открыть изображение ${image.filename}`} onClick={() => context.open(image)}>
      {children(image)}
    </button>
  );
  return <>{fallback}{failed && <button type="button" className="link-button small" onClick={() => setRetry(value => value + 1)}>
    Повторить загрузку ссылки
  </button>}</>;
}

export function ImageQuote({ citation, fallback }: { citation: SourceRef; fallback?: ReactNode }) {
  return <ImageSourceButton location={citation} fallback={fallback ?? <q>{citation.quote}</q>}>
    {() => <q>{citation.quote}</q>}
  </ImageSourceButton>;
}

export function ImageSourceLink({ sourceId, fallback }: { sourceId: string; fallback?: ReactNode }) {
  return <ImageSourceButton location={{ source_id: sourceId, start: 0, end: 1 }} fallback={fallback}>
    {image => image.filename}
  </ImageSourceButton>;
}
