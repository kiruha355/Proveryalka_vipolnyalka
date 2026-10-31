# Запуск основной версии

Поставка — native Python backend и собранный Vite frontend на `http://127.0.0.1:8000`. SQLite и материалы TLC остаются на диске. Сервер запускает локальный Codex app-server через уже существующий адаптер; подписка авторизуется в аккаунте пользователя на этой машине. Backend не упаковывается в Docker. Docker нужен только для выполнения сгенерированных тестов в существующей песочнице. Работа GPT-подписки внутри Docker не проверена и не является вариантом поставки.

## Чистая машина

Нужны Python 3.12 с venv/pip, Node.js 24 с npm, Java 21 (Temurin), curl и локально установленный/авторизованный Codex app-server для GPT-подписки. Локально delivery проверялся на macOS с Python 3.12.12 и Java 25; GitHub job настроен на Linux/Python 3.12/Java 21. Чистая установка всех зависимостей на новой машине в этом изменении не выполнялась; lock-файлы и команды подготовлены для воспроизведения.

Из корня checkout:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-runtime.lock
.venv/bin/python -m pip install --no-deps -e .
sh scripts/fetch_tla2tools.sh
npm --prefix frontend ci
npm --prefix frontend-extensions ci
npm --prefix frontend run build
cp .env.example .env
```

В `.env` оставить `PROVERYALKA_LLM_PROVIDER=codex`; при необходимости указать `PROVERYALKA_CODEX_BIN`, `PROVERYALKA_CODEX_MODEL`, `PROVERYALKA_CODEX_EFFORT`, `PROVERYALKA_JAVA`. Имя модели берётся из доступных моделей установленного адаптера. API-поля `OPENAI_*` для этого режима не используются; endpoint МАИ в этой поставке не проверяется. Секреты и файлы локальной авторизации не копировать в checkout, image build context или GitHub. Авторизацию выполняет сам пользователь штатным способом установленного Codex; delivery не извлекает auth-файлы.

```sh
sh scripts/run-stack.sh
# Другой порт и постоянный каталог (папка не должна принадлежать другому серверу):
sh scripts/run-stack.sh --port 8010 --data-dir /absolute/path/to/proveryalka-data
```

`run-stack.sh` меняет cwd на корень checkout и через `exec` передаёт управление одному Python/uvicorn процессу. Для готового внешнего venv задаётся `PROVERYALKA_PYTHON=/absolute/path/to/python`. `--frontend-dist` выбирает отдельную собранную папку, `--env-file` — конфигурацию (по умолчанию `.env`, отсутствие допустимо). Переменные shell имеют приоритет над `.env`; явный `--data-dir` заменяет все три пути SQLite/артефактов/кэша. Без него используются настройки `.env`/shell, затем `data/`.

Сборка frontend выполняется при установке/обновлении. Во время работы npm/Vite dev server не нужен. API и статика обслуживаются одним origin, включая SSE. Существующий `run-server.sh` остаётся отдельным запуском только API для разработки. Delivery привязан к loopback, аутентификацию/публичный reverse proxy не добавляет.

## Readiness, остановка и сохранение

```sh
curl --fail http://127.0.0.1:8000/health
curl --fail http://127.0.0.1:8000/ready
.venv/bin/python -m proveryalka.runtime
.venv/bin/python -m proveryalka.codegen sandbox-status
```

`/health` показывает наличие HTTP-процесса. `/ready` проверяет SQLite, доступность Java/TLC, наличие Vite index и его entry assets, запись в каталог артефактов. До bind выполняется preflight SQLite/артефактов/TLC/build. `agent_configured` означает наличие executable/настроек; это не доказательство авторизации, качества LLM или выполненного запроса. Sandbox status — отдельная capability; недоступный Docker не блокирует анализ и TLC, но тесты не будут выполнены. При исчезновении build/артефактов `/ready` возвращает 503.

Ctrl+C или SIGTERM **своему** процессу запускает штатный lifecycle API: операции отменяются, статусы сохраняются, дочерние TLC и собственные контейнеры завершаются. SQLite, codegen-файлы, отчёты и логи тестов хранятся в БД; TLC bundles — в каталоге артефактов. На restart незавершённые операции получают типизированный статус восстановления, завершённые отчёты остаются доступны. Один backend worker на одну БД; `--reload` и несколько workers в поставке не поддерживаются.

Для backup остановить свой сервер, сохранить SQLite вместе с каталогом артефактов (при наличии SQLite `-wal`/`-shm` сохранить и их). Restore делать в отдельный каталог, запускать с соответствующим `--data-dir`. Не переносить `.env`/Codex home как часть backup. Не удалять `data/` между запусками. Временные Docker containers удаляются executor после своего запуска; автоcleanup не имеет права на чужие/legacy owners, см. [контракт](sandbox-ownership-contract.md).

## Пользовательский сценарий

1. Открыть корень сайта и выбрать live backend, создать сессию, ввести описание или загрузить TXT/MD/DOCX.
2. Ответить на вопросы по конкретным требованиям. Неизвестные правила остаются вопросами; новое правило требует явного текста пользователя.
3. Просмотреть требования/цитаты и предложенную версию. Запуск TLC выполняется явно. Проверить статус, трассу и относящиеся к ней требования.
4. Запросить объяснение сохранённого результата. При ошибке объяснения повторить только объяснение, сохраняя исходный отчёт TLC.
5. Явно уточнить Cancel: снимать `approved`; также задать ограничения Approve/Cancel, если они нужны для запрета повторного согласования отменённой заявки. Проверить новую версию и повторить TLC. Старый отчёт должен остаться связан с исходной версией.
6. Для генерации утвердить версию. Если TLC не подтвердил все свойства, генерация требует явного `allow_unverified=true` и сохраняет фактические статусы. Сгенерированный Python не выполнять на хосте.

## DSL и ограничения

BehavioralModel 1.0: boolean, конечные enum, integer с границами; `literal`, `variable`, unary `not/neg`, binary `and/or/implies/eq/ne/lt/le/gt/ge/add/sub/mul`. Effects вычисляются одновременно по прежнему состоянию; остальные переменные сохраняются. Свойства: `invariant`, `forbidden_state`, `reachable`, `deadlock_free` с явно согласованным условием завершения. Не поддержаны произвольный Python/TLA+, бесконечные области, деление, множества/кванторы и произвольная временная логика. Правила валидируются до TLC; выход за область не превращается в усечённую успешную модель. Полная семантика — [README ядра](../src/proveryalka/checker/README.md).

| Ограничение | Значение по умолчанию / настройка |
|---|---|
| Очередь backend | 32, `PROVERYALKA_MAX_PENDING_RUNS` |
| Агент / проверки / свойства TLC | по 2 активных, `PROVERYALKA_AGENT_PARALLEL`, `PROVERYALKA_CHECK_PARALLEL`, `PROVERYALKA_TLC_PARALLEL` |
| Время LLM-run | 630 секунд, `PROVERYALKA_AGENT_TIMEOUT` |
| Входной текст / документ | 100000 символов / 5 MiB |
| TLC heap | 512 MiB на процесс, `PROVERYALKA_TLC_HEAP_MB` |
| Лимиты проверки | задаются запросом `limits`: `timeout_seconds`, `max_states`, `max_depth` |
| Sandbox | 1 CPU, 512 MiB, 0 swap, 128 PID, tmpfs 64 MiB, network none, read-only, user 10001 |
| Sandbox время / очередь | 120 секунд по умолчанию, максимум 600; 1 активный, 8 pending |

`TIMEOUT`, `STATE_LIMIT_REACHED`, `MODEL_INVALID`, `ENGINE_ERROR` не доказывают свойство. `PROPERTY_HOLDS` относится к конечной проверенной модели, а не автоматически к реальному сервису или правильности перевода текста в модель. Генерация Python/FastAPI/pytest сохраняет идентификатор версии и хэши спецификации/кода. Тесты в песочнице не заменяют TLC.

## Песочница

На машине с Docker сначала выполнить информационную проверку диска, затем:

```sh
.venv/bin/python -m proveryalka.codegen sandbox-build
.venv/bin/python -m proveryalka.codegen sandbox-status
```

Build context — только `src/proveryalka/codegen/sandbox_image/`, зависимости закреплены с SHA-256. Весь checkout, `.env`, Codex home и Docker socket в container не передаются. Во время выполнения Docker получает только временную копию проверенных файлов проекта read-only. Готовый образ текущего определения: `proveryalka-codegen-sandbox:4d76b97118d8df7e`; изменение определения требует нового content-derived tag. Лимиты Docker Desktop автоматически не меняются.

## Локальные проверки и CI

```sh
PROVERYALKA_REQUIRE_TLC=1 PROVERYALKA_REQUIRE_SANDBOX=1 \
PROVERYALKA_TEST_FRONTEND_DIST=frontend/dist \
.venv/bin/python -m pytest -q -rs --junitxml=/tmp/proveryalka-tests.xml
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend-extensions run check
```

Обычный `tests.yml` не получает LLM-секретов. Обязательные jobs: `frontend` (types, components, build обеих частей), `backend-tlc` (весь deterministic набор с настоящим TLC и отдельным реальным HTTP restart на артефакте build), `sandbox` (сборка image, реальные тесты hostile/timeout/OOM/cancel и TLC→generation→Docker→restart provenance). Отсутствующий движок при require-флагах даёт FAIL. JUnit/logs/TLC bundles и delivery receipt сохраняются через `if: always()`; source models в этих bundles — тестовые fixtures. Отдельный `live-http` frontend test по умолчанию skipped; обязательный API+TLC уровень проверяется Python-набором. Browser/provider не выдаются за component PASS.

Manual `provider-acceptance.yml` запускается только через workflow_dispatch: явно указать Responses API endpoint/model и budget, заранее настроить environment `provider-acceptance` с secret `PROVIDER_API_KEY`. Настройка protection rules environment — предложение оператору; workflow не меняет GitHub policy сам. Никакой перенос подписочной авторизации не предусмотрен. Lane проверяет один полностью заданный сценарий: текст→модель→TLC→объяснение→явное уточнение→новая версия→TLC; сохраняет публичную receipt без SQLite/истории/секретов. Clarification или несовпадение ожидаемых результатов приводит к FAIL; фиктивного ответа нет.

Бюджет: до 6 Responses requests по умолчанию (не более 10), до 4096 output tokens/request (допустимо 256..8192), до 150000 input characters суммарно, 600 секунд (максимум 900), SDK retries=0. Это ограничение запросов/объёма, не денежный cap. Тарификацию и project spend cap задаёт оператор провайдера. Любая попытка сверх бюджета блокируется до SDK; последний уже отправленный запрос может завершиться в пределах HTTP timeout до 90 секунд. CLI требует `--confirm-provider-spend`; ordinary tests не расходуют бюджет. В этом изменении реальный provider lane — NOT_RUN.

```sh
# Только после явного выбора API-конфигурации и бюджета в окружении:
PROVERYALKA_LLM_PROVIDER=openai .venv/bin/python -m proveryalka.delivery_provider \
  --confirm-provider-spend --output /absolute/new/receipt-directory \
  --max-calls 6 --max-output-tokens 4096 --seconds 600
```

Для GPT-подписки локальный browser E2E #39 выполняется отдельным frontend агентом. Его receipt и проверка качества на корпусе #30 учитываются отдельно; один backend live-case не подтверждает качество на корпусе.

## Диагностика

| Симптом | Проверка / действие |
|---|---|
| Старт `not_ready` | Проверить build и entry assets, пути/права SQLite и artifacts, Java/TLC; `python -m proveryalka.runtime` |
| Port already in use | Выбрать свободный `--port`; чужой процесс не останавливать |
| `/health` 200, `/ready` 503 | Проверить зависимости и диск; HTTP 200 сам по себе не означает готовность сценария |
| `agent_configured=false` | Проверить путь к локальному Codex для provider=codex, либо явные API-поля для provider=openai |
| Ошибка auth/rate limit | Сохранить Run.error_code, исправить авторизацию штатным способом, повторить pending ход; не пересылать auth-файлы |
| Объяснение failed | Отчёт TLC сохранён; повторить `/api/checks/{id}/explanation` |
| `engine_unavailable` sandbox | `sandbox-status`, наличие Docker/правильного image; не запускать generated code на хосте |
| Остались чужие/legacy containers | Проверить owner/labels и активность, затем принять отдельное решение о cleanup; startup их не удаляет |
