# Проверялка — ИИ-агент аналитик

Агент строит из текстового описания бизнес-процесса формальную модель состояний и переходов. Детерминированный Model Checker (TLC из TLA+ Tools) перебирает все достижимые состояния этой модели и, если находит нарушение правила, возвращает контрпример. Агент объясняет его на языке исходных требований.

LLM формализует и объясняет. Перебор состояний выполняет только TLC.

## Схема БД

SQLite в томе Docker. Загруженные материалы, клоны репозиториев, файлы `.tla`/`.cfg`, логи TLC и сгенерированный код лежат на диске, а в базе хранятся пути к ним и хэши.

![Схема БД](assets/db-schema.png)

Исходник диаграммы: [assets/db-schema.mmd](assets/db-schema.mmd) (Mermaid).

| Таблица | Что хранит |
|---|---|
| `SESSION` | Чат и его режим: анализатор, дебаггер, обзор проекта, генератор кода |
| `AGENT_MESSAGE` | История диалога. Таблицу создаёт `SQLiteSession` из OpenAI Agents SDK |
| `SOURCE` | Материалы пользователя: текст, файлы, изображения, репозитории, API |
| `REQUIREMENT` | Пронумерованные требования R1…Rn, на которые ссылаются элементы модели |
| `MODEL` | Модель как сущность: имя и чат |
| `MODEL_VERSION` | Неизменяемая версия модели. `spec` — вся модель в JSON, `parent_id` — версия-родитель, `state` — черновик или утверждена |
| `CHECK_RUN` | Одна проверка одного свойства одной версии: статус, контрпример, статистика, связанные требования |
| `ARTIFACT` | Сгенерированный код и тесты |
| `TEST_RUN` | Прогон тестов в песочнице |

Решения:
- **Версии модели неизменяемы.** Любая правка агента или пользователя создаёт новую версию со ссылкой на родителя. Проверки, код и тесты привязаны к конкретной версии.
- **Модель хранится одним JSON.** Модель всегда читается и пишется целиком, а формат DSL ещё меняется. Структуру проверяет Pydantic при чтении.
- **Связи с требованиями лежат внутри модели.** Переходы и свойства хранят `source_refs`. Зависимости между требованиями выражены условиями переходов. `related_requirements` вычисляется детерминированно из переходов контрпримера.
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
