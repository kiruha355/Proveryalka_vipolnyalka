import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Демо-страница для визуальной проверки компонентов на примерах данных.
// DEMO_PAGE=graph|files — каждая страница собирается отдельно без общих чанков.
const page = process.env.DEMO_PAGE ?? "graph";

export default defineConfig({
  plugins: [react()],
  root: "demo",
  json: { stringify: false },
  base: "./",
  build: {
    outDir: `../demo-dist/${page}`,
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 2000,
    target: "esnext",
    cssMinify: true,
    rollupOptions: { input: resolve(import.meta.dirname, `demo/${page}.html`) },
  },
});
