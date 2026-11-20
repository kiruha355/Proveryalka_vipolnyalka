# Источники изображений (#45)

Модуль принимает PNG, JPEG и WebP с одним кадром, сохраняет очищенный PNG в SQLite и передаёт **пиксели**, а не имя файла, модели. TXT/MD/DOCX остаются в существующем `/documents`; этот модуль их не меняет.

## Подключение

Основной `create_app` подключает router и recovery изображений; migration registry применяет `007_images.sql`, Pillow закреплён в зависимостях. DTO находятся в `images.dto`. Изолированные API-тесты используют тот же production router и SQLiteStore; общий integration-тест проверяет обновление БД с версии 6 и сохранение изображения после restart. Исторический patch в `reports/project-review-20261031/sokolov/images/integration.patch` повторно применять не нужно.

## API

Все маршруты имеют префикс `/api/sessions/{session_id}/images`.

| Метод | Суффикс | Вход и результат |
|---|---|---|
| POST | пустой | multipart `file`, `Idempotency-Key` → 201 `ImageSource` |
| GET | пустой | список `ImageSource` данной сессии |
| GET | `/{source_id}` | metadata `ImageSource` |
| GET | `/{source_id}/content` | очищенный canonical PNG; `nosniff`, `private,no-store` |
| POST | `/{source_id}/analysis` | `{}` либо `{"region":{"x":10,"y":20,"width":30,"height":40}}`, `Idempotency-Key` → `ImageAnalysis` |
| GET | `/{source_id}/analyses` | сохранённые `ImageAnalysisRecord`, включая `running`, `failed`, `completed` |

У загрузки обязателен `Content-Length`; реальное тело тоже ограничено до разбора multipart. Допускается ровно один file. Максимум по умолчанию: 8 MiB входных bytes, 16 миллионов decoded pixels, 8192 по стороне и 32 MiB canonical PNG. Эти пределы — **предложенные настройки**, изменяются через `ImageLimits`; они не являются новой согласованной продуктовой политикой. MIME, расширение, сигнатура и полный декодированный файл проверяются совместно. Animated PNG/WebP, GIF/TIFF/SVG, архивы и модели не поддерживаются. Файловые пути/URL не являются входом API. Пользовательское имя очищается существующим `clean_filename` и хранится только как подпись.

EXIF orientation применяется перед сохранением; EXIF/ICC/XMP/comments/PNG text и trailing data не сохраняются и не отправляются модели. В metadata остаются SHA256 и размер **оригинальных** bytes и отдельно SHA256/размер canonical PNG. Исходный файл после нормализации не хранится. Координаты относятся к canonical PNG, который показывает `/content`. Ссылка без `region` обозначает весь кадр. Для `selected_region` сервис проверяет полуоткрытые границы, вырезает именно эти пиксели и отправляет crop модели. Модель не назначает координаты.

## Происхождение требований

`ImageSource.kind = image`, у него нет `text`. `ImageRef.kind = image_reference`, у него нет `quote`, `start`, `end`. Текстовые `SourceRef` сохраняют свой прежний контракт с проверяемой дословной цитатой. Источник изображения не маскируется под OCR-текст.

`ImageRequirement.origin` равен `visible` для описанного видимого элемента либо `proposal` для предложенного продуктового правила. Это вывод модели, требующий оценки человеком. Ссылка устанавливает область входных пикселей, а не подтверждает истинность интерпретации. `uncertainties` не заменяются нулями или утверждением готовности модели. Обычный `/messages` продолжает принимать только текстовые источники: автоматическое создание формальной модели из `ImageAnalysis` не выполняется. Клиенту нужен отдельный просмотр результата разбора изображения; он не должен отправлять `img_*` в прежний `source_id` текстового диалога.

## Провайдеры

Codex использует существующий `CodexClient` с подпиской пользователя: native `type=image,url=data:image/png;base64,...`; до запроса модель должна явно объявить `image` в `model/list.inputModalities`. Отсутствующий capability, неизвестная модель или text-only модель дают `PROVIDER_IMAGE_UNSUPPORTED`. Действуют существующие отключения tools/hooks/apps/MCP, ephemeral thread, `approvalPolicy=never`, read-only sandbox и отсутствие сети в инструментальной среде. Для передачи самому провайдеру по сети по-прежнему нужна его обычная связь. Никаких `codex exec`, доступа к token-файлам, пользовательских hooks, handoffs или новых ключей.

OpenAI-compatible Responses API использует существующие client/credentials. Поскольку совместимость с Responses ещё не доказывает vision, этот путь включается только оператором через `PROVERYALKA_OPENAI_VISION=1` после проверки возможностей своего endpoint. Это предложение безопасного opt-in, не запрос нового API key. Передаётся официальный `input_image` с data URL, `tools=[]`, `tool_choice=none`, `store=false`, strict JSON schema. Ошибки endpoint не превращаются в текстовый fallback и не возвращают исходный provider error body клиенту. МАИ endpoint не использован.

## Хранение и повтор

Загрузка атомарна с idempotency response. Повтор одинаковой загрузки даёт тот же источник, изменение payload при том же ключе — 409. Анализ сначала сохраняет `running`, затем `completed` с результатом либо `failed` с code. Повтор завершённого анализа не вызывает провайдера. Для ошибки нужен новый ключ; startup переводит прерванные `running` в `failed/IMAGE_ANALYSIS_INTERRUPTED`. Включать recovery нужно при старте одного владельца application DB, как у основного backend; конкурентный запуск двух серверов с одной DB не поддерживается существующей runtime-моделью.

Анализ выполняется в HTTP-запросе, с отдельными пределами concurrent/timeout (по умолчанию 1 и 180 секунд). При занятом слоте — 429, при неподдерживаемом provider — 503 с `PROVIDER_IMAGE_UNSUPPORTED`, при повреждённом источнике в storage — 503 `IMAGE_SOURCE_CORRUPT`. История анализов позволяет восстановить результат после разрыва клиентского соединения. Очередь основного `/runs` этим модулем не используется.

## Проверки

`pytest tests/images tests/test_codex_runtime.py tests/test_codex_images.py` — deterministic/API/transport contract tests, **не** реальная модель. Единственный реальный provider smoke и его воспроизводимая команда сохранены в evidence. Browser/frontend, автоматическая formalization и production E2E не запускались.

Протокол сверён с локальной JSON schema `codex-cli 0.166.0` и официальными [Codex app-server docs](https://learn.chatgpt.com/docs/app-server), формат Responses — с [Images and vision](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses).
