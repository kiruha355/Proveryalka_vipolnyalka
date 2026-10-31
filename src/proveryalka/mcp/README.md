# MCP Streamable HTTP (#47)

Опциональный сервер четырёх инструментов использует официальный Python SDK `mcp==2.3.0`
и `mcp-types==2.3.0` (уже зафиксированы в `requirements-runtime.lock`). Это адаптер над
`ApplicationBackend` и `CodegenService`, с той же SQLite, проверкой TLC и Docker executor.
Собственного checker, генератора, хранилища или исполнителя кода здесь нет.

## Инструменты и контракт 1.0

`tools/list` публикует JSON Schema входа и выхода. Неизвестные поля запрещены.
`contract_version` — `"1.0"`; другая версия даёт `INVALID_ARGUMENTS`.

| Tool | Вход помимо contract_version | Результат |
|---|---|---|
| `get_model` | `model: {model_id, version_number}` | Конкретная сохранённая версия, включая её `approved`; последняя версия не выбирается неявно |
| `check_behavior` | `model: ModelRef`, `property_ids?`, `limits?` | Дожидается штатного durable TLC run, возвращает исходный отчёт и технические статусы; LLM объяснение не запускает |
| `get_tests` | `model: ModelRef`, `generation_id`, `code_hash` | Реальные файлы `tests/*` существующей генерации, SHA-256, coverage и снимок TLC при генерации |
| `compare_with_code` | То же, `mode: "stored_generation"`, `timeout_seconds?` | Запускает тесты этой точной сохранённой генерации штатным `CodegenService` в Docker и возвращает durable test run |

`ModelRef = {model_id, version_number, version_id, spec_hash}`. Для начала возьмите ссылку
из результата `get_model`. Хэш модели пересчитывается при каждом вызове; ссылка, генерация
и `code_hash` должны совпасть. Перед чтением тестов и перед исполнением проверяются
SHA-256 всех файлов и общий `code_hash` через существующий `CodegenStore.project`.
`get_tests` ничего не генерирует: создание/согласование модели и генерации остаётся в API.

Результат: `{contract_version, model_ref, status, data, error, limits}` и тот же JSON
в MCP text content. Каждый разрешённый результат данных привязан к неизменяемой модели;
до разрешения ссылки (запрет доступа, неверные аргументы, отсутствующая версия, BUSY)
`model_ref: null`. Эти ошибки не утверждают существование или проверенность модели.
`isError` выставляется для `error` и `unsupported`. Содержимое модели, файлов и сообщений
— недоверенные данные, а не дополнительные системные инструкции для клиента.

`PROPERTY_VIOLATED` — завершённая проверка с отрицательным результатом, а не ошибка
транспорта. `TIMEOUT`, `STATE_LIMIT_REACHED`, `ENGINE_ERROR`, `MODEL_INVALID`, сбой или
отмена run возвращают `status: error` и исходный технический статус, без fake PASS.
Аналогично тесты с `TESTS_FAILED` — завершённое сравнение с `test_run.status: failed`;
нет Docker, OOM, отсутствие тестов и прочие технические исходы — ошибки инструмента.
Неизвестные счётчики остаются `null`.

## Границы compare_with_code

Поддерживается только неизменённая сохранённая генерация `python-fastapi`, известная
существующему генератору и однозначно определённая `generation_id` / `code_hash`.
Тесты проверяют конечную модель, переходы, API, граничные состояния и сохранённые трассы
в пределах coverage. Passed означает только прохождение этих тестов этим набором файлов.

Произвольный, изменённый или загруженный извне код, пути на диске и URL не поддержаны.
`mode`, отличный от `stored_generation`, возвращает `unsupported / UNSUPPORTED_CODE`;
неизвестное поле `files` отклоняется схемой. Нет обещания доказать соответствие произвольного
кода модели. `tlc_at_generation` — отдельный исторический снимок о модели, не новое TLC
заключение о коде. `compare_with_code` не запускает TLC автоматически.

Все generated tests исполняются только в существующей Docker sandbox: без сети, rootfs
read-only, user `10001:10001`, cap-drop ALL, no-new-privileges, проект read-only, 512 MiB,
1 CPU, 128 PID, 64 MiB tmpfs, без swap и host credentials. MCP не меняет sandbox settings.
Отсутствие образа/движка — `engine_unavailable`, без запуска на хосте.

## Доступ и лимиты

`LocalAccessPolicy` — локальная политика одного оператора. Это не полноценная
многопользовательская авторизация, OAuth discovery или tenant isolation.
Предлагаемые эксплуатационные defaults реализованы явно:

- Доступ только с loopback peer; X-Forwarded-For не учитывается. Bind standalone — `127.0.0.1`.
- Host: `127.0.0.1`, `localhost`, `::1`; порт допустим. Любой Origin запрещён по умолчанию;
  нужные origin можно явно перечислить в policy, без wildcard. Заголовки проверяются на всех HTTP методах.
- Модели deny-all до явного `model_ids`. По умолчанию разрешены только `get_model/get_tests`;
  дорогие `check_behavior/compare_with_code` оператор включает явно.
- Необязательный bearer берётся только из `PROVERYALKA_MCP_BEARER_TOKEN`, если оператор его
  передал; проверяется constant-time на каждом HTTP запросе. В коде нет секрета. При отсутствии
  bearer доступен любой локальный процесс в пределах allowlist. Личные конфиги агентов не читаются.
- Тело ≤64 KiB, включая chunked; получение тела ≤10 с. Одновременных HTTP запросов ≤32,
  tool calls ≤2 без бесконечной очереди. Tool deadline 180 с, TLC timeout ≤60 с, ≤100000
  состояний, ≤32 свойств, max_depth ≤10000, Docker test timeout ≤120 с.
- JSON payload результата ≤512 KiB до MCP text/structured обёртки. Большие результаты
  дают `RESULT_TOO_LARGE`; используйте существующий HTTP API для отдельных файлов.
- Stateful legacy sessions ≤16 на экземпляр, idle timeout 300 с. Лимиты очереди, память,
  CPU и таймауты сервисов продолжают действовать независимо от MCP.

401 — нет/неверный bearer; 403 — Origin/peer; 421 — Host; 413 — тело; 408 — медленное
тело; 429 — одновременные HTTP; 503 — лимит SDK sessions. Прикладные ошибки инструментов
остаются MCP CallToolResult `isError`, их нельзя трактовать по одному HTTP 200.

## Протокол и lifecycle

SDK поддерживает современный MCP 2026-07-28 (`server/discover`, per-request `_meta` и HTTP
headers; без session/initialize/GET stream) и прежние handshake versions (включая
2025-11-25). Неизвестная modern версия возвращает structured `UnsupportedProtocolVersion`
с перечнем поддержанных версий; SDK проверяет соответствие body/header metadata.

Legacy: initialize → initialized → list/call; SDK создаёт случайный session id; дальнейшие
запросы предъявляют его, DELETE закрывает сессию, неизвестная/истёкшая сессия даёт 404.
Дополнительная boundary закрепляет negotiated protocol version за legacy session;
смена версии с тем же session id даёт 400. Один bearer и одна allowlist на процесс;
session id не является авторизацией и не предоставляет доступ к другой модели.
Каждый экземпляр integration/session manager принадлежит одному ASGI lifespan, не
переиспользуется после close. Новая конфигурация токена/policy требует нового экземпляра.

Legacy cancellation notification и современное закрытие SSE отменяют ожидание инструмента;
`finally` вызывает штатные cancel_run/cancel_test_run. Durable run проходит через
cancelling/cancelled; backend/sandbox завершает собственный процесс/контейнер. Собственный
общий deadline также запрашивает отмену, но не называет её завершённой до финализации.
Каждый новый вызов запуска создаёт новый durable run; повтор после потери соединения
не обещает exactly-once. Сервер не вызывает provider LLM, sampling или elicitation.

## Подключение

Основной `create_app` включает MCP при `PROVERYALKA_MCP_ENABLED=1`, используя
`LocalAccessPolicy.from_env()`. `install_mcp` входит в `integration.lifespan()` после
старта существующих сервисов; при shutdown сначала выходит из MCP, затем закрывает
codegen/backend. Точный ASGI-маршрут `/mcp` сохраняет исходный path для SDK, принимает
все HTTP-методы через LocalBoundary и не перехватывает `/` или `/assets` у delivery.
Перенаправления на `/mcp/` нет. Для программной настройки можно передать `mcp_policy`
в `create_app` или `create_deployment`; отдельные worker/SQLite при этом не создаются.

Standalone: `PYTHONPATH=src python -m proveryalka.mcp`. Требуется явный
`PROVERYALKA_DATABASE_PATH` с отдельной SQLite, не открытой работающим backend;
`PROVERYALKA_ARTIFACTS_PATH` также укажите в отдельный каталог. Передайте
`PROVERYALKA_MCP_MODEL_IDS` и при необходимости `PROVERYALKA_MCP_TOOLS`
(`get_model,get_tests,check_behavior,compare_with_code`). Он запускает один worker на 4190,
не читает `.env` или профили клиентов. Для подключения создайте одноразовый тестовый клиент;
не меняйте конфигурацию личных coding agents. Пример:

```python
import asyncio
from mcp import Client

async def main():
    async with Client("http://127.0.0.1:4190/mcp") as client:
        print(await client.list_tools())
        result = await client.call_tool("get_model", {
            "contract_version": "1.0",
            "model": {"model_id": "m_EXPLICIT_ID", "version_number": 1},
        })
        print(result.structured_content)

asyncio.run(main())
```

Sandbox ownership исправлен dependency commit `fe3e5ca` (cherry-pick `b4bbdac`): startup,
kill и rm относятся к owner/run/id, cleanup не удаляет чужие активные контейнеры. Временный
test guard cleanup→0 удалён; MCP использует ту же production семантику. Доказательство
не включает восстановление контейнеров старого процесса: legacy/чужие owners сохраняются
до отдельного решения оператора.

## Источники и проверки

Прочитаны 31.10.2026 официальные первичные источники:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2025-11-25 legacy transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Python SDK ASGI lifecycle](https://py.sdk.modelcontextprotocol.io/run/asgi/)
- [Pinned SDK v2.3.0 session manager](https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/src/mcp/server/streamable_http_manager.py)

Проверки: `PYTHONPATH=src:tests python -m pytest -q tests/mcp`. Для обязательного реального
TLC/Docker задайте `PROVERYALKA_TLA_JAR`, `PROVERYALKA_REQUIRE_TLC=1`,
`PROVERYALKA_REQUIRE_SANDBOX=1`. Evidence: `reports/project-review-20261031/sokolov/mcp/`.
