/** Additive client module for the frontend integrator. No changes to text SourceRef. */
export interface ImageRegion { x: number; y: number; width: number; height: number }
export interface ImageSource {
  id: string; session_id: string; kind: 'image'; filename: string;
  format: 'png' | 'jpeg' | 'webp'; media_type: 'image/png' | 'image/jpeg' | 'image/webp';
  size_bytes: number; sha256: string; width: number; height: number;
  canonical_media_type: 'image/png'; canonical_sha256: string; canonical_size_bytes: number;
  coordinate_space: 'canonical_pixels';
}
export interface ImageRef {
  kind: 'image_reference'; source_id: string; sha256: string; canonical_sha256: string;
  coordinate_space: 'canonical_pixels'; region: ImageRegion | null;
  scope: 'whole_image' | 'selected_region';
}
export interface ImageAnalysis {
  id: string; source_id: string; provider: 'codex' | 'openai'; description: string;
  requirements: Array<{ id: string; text: string; origin: 'visible' | 'proposal'; source_refs: ImageRef[] }>;
  uncertainties: string[]; source_refs: ImageRef[];
}
export interface ImageAnalysisRecord {
  id: string; source_id: string; state: 'running' | 'completed' | 'failed';
  error_code: string | null; result: ImageAnalysis | null;
}
export class ImageApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}

/** Reuse this module inside the existing client hook; keys must survive retries/remounts.
 * No automatic POST retry. On an interrupted analysis, GET analyses before offering retry.
 * Never feed an img_* id into the text-only /messages source_id endpoint.
 */
export function createImagesClient(base = '') {
  const path = (sid: string, id?: string) =>
    `${base}/api/sessions/${encodeURIComponent(sid)}/images${id ? `/${encodeURIComponent(id)}` : ''}`;
  async function read<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ImageApiError(body?.error?.code ?? 'HTTP_ERROR', response.status,
        body?.error?.message ?? `HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
  return {
    upload(sid: string, file: File, key: string, signal?: AbortSignal): Promise<ImageSource> {
      const body = new FormData(); body.set('file', file);
      // Browser supplies multipart boundary and Content-Length; do not set either manually.
      return read(path(sid), { method: 'POST', headers: { 'Idempotency-Key': key }, body, signal });
    },
    list(sid: string, signal?: AbortSignal): Promise<ImageSource[]> { return read(path(sid), { signal }) },
    metadata(sid: string, id: string, signal?: AbortSignal): Promise<ImageSource> { return read(path(sid, id), { signal }) },
    contentUrl(sid: string, id: string): string { return `${path(sid, id)}/content` },
    analyze(sid: string, id: string, key: string, region: ImageRegion | null = null, signal?: AbortSignal): Promise<ImageAnalysis> {
      return read(`${path(sid, id)}/analysis`, { method: 'POST', signal,
        headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ region }) });
    },
    analyses(sid: string, id: string, signal?: AbortSignal): Promise<ImageAnalysisRecord[]> {
      return read(`${path(sid, id)}/analyses`, { signal });
    },
  };
}
