import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The backend has no CORS middleware; the dev server proxies API paths to it.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.PROVERYALKA_API_TARGET || "http://127.0.0.1:8000";
  const proxied = { target, changeOrigin: false };
  return {
    plugins: [react()],
    resolve: {
      alias: { "@proveryalka/ui": here("./src/public.ts") },
      // Extensions outside frontend/ must share this React instance.
      dedupe: ["react", "react-dom"],
    },
    server: {
      fs: { allow: [here("."), here("../frontend-extensions")] },
      port: Number(env.PROVERYALKA_UI_PORT || 5173),
      strictPort: false,
      proxy: { "/api": proxied, "/health": proxied, "/ready": proxied, "/openapi.json": proxied },
    },
    preview: { proxy: { "/api": proxied, "/health": proxied, "/ready": proxied, "/openapi.json": proxied } },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});
