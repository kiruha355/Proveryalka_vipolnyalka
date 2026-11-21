import { useEffect, useRef, useState } from "react";
import { newKey, type ProveryalkaApi } from "../../api/api";
import { ApiError, describeCode, requiresSignIn } from "../../api/errors";
import type { ImageAnalysisRecord, ImageRegion, ImageSource } from "../../api/images";
import { loadLocal, updateLocal } from "../../state/persist";
import { ErrorNotice, QuietStatus } from "../Notice";
import { ImageCanvas } from "./ImageCanvas";
import { ImageDialog } from "./ImageDialog";

export function useSessionImages(api: ProveryalkaApi, sessionId: string, enabled: boolean) {
  const [images, setImages] = useState<ImageSource[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState(() => loadLocal(api, sessionId).openImageId ?? null);
  const analysisKeys = useRef(new Map<string, string>());

  useEffect(() => {
    if (!enabled || !api.listImages) return;
    const controller = new AbortController();
    setError(null);
    api.listImages(sessionId, controller.signal).then(
      data => {
        if (controller.signal.aborted) return;
        setImages(current => [...data, ...current.filter(image => !data.some(saved => saved.id === image.id))]);
      },
      failure => { if (!controller.signal.aborted) setError(failure); },
    );
    return () => controller.abort();
  }, [api, enabled, reload, sessionId]);

  const select = (id: string | null) => {
    setSelectedId(id);
    updateLocal(api, sessionId, local => ({ ...local, openImageId: id }));
  };

  const upload = enabled && api.uploadImage ? async (file: File, key: string) => {
    const image = await api.uploadImage!(sessionId, file, key);
    setImages(current => [...current.filter(saved => saved.id !== image.id), image]);
    select(image.id);
  } : undefined;

  return { images, selectedId, select, upload, error, analysisKeys: analysisKeys.current, retry: () => setReload(current => current + 1) };
}

interface LibraryProps {
  api: ProveryalkaApi;
  sessionId: string;
  library: ReturnType<typeof useSessionImages>;
  blocked: boolean;
  onUse(image: ImageSource, analysisId: string): void;
}

export function SessionImages({ api, sessionId, library, blocked, onUse }: LibraryProps) {
  const selected = library.images.find(image => image.id === library.selectedId);
  return (
    <>
      {library.error !== null && <ErrorNotice error={library.error} title="Изображения не загружены"
        action={<button type="button" className="button button--small" onClick={library.retry}>Повторить</button>} />}
      {library.images.length > 0 && (
        <div className="image-library">
          <button type="button" className="button button--small button--ghost"
            onClick={() => library.select(library.images[0]!.id)}>Изображения ({library.images.length})</button>
        </div>
      )}
      {selected && (
        <ImageDialog title={selected.filename} onClose={() => library.select(null)}>
          {library.images.length > 1 && <select aria-label="Изображения сессии" value={selected.id}
            onChange={event => library.select(event.target.value)}>
            {library.images.map(image => <option key={image.id} value={image.id}>{image.filename}</option>)}
          </select>}
          <ImageAnalyses key={selected.id} api={api} sessionId={sessionId} image={selected} blocked={blocked}
            analysisKeys={library.analysisKeys}
            onUse={id => { library.select(null); onUse(selected, id); }} />
        </ImageDialog>
      )}
    </>
  );
}

function ImageAnalyses({ api, sessionId, image, blocked, analysisKeys, onUse }: {
  api: ProveryalkaApi; sessionId: string; image: ImageSource; blocked: boolean; onUse(id: string): void;
  analysisKeys: Map<string, string>;
}) {
  const [drawing, setDrawing] = useState(false);
  const [region, setRegion] = useState<ImageRegion | null>(null);
  const [marked, setMarked] = useState<ImageRegion | null>(null);
  const [records, setRecords] = useState<ImageAnalysisRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<unknown>(null);
  const [analysisError, setAnalysisError] = useState<{ error: unknown; region: ImageRegion | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!api.listImageAnalyses) return;
    const controller = new AbortController();
    setLoading(true);
    setReadError(null);
    api.listImageAnalyses(sessionId, image.id, controller.signal).then(
      data => {
        if (controller.signal.aborted) return;
        setRecords(current => {
          const completed = new Map(current.filter(item => item.state === "completed").map(item => [item.id, item]));
          return [...data.map(item => completed.get(item.id) ?? item),
            ...current.filter(item => !data.some(saved => saved.id === item.id))];
        });
        setLoading(false);
      },
      error => { if (!controller.signal.aborted) { setReadError(error); setLoading(false); } },
    );
    return () => controller.abort();
  }, [api, image.id, reload, sessionId]);

  const analyze = async (area: ImageRegion | null) => {
    if (!api.analyzeImage || busy) return;
    const scope = JSON.stringify([image.id, area && [area.x, area.y, area.width, area.height]]);
    const key = analysisKeys.get(scope) ?? newKey();
    analysisKeys.set(scope, key);
    setBusy(true);
    setAnalysisError(null);
    setMarked(area);
    try {
      const result = await api.analyzeImage(sessionId, image.id, area, key);
      setRecords(current => [...current.filter(record => record.id !== result.id), {
        id: result.id, source_id: image.id, result, error_code: null, state: "completed",
      }]);
      if (analysisKeys.get(scope) === key) analysisKeys.delete(scope);
    } catch (error) {
      setAnalysisError({ error, region: area });
      if (!(error instanceof ApiError && (requiresSignIn(error) || error.kind === "network" || error.kind === "malformed"
        || error.code === "IMAGE_ANALYSIS_RUNNING" || error.code === "IMAGE_ANALYSIS_BUSY"))) {
        if (analysisKeys.get(scope) === key) analysisKeys.delete(scope);
      }
    } finally {
      setBusy(false);
      setReload(current => current + 1);
    }
  };

  const contentUrl = api.getImageContentUrl?.(sessionId, image.id);
  return (
    <>
      {contentUrl && <ImageCanvas src={contentUrl} filename={image.filename} width={image.width} height={image.height}
        region={drawing ? region : marked} onSelect={drawing && !busy ? setRegion : undefined} />}
      <div className="image-actions">
        <button type="button" className="button button--small" disabled={busy}
          onClick={() => { setDrawing(false); void analyze(null); }}>Анализировать всё изображение</button>
        <button type="button" className="button button--small" disabled={busy} aria-pressed={drawing}
          onClick={() => setDrawing(value => !value)}>Выделить область</button>
        {drawing && <button type="button" className="button button--small button--primary" disabled={busy || !region}
          onClick={() => { if (region) void analyze(region); }}>Анализировать область</button>}
      </div>
      {busy && <QuietStatus busy>Разбор изображения</QuietStatus>}
      {analysisError !== null && <ErrorNotice error={analysisError.error} title="Не удалось разобрать изображение"
        action={<button type="button" className="button button--small" disabled={busy} onClick={() => {
          setDrawing(false);
          void analyze(analysisError.region);
        }}>Повторить разбор</button>} />}
      {readError !== null && <ErrorNotice error={readError} title="Разборы не загружены"
        action={<button type="button" className="button button--small" onClick={() => setReload(value => value + 1)}>Повторить</button>} />}
      {loading && records.length === 0 && !busy && <QuietStatus busy>Загрузка разборов</QuietStatus>}
      {!busy && records.some(record => record.state === "running") && (
        <div className="image-actions">
          <QuietStatus>Разбор ещё выполняется</QuietStatus>
          <button type="button" className="link-button" disabled={loading} onClick={() => setReload(value => value + 1)}>Обновить разборы</button>
        </div>
      )}
      <ul className="image-saved-analyses">
        {[...records].reverse().map(record => {
          const result = record.result;
          if (!result) return record.state === "failed" && <li key={record.id} className="warn-text">
            {describeCode(record.error_code) ?? "Один из разборов не завершён."}
          </li>;
          const savedRegion = result.source_refs[0].region;
          return <li key={result.id} className="image-results">
            <h3><button type="button" className="link-button" disabled={busy}
              onClick={() => { setDrawing(false); setMarked(savedRegion); }}>
              {savedRegion ? `Область ${savedRegion.x}, ${savedRegion.y} · ${savedRegion.width} × ${savedRegion.height} пкс` : "Всё изображение"}
            </button></h3>
            <p>{result.description}</p>
            {result.requirements.length > 0 && <ul>
              {result.requirements.map(item => <li key={item.id}>
                {item.origin === "proposal" && <strong>Предположение. </strong>}{item.text}
              </li>)}
            </ul>}
            {result.uncertainties.length > 0 && <div className="image-results__uncertainties">
              <strong>Неуверенно распознано</strong>
              <ul>{result.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>}
            <button type="button" className="button button--small" disabled={blocked || busy} onClick={() => onUse(result.id)}>
              Использовать в диалоге
            </button>
          </li>;
        })}
      </ul>
    </>
  );
}
