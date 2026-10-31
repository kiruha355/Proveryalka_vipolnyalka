import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom не реализует ResizeObserver и DOMMatrixReadOnly, которые использует React Flow.
class ResizeObserverStub {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: 800, height: 500 },
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}
(globalThis as Record<string, unknown>).DOMMatrixReadOnly ??=
  DOMMatrixReadOnlyStub;

Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: {
    configurable: true,
    get() {
      return Number.parseFloat((this as HTMLElement).style.height) || 48;
    },
  },
  offsetWidth: {
    configurable: true,
    get() {
      return Number.parseFloat((this as HTMLElement).style.width) || 140;
    },
  },
});
(
  globalThis.SVGElement.prototype as unknown as { getBBox: () => DOMRect }
).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
