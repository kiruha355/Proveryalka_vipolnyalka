import { useRef, useState, type PointerEvent } from "react";
import type { ImageRegion } from "../../api/images";

interface Point { x: number; y: number }
interface Props {
  src: string;
  filename: string;
  width: number;
  height: number;
  region: ImageRegion | null;
  onSelect?(region: ImageRegion): void;
  highlightWhole?: boolean;
}

export function ImageCanvas({ src, filename, width, height, region, onSelect, highlightWhole }: Props) {
  const drag = useRef<{ id: number; start: Point } | null>(null);
  const [preview, setPreview] = useState<ImageRegion | null>(null);
  const [failed, setFailed] = useState(false);
  const full = { x: 0, y: 0, width, height };
  const marked = preview ?? region ?? (highlightWhole ? full : null);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(width, Math.max(0, (event.clientX - rect.left) * width / rect.width)),
      y: Math.min(height, Math.max(0, (event.clientY - rect.top) * height / rect.height)),
    };
  };

  const selection = (start: Point, end: Point) => {
    if (start.x === end.x || start.y === end.y) return null;
    const x = Math.floor(Math.min(start.x, end.x));
    const y = Math.floor(Math.min(start.y, end.y));
    return { x, y, width: Math.ceil(Math.max(start.x, end.x)) - x, height: Math.ceil(Math.max(start.y, end.y)) - y };
  };

  return failed ? <p role="alert" className="warn-text">Не удалось открыть изображение {filename}.</p> : (
    <div className="image-canvas-wrap">
      <div className={`image-canvas${onSelect ? " image-canvas--select" : ""}`}
        role="group" aria-label={onSelect ? "Выбор прямоугольной области" : "Исходное изображение"}
        style={{ width: `min(100%, ${width}px, ${52 * width / height}dvh)`, aspectRatio: `${width} / ${height}` }}
        onPointerDown={event => {
          if (!onSelect || drag.current || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, start: point(event) };
          setPreview(null);
        }}
        onPointerMove={event => {
          if (drag.current?.id === event.pointerId) setPreview(selection(drag.current.start, point(event)));
        }}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          const next = selection(drag.current.start, point(event));
          drag.current = null;
          setPreview(null);
          if (next) onSelect?.(next);
        }}
        onLostPointerCapture={event => {
          if (drag.current?.id !== event.pointerId) return;
          drag.current = null;
          setPreview(null);
        }}>
        <img src={src} alt={filename} draggable={false} onError={() => setFailed(true)} />
        {marked && <span className="image-canvas__region" role="img"
          aria-label={region === null && highlightWhole ? "Всё изображение" : "Выделенная область"}
          style={{ left: `${100 * marked.x / width}%`, top: `${100 * marked.y / height}%`,
            width: `${100 * marked.width / width}%`, height: `${100 * marked.height / height}%` }} />}
      </div>
    </div>
  );
}
