"""Статический снимок демо-страниц для предпросмотра.

DOM после рендера в headless Chromium (временный профиль, file://, без сервера),
без скриптов, с CSS только для использованных классов. Страницы graph и files
объединяются в один документ; раскладка считается на ширине 1000px и
уменьшается под кадр 728px.

Запуск: python3 -I scripts/snapshot-demo.py <путь-к-chrome-headless-shell>
"""
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent / "demo-dist"
WIDTH = 1000
FRAME = 728


def block_end(css, start):
    depth, j = 1, start + 1
    while depth:
        depth += {"{": 1, "}": -1}.get(css[j], 0)
        j += 1
    return j


def prune(css, classes):
    out, i = [], 0
    while i < len(css):
        if css[i] == "@":
            brace = css.find("{", i)
            semicolon = css.find(";", i)
            if semicolon != -1 and (brace == -1 or semicolon < brace):
                i = semicolon + 1
                continue
            end = block_end(css, brace)
            # Раскладка снимка зафиксирована на WIDTH; @media сработали бы по ширине кадра.
            if css.startswith("@supports", i):
                inner = prune(css[brace + 1:end - 1], classes)
                if inner.strip():
                    out.append(css[i:brace + 1] + inner + "}")
            # @keyframes и прочие at-правила в статическом снимке не нужны.
            i = end
            continue
        brace = css.find("{", i)
        if brace < 0:
            break
        end = css.index("}", brace)
        keep = [
            s for s in css[i:brace].split(",")
            if s.strip()
            and all(n in classes for n in re.findall(r"\.([A-Za-z0-9_-]+)", s))
            # Состояния наведения и фокуса в статическом снимке не возникают.
            and not re.search(r":(hover|focus|focus-visible|focus-within|active)\b", s)
        ]
        if keep:
            out.append(",".join(keep) + css[brace:end + 1])
        i = end + 1
    return "".join(out)


def dump(chrome, profile, page):
    return subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--no-first-run", f"--user-data-dir={profile}",
         f"--window-size={WIDTH},2200", "--virtual-time-budget=4000", "--dump-dom", (ROOT / f"{page}.html").as_uri()],
        capture_output=True, text=True, check=True,
    ).stdout


def main():
    chrome = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix="pv-dom-") as profile:
        pages = [dump(chrome, profile, page) for page in ["graph", "files"]]
    css = re.search(r"<style>(.*?)</style>", pages[0], flags=re.S).group(1)
    bodies = []
    for html in pages:
        root = re.search(r'<div id="root">(.*)</div>\s*</body>', html, flags=re.S).group(1)
        root = re.sub(r"<script\b[^>]*>.*?</script>", "", root, flags=re.S)
        bodies.append(root)
    # Сцена «без генератора» не нужна в общем снимке: её покрывают тесты.
    bodies[1] = re.sub(r'<section class="demo__frame demo__frame--short">.*?</section>', "", bodies[1], flags=re.S)
    content = "".join(bodies)
    # Заголовки демо-сцен не нужны в кадре предпросмотра.
    content = re.sub(r'<h2 class="demo__title">.*?</h2>', "", content)
    # Снимок только для показа: невидимые точки соединения React Flow и служебные
    # атрибуты (доступность, тестовые метки) в картинке не участвуют.
    content = re.sub(r'<div data-handleid="[^"]*"[^>]*></div>', "", content)
    content = re.sub(r'\s(?:aria-(?!pressed)[a-z]+|data-[a-z-]+|title|role|tabindex|focusable)="[^"]*"', "", content)
    content = re.sub(r'<div id="react-flow__(?:node|edge)-desc-\d+"[^>]*>.*?</div>', "", content)
    content = re.sub(r'<div id="react-flow__aria-live-\d+"[^>]*></div>', "", content)
    icon = ' width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
    content = content.replace(icon, ' class="i" viewBox="0 0 24 24"')
    classes = {name for group in re.findall(r'class="([^"]*)"', content) for name in group.split()}
    html = (
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проверялка: диаграмма этапов и файлы проекта</title>'
        f"<style>{prune(css, classes)}.i{{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}}</style></head><body style=\"margin:0\">"
        f'<div style="width:{WIDTH}px;zoom:{FRAME / WIDTH:.3f}">{content}</div></body></html>'
    )
    out = ROOT / "overview.snapshot.html"
    out.write_text(html, encoding="utf-8")
    print(out.relative_to(ROOT.parent), len(html))


main()
