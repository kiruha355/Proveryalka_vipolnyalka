// Встраивает скрипт и стили собранной демо-страницы в один HTML-файл,
// чтобы страницу можно было открыть или показать без сервера.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = new URL("../demo-dist/", import.meta.url).pathname;

// Демо не использует минимапу, стандартные контролы, ресайзер и тулбар React Flow:
// их правила убираются только из встроенной страницы, чтобы она помещалась в предпросмотр.
const UNUSED = /react-flow__(minimap|controls|resize-control|node-toolbar|selection|nodesselection)/;
function trimUnused(css) {
  return css.replace(/[^{}]+\{[^{}]*\}/g, (rule) => (UNUSED.test(rule.split("{")[0]) ? "" : rule));
}

for (const page of ["graph", "files"]) {
  const dir = join(root, page);
  const source = join(dir, `${page}.html`);
  if (!existsSync(source)) continue;
  const read = (relative) => readFileSync(join(dir, relative.replace(/^\.\//, "")), "utf8");
  let html = readFileSync(source, "utf8");
  if (/rel="modulepreload"/.test(html)) throw new Error(`${page}: страница собрана с общими чанками`);
  html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>${trimUnused(read(href))}</style>`);
  html = html.replace(
    /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,
    (_, src) => `<script type="module">${read(src).replace(/<\/script/g, "<\\/script")}</script>`,
  );
  if (html.length > 480000) {
    html = html.replace(/<script type="module">([\s\S]*?)<\/script>/g, (_, script) => {
      const packed = gzipSync(script).toString("base64");
      return `<script type="module">const packed=Uint8Array.from(atob("${packed}"),c=>c.charCodeAt(0));const source=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))).text();const s=document.createElement("script");s.type="module";s.textContent=source;document.head.append(s);</script>`;
    });
  }
  writeFileSync(join(root, `${page}.html`), html);
  console.log(`demo-dist/${page}.html: ${html.length} символов`);
}
