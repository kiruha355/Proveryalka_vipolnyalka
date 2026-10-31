# Обновление основной объяснялки

31.10.2026. Изменены только `../explain.html`, `../decisions/explain.html` и этот handoff; коммиты, push, серверы, provider calls и Docker этим worker не запускались.

В основную `explain.html` встроены семь inline SVG из `../architecture/diagrams/01…07`, включая последнюю корректировку подписи первой схемы. Для всех схем есть якоря основного закреплённого оглавления, масштабирование и отдельные SVG-ссылки. CSS SVG ограничен `.integration-atlas svg`, чтобы классы схем не меняли старый документ. Один непрерывный документ сохранён.

Актуализированы начало документа, flow генерации, границы новых API и ссылки на квитанции/PDF/стенд. Поток: человек и уточнения → LLM/BehavioralModel → ручной TLC → явная правка и новая версия → «Согласовать для кода» → детерминированный CodegenService по шаблонам без LLM → files/ZIP → отдельные Docker tests → read-only GPT по проверенным сохранённым байтам без изменения требований/версий. Согласование обозначает соответствие требованиям и разрешение использовать для кода, не HOLDS.

Разделы исходного плана, команды, хранения, набросков, аудита и демонстрации помечены как история 62c12b8, включая пункты оглавления и локальные предупреждения в каждой главе. Enum-fixture отделён от живого boolean-сценария с guard `approved AND NOT cancelled`. В `decisions/explain.html` устранены старые статусы #39/#49 и 344/33/107 tests; снимки revision-2 обозначены как старые.

## Проверено этим worker

- HTMLParser: нет повторяющихся ID и битых внутренних якорей в обоих документах. В основном документе 11 SVG всего, из них ровно 7 в актуальном разделе схем. Каждый из семи inline SVG разбирается XML-парсером. Новые относительные ссылки на SVG, PDF и квитанции существуют.
- Native `html_preview`, full document, 1200px: contentHeight 41846px, первые 4000px визуально просмотрены, consoleMessages пуст. Для preview старые sketch images переданы абсолютными локальными путями и автоматически встроены; сохранённый файл оставляет относительные пути.
- Native `html_preview`, текущие главы, 390px: contentHeight 10863px, первые 4000px визуально просмотрены, consoleMessages пуст. Схемы прокручиваются по горизонтали внутри контейнеров, наружного overflow нет.
- Native `html_preview`, глубокий фрагмент с генератором/подключениями/delivery и flow, 1200px: contentHeight 3557px, просмотрен целиком, consoleMessages пуст.
- Временный synchronous DOM-check в native preview390: все цели оглавления существуют; toggle открывается/закрывается; zoom увеличивает схему; reset возвращает width100%; ширина документа не превышает viewport. Console log: `Explainer: TOC targets, toggle, zoom, reset, mobile document width PASS.`
- Native `html_render` показал выбранные актуальные главы из основной объяснялки; сам полный документ остаётся `../explain.html`. Attachment: `10ecdc2b-23d7-4ec5-8e85-4b6490fbb5aa-fbc002d1-efff-44c3-a3f8-162a357f5403-html`, title `Схемы и генерация в основной объяснялке`, initial height2000, measured728px height8340.

## Границы

Новые кодовые тесты и E2E этим worker не запускались. Backend513 и основной browser/GPT/TLC/ZIP/Docker54 сценарий взяты из существующих integration/end-to-end квитанций. Frontend38/extensions108/types/build подтверждены `../final-demo/ui-feedback.json`. Новый run `trun_fe56347d07154d83815d3f677f500ac5` на общем5300 передан root как PASS54/54; worker его не запускал и не воспроизводил. Полный документ длиннее лимита одной preview-картинки; проверены начало и указанный глубокий участок, не каждая строка исторического аудита. User visual acceptance, corpus#30 и clean-machine остаются PENDING. Merge, CIgreen, закрытие issues и обновление Kanban columns не заявлены.

Первый render preflight отклонил viewport-height CSS100dvh; это исправлено фиксированным max-height600px до успешных native previews. Первый preview со старыми относительными sketch images дал resource errors; повтор с локальными inline images прошёл без console errors. Текущий final render не содержит этих исторических картинок, потому что показывает только обновлённые главы.
