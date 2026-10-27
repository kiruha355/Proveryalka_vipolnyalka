# Проверялка — ИИ-агент аналитик

Агент строит из текстового описания бизнес-процесса формальную модель состояний и переходов. Детерминированный Model Checker (TLC из TLA+ Tools) перебирает все достижимые состояния этой модели и, если находит нарушение правила, возвращает контрпример. Агент объясняет его на языке исходных требований.

LLM формализует и объясняет. Перебор состояний выполняет только TLC.

## Текущая реализация сервера

Добавлены FastAPI-каркас и SQLite-хранилище сессий, истории и текстовых
требований. Инструкции запуска и контракты: [docs/api.md](docs/api.md).
Транзакции, миграции и единая история для SDK: [docs/storage.md](docs/storage.md).
Снимок OpenAPI: [docs/openapi.json](docs/openapi.json).
Агент находится в `src/proveryalka/agent/`: Responses API, DeepSeek V4.1 Flash,
инструкции аналитика и запуск через `run_message(message, session)`.
Для истории используется `StoredSession` из серверного компонента.
Извлечение требований и формат аналитического результата: [docs/agent.md](docs/agent.md).
Из того же ответа без второго вызова LLM собирается [BehavioralModel 1.0](docs/behavioral-model.md).
JSON Schema и полные примеры находятся в `docs/schemas/` и `docs/examples/`.
Общий [интерфейс проверки](docs/verification.md) содержит шесть статусов,
проверку трасс, SDK-инструмент `check_behavior` и объяснение результатов.
Без адаптера ядра проверка не запускается; тестовые данные всегда помечены.
Уточняющий диалог запускается через `start_dialogue` и `reply_dialogue`:
вопросы, ответы, согласованные изменения и снимки разбора сохраняются в истории.
Агент пока не подключён к HTTP-запускам и SSE; эти маршруты, TLC и версии
моделей возвращают 503.
Остальные разделы ниже описывают целевую архитектуру.

## Структура проекта

```text
src/proveryalka/
  agent/            агент, промпт, настройка LLM и раннер
  behavior/         общий контракт, проверка типов и семантика одного шага
  verification/     контракт результата и интерфейс проверяющего адаптера
  api/              приложение FastAPI и HTTP-маршруты
  storage/          SQLite, история диалогов и миграции
  config.py         настройки приложения
  contracts.py      общие структуры данных
  services.py       интерфейс серверного адаптера
tests/              проверки
docs/               документация и ТЗ
assets/             материалы документации
junk/               локальные вспомогательные материалы, исключены из Git
```

## Схема БД

SQLite в томе Docker. Загруженные материалы, клоны репозиториев, файлы `.tla`/`.cfg`, логи TLC и сгенерированный код лежат на диске, а в базе хранятся пути к ним и хэши.

![Схема БД](assets/db-schema.png)

Исходник диаграммы: [assets/db-schema.mmd](assets/db-schema.mmd) (Mermaid).

| Таблица | Что хранит |
|---|---|
| `SESSION` | Чат и его режим: анализатор, дебаггер, обзор проекта, генератор кода |
| `AGENT_MESSAGE` | Единая история диалога в `agent_messages`; API и адаптер `StoredSession` используют одну таблицу |
| `SOURCE` | Материалы пользователя: текст, файлы, изображения, репозитории, API |
| `REQUIREMENT` | Пронумерованные требования R1…Rn, на которые ссылаются элементы модели |
| `MODEL` | Модель как сущность: имя и чат |
| `MODEL_VERSION` | Неизменяемая версия модели. `spec` — вся модель в JSON, `parent_id` — версия-родитель, `state` — черновик или утверждена |
| `CHECK_RUN` | Одна проверка одного свойства одной версии: статус, контрпример, статистика, связанные требования |
| `ARTIFACT` | Сгенерированный код и тесты |
| `TEST_RUN` | Прогон тестов в песочнице |

Решения:
- **Версии модели неизменяемы.** Любая правка агента или пользователя создаёт новую версию со ссылкой на родителя. Проверки, код и тесты привязаны к конкретной версии.
- **Модель хранится одним JSON.** Модель читается и пишется целиком по контракту BehavioralModel 1.0. Pydantic проверяет структуру, типы и ссылки при чтении.
- **Связи с требованиями лежат внутри модели.** Переходы и свойства хранят `requirement_ids`, а `source_refs` находятся в каталоге требований модели. Зависимости выражены условиями переходов. `related_requirements` вычисляется детерминированно из переходов контрпримера.
- **Кэш проверок.** Чекер детерминирован, поэтому результат переиспользуется по ключу `(spec_hash, property_id, engine_version)`.

## API

Одно приложение FastAPI: REST и SSE для веб-интерфейса, MCP для кодинг-агентов. OpenAPI-документация генерируется автоматически на `/docs`.

### REST

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/sessions` | Создать чат с режимом |
| `GET` | `/api/sessions` | Список чатов |
| `GET` | `/api/sessions/{id}` | Чат: сообщения, материалы, текущая модель |
| `POST` | `/api/sessions/{id}/sources` | Загрузить файл или изображение (multipart), подключить репозиторий или API |
| `POST` | `/api/sessions/{id}/messages` | Отправить сообщение агенту, в ответ `run_id` |
| `GET` | `/api/runs/{run_id}/events` | Поток событий агента (SSE) |
| `GET` | `/api/models/{id}/versions` | Список версий модели |
| `GET` | `/api/models/{id}/versions/{n}` | Версия модели |
| `POST` | `/api/models/{id}/versions` | Ручная правка: создаёт новую версию |
| `POST` | `/api/models/{id}/versions/{n}/approve` | Утвердить версию |
| `POST` | `/api/models/{id}/versions/{n}/checks` | Запустить проверку без LLM |
| `GET` | `/api/checks/{id}` | Результат проверки |
| `GET` | `/api/checks/{id}/artifacts/{name}` | Файлы прогона: `.tla`, `.cfg`, лог TLC |
| `POST` | `/api/models/{id}/versions/{n}/codegen` | Сгенерировать реализацию по утверждённой модели |
| `POST` | `/api/models/{id}/versions/{n}/tests/run` | Прогнать тесты в песочнице |
| `GET` | `/api/models/{id}/versions/{n}/export` | Архив проекта |

#### Пример: запуск проверки

```http
POST /api/models/m_42/versions/1/checks
Content-Type: application/json

{ "property_ids": ["P2"] }
```

```json
{
  "status": "PROPERTY_VIOLATED",
  "property_id": "P2",
  "engine": "TLC",
  "related_requirements": ["R1", "R2"],
  "counterexample": {
    "steps": [
      {"number": 0, "state": {"status": "Created", "approved": false, "cancelled": false}},
      {"number": 1, "transition": "Approve", "state": {"status": "Approved", "approved": true, "cancelled": false}},
      {"number": 2, "transition": "Cancel", "state": {"status": "Cancelled", "approved": true, "cancelled": true}},
      {"number": 3, "transition": "Execute", "state": {"status": "Executed", "approved": true, "cancelled": true}}
    ]
  }
}
```

Статусы проверки: `PROPERTY_HOLDS`, `PROPERTY_VIOLATED`, `MODEL_INVALID`, `TIMEOUT`, `STATE_LIMIT_REACHED`, `ENGINE_ERROR`. `TIMEOUT` и `STATE_LIMIT_REACHED` никогда не трактуются как `PROPERTY_HOLDS`.

### События SSE

| Событие | Когда приходит |
|---|---|
| `message_delta` | Очередной фрагмент текста агента |
| `tool_call` | Агент вызвал инструмент |
| `model_proposed` | Появилась новая версия модели, интерфейс обновляет диаграмму |
| `clarification_requested` | Агент задаёт уточняющий вопрос с вариантами ответа |
| `check_started` / `check_finished` | Начало и результат проверки |
| `file_written` | Сгенерирован файл кода или теста |
| `run_finished` | Агент закончил работу |
| `error` | Ошибка |

### MCP (`/mcp`, Streamable HTTP)

Инструменты для кодинг-агентов (Claude Code, Cursor):

| Инструмент | Что возвращает |
|---|---|
| `get_model(model_id, version?)` | Утверждённую модель |
| `check_behavior(model_id, version, property_ids?)` | Результаты проверки свойств |
| `get_tests(model_id, version)` | Тесты, выведенные из модели |
| `compare_with_code(model_id, version, files)` | Места, где код расходится с моделью |
