export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageSource {
  id: string;
  session_id: string;
  filename: string;
  width: number;
  height: number;
}

export interface ImageAnalysis {
  id: string;
  source_id: string;
  description: string;
  requirements: { id: string; text: string; origin: "visible" | "proposal" }[];
  uncertainties: string[];
  source_refs: [{ region: ImageRegion | null }, ...{ region: ImageRegion | null }[]];
}

export interface ImageAnalysisRecord {
  id: string;
  source_id: string;
  state: "running" | "completed" | "failed";
  error_code: string | null;
  result: ImageAnalysis | null;
}

export interface ImageProvenance {
  kind: "image";
  filename: string;
  image_source_id: string;
  analysis_id: string;
  width: number;
  height: number;
  region: ImageRegion | null;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const positive = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const coordinate = (v: unknown): v is number => v === 0 || positive(v);
const region = (v: unknown): v is ImageRegion | null => v === null ||
  (object(v) && coordinate(v.x) && coordinate(v.y) && positive(v.width) && positive(v.height));

export function isImageSource(v: unknown): v is ImageSource {
  return object(v) && string(v.id) && string(v.session_id) && string(v.filename) && positive(v.width) && positive(v.height);
}

export function isImageAnalysis(v: unknown): v is ImageAnalysis {
  return object(v) && string(v.id) && string(v.source_id) && string(v.description) &&
    Array.isArray(v.requirements) && v.requirements.every(item =>
      object(item) && string(item.id) && string(item.text) && (item.origin === "visible" || item.origin === "proposal")) &&
    Array.isArray(v.uncertainties) && v.uncertainties.every(string) &&
    Array.isArray(v.source_refs) && v.source_refs.length > 0 && v.source_refs.every(ref => object(ref) && region(ref.region));
}

export function isImageAnalysisRecord(v: unknown): v is ImageAnalysisRecord {
  return object(v) && string(v.id) && string(v.source_id) && (v.error_code === null || string(v.error_code)) &&
    (v.state === "completed" ? isImageAnalysis(v.result) && v.result.id === v.id && v.result.source_id === v.source_id
      : (v.state === "running" || v.state === "failed") && v.result === null);
}

export function isImageProvenance(v: unknown): v is ImageProvenance {
  return object(v) && v.kind === "image" && string(v.image_source_id) && string(v.analysis_id) &&
    string(v.filename) && positive(v.width) && positive(v.height) && region(v.region) &&
    (!v.region || (v.region.x + v.region.width <= v.width && v.region.y + v.region.height <= v.height));
}
