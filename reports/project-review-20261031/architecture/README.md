# Архитектура Проверялки

`explain.html` — непрерывный документ с оглавлением, семью встроенными SVG и управлением масштабом. `diagrams/` содержит эти же схемы отдельными файлами; `diagrams.zip` — комплект для вставки в презентацию. `build.py` воспроизводит HTML, SVG и ZIP без дополнительных зависимостей.

Состав: компоненты и участники; путь описания и проверки; устройство ядра; отношения SQLite; генератор и Docker; документы/изображения/репозитории/MCP; native launcher и CI.

Зоны ответственности взяты из GitHub issues, связи - из исходников. Основная цепочка PR66 e2e005e и модули PR67-70 объединены в draft PR71; images/repositories routers, migrations007/008 и точный MCP /mcp route подключены к create_app. Общая проверка: 513 backend PASS с настоящими TLC/Docker, frontend38 PASS, extensions108 PASS после UI-feedback. Images/repository frontend screens и автоматическая формализация изображений отсутствуют. Корпус #30 и пользовательская UX-приёмка pending.

PDF: `../../../output/pdf/proveryalka-architecture.pdf`, семь векторных альбомных страниц A4 с закладками. Экспорт: `python3 reports/project-review-20261031/architecture/export_pdf.py` (rsvg-convert + reportlab + pypdf). Все семь страниц отрисованы pdftoppm и визуально проверены.
