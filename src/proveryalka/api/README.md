# HTTP-контракт основного сценария

Документ для клиента (веб-интерфейса). Основной сценарий: текст или документ → уточнения → модель → ручной запуск TLC → объяснение того же отчёта → при необходимости явная правка правила и новая проверка. Полная схема — `GET /openapi.json`; снимок для тестов — `tests/fixtures/openapi.json`.

## Подключение и общие правила

- Сервер: `http://127.0.0.1:8000`, один процесс на одну SQLite-базу. CORS и раздача статики не подключены: для отдельного dev-сервера фронтенда нужен proxy на `/api`, `/health`, `/ready`.
- Тела JSON запрещают неизвестные поля. Ошибка: `{"error":{"code","message","details"}}`; у `422 INVALID_REQUEST` в `details` — `path`, `type`, `message` без введённых данных.
- Создающие POST требуют `Idempotency-Key` (1–128 символов). Повтор того же ключа с тем же телом возвращает первоначальный ответ без повторного выполнения, даже если состояние диалога уже изменилось; другое тело с тем же ключом — `409 IDEMPOTENCY_CONFLICT`. Для нового действия нужен новый ключ.
- `202` означает, что запуск принят. Результат приходит через `GET /api/runs/{run_id}` и SSE. Асинхронная ошибка видна в `Run.error_code`, а не в HTTP-статусе исходного POST.
- `GET /ready` → `{status:"ready", checker:"TLC", llm_provider:"codex"|"openai"|null, agent_configured:boolean}`. `agent_configured` означает наличие настройки (CLI Codex найден или задан ключ), а не успешную авторизацию.

## Маршруты

Новые и изменённые отмечены **жирным**.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `POST /api/sessions` | `{title, mode?}` + ключ | `201 Session` |
| `GET /api/sessions/{sid}` | — | `200 SessionDetail` (**+ `documents: DocumentInfo[]`**) |
| `POST /api/sessions/{sid}/sources` | `{text, requirements?}` + ключ | `201 Source` |
| **`POST /api/sessions/{sid}/documents`** | `multipart/form-data`, поле `file` + ключ | `201 DocumentUpload` |
| **`POST /api/sessions/{sid}/messages`** | **`MessageCreate`** + ключ | `202 Run` (agent) |
| **`GET /api/sessions/{sid}/dialogue`** | — | `200 DialogueView` |
| **`POST /api/sessions/{sid}/pending/retry`** | без тела + ключ | `202 Run` (agent) |
| **`POST /api/sessions/{sid}/pending/discard`** | без тела | `200 DialogueView` |
| `GET /api/runs/{run_id}` | — | `200 Run` |
| `POST /api/runs/{run_id}/cancel` | без тела | `202 Run`; повтор допустим |
| `GET /api/runs/{run_id}/events` | `Last-Event-ID?` | `200 text/event-stream` |
| `GET /api/sessions/{sid}/models` | — | `200 Model[]` |
| `GET /api/models/{mid}/versions[/{n}]` | — | `200 ModelVersion[]` / `ModelVersion` |
| `POST /api/models/{mid}/versions` | `{spec, parent_id?}` + ключ | `201 ModelVersion` (ручная правка) |
| **`POST /api/models/{mid}/versions/{n}/checks`** | `{property_ids?, limits?, explain?}` + ключ | `202 Run` (check) |
| **`GET /api/checks/{run_id}`** | — | `200 {run, results, explanation}` |
| **`POST /api/checks/{run_id}/explanation`** | без тела + ключ | `202 Run` (explain) |
| `GET /api/checks/{run_id}/artifacts[/{name}]` | — | список файлов / bytes |

## DTO

```ts
type MessageCreate =
  | {text: string; question_id?: string}   // ответ в диалоге; question_id — адресный ответ одному открытому вопросу
  | {source_id: string};                   // начать разбор с сохранённого источника (документа или POST /sources)

type DocumentInfo = {source_id: string; filename: string; format: "txt"|"md"|"docx";
  media_type: string; size_bytes: number; sha256: string; characters: number};
type DocumentUpload = {source: Source; document: DocumentInfo};

type Question = {id: string; text: string; reason: string; kind: "missing"|"conflict"|"assumption";
  assumption: string|null; status: "open"|"answered"|"confirmed"|"rejected"; answer_source_id: string|null};

type DialogueView = {
  session_id: string;
  status: "not_started"|"needs_clarification"|"model_incomplete"|"ready"|"limit_reached";
  round: number|null; max_rounds: number|null;
  reply: string|null;                       // последний ответ аналитика пользователю
  requirements: ({code: "R1"|"R2"|...} & ExtractedRequirement)[];  // id, text, source_refs[{source_id,quote,start,end}]
  questions: Question[]; open_question_ids: string[];
  corrections: {requirement_id; reason; quote; answer_source_id}[];  // явные правки правил пользователем
  analysis: object|null;                    // полный разбор: subject, entities, participants, variables, events,
                                            // properties, assumptions, contradictions, missing_information, model_issues, behavior
  model: {model_id; version_id; number; spec_hash}|null;  // версия, построенная из текущего разбора
  pending: {source_id; text; question_id: string|null; run_id: string|null;
            run_state: "queued"|"running"|"cancelling"|"failed"|"cancelled"|"completed"|null}|null;
};

type CheckRequest = {property_ids?: string[]|null; limits?: CheckLimits; explain?: boolean /* default false */};
type CheckLimits = {timeout_seconds?: number /* (0,3600], 30 */; max_states?: number /* 1..2147483647, 100000 */;
                    max_depth?: number|null /* 0..2147483646 */};
type CheckRun = {run: Run; results: VerificationResult[]; explanation: ExplanationView};
type ExplanationView = {state: "not_requested"|"queued"|"running"|"ready"|"failed"|"cancelled";
  run_id: string|null; error_code: string|null; narrative: VerificationNarrative|null};
type VerificationNarrative = {summary: string; question: string|null;
  properties: {property_id: string; explanation: string; hypotheses: string[];
               steps: {number: number; explanation: string}[]}[]};
```

`analysis.behavior` и `ModelVersion.spec` — BehavioralModel 1.0. Модель содержит только исходный текст и те ответы, на которые ссылаются её требования: вопрос пользователя без новых правил не меняет `spec_hash` и не создаёт версию.

`narrative.properties[i].steps[j].number` совпадает с `results[i].trace[j].number`; сервер отклоняет объяснение с выдуманными свойствами или шагами. `hypotheses` — неподтверждённые гипотезы, показывать с такой пометкой.

## Шесть статусов проверки

| Статус | `conclusive` | Смысл для пользователя |
|---|---|---|
| `PROPERTY_HOLDS` | true | Свойство выполнено во всех состояниях этой конечной модели и лимитов. Для `reachable` в `trace` — путь-свидетель |
| `PROPERTY_VIOLATED` | true | Найдено нарушение, `trace` — контрпример |
| `MODEL_INVALID` | false | Модель отклонена до TLC; `message` указывает путь ошибки |
| `TIMEOUT` | false | Время вышло, вывода нет |
| `STATE_LIMIT_REACHED` | false | Достигнут `max_states`/`max_depth`, вывода нет |
| `ENGINE_ERROR` | false | Сбой Java/TLC или отмена (`message` начинается с `CANCELLED:`), вывода нет |

Только первые два — вывод о свойстве. Остальные никогда не означают «нарушений нет». `related_requirements` — ID требований из `spec.requirements`, связанных со свойством и переходами трассы. `mode:"test"` — тестовый адаптер, не TLC.

## Основной сценарий для клиента

`SessionDetail.messages` — служебная история агента с внутренними JSON-обёртками; экран диалога строится по `GET /dialogue`.

1. `POST /sessions` → `sid`.
2. Текст: `POST /messages {text}`. Документ: `POST /documents` (файл) → `source.id`, затем `POST /messages {source_id}`.
3. Подписаться на SSE agent run. По `run_finished` прочитать `GET /dialogue`.
4. Пока `status = needs_clarification`: показать `open_question_ids`; ответ на конкретный вопрос — `POST /messages {text, question_id}`; общий ответ — без `question_id`.
5. `status = ready` и `model != null`: показать модель (`GET /models/{model_id}/versions/{number}`). TLC не запускается автоматически.
6. Кнопка «Проверить»: `POST /models/{mid}/versions/{n}/checks {"explain": true}` + ключ. SSE check run: `check_started`, `check_finished` (статусы свойств), `explanation_queued` (`explanation_run_id`), `run_finished`. Затем `GET /checks/{id}`: `results` уже окончательны; `explanation.state` идёт `queued → running → ready|failed`. За объяснением можно следить по SSE `explanation_run_id` либо опросом `GET /checks/{id}`.
7. Вопрос о результате в чате (`POST /messages {text}`) получает отчёт проверки текущей версии и сохранённое объяснение; ответ — в `message_delta`/`reply`.
8. Правка правила только явной фразой пользователя; аналитик записывает её в `corrections` с цитатой, создаётся новая версия (`model_proposed.changed = true`). Далее снова кнопка «Проверить» для новой версии. Результаты прежней версии сохраняются в её check run.

## SSE

`data:` содержит полный envelope `{event_id, run_id, session_id, type, data}`; `event_id` начинается с 1 в каждом run. Слушать именованные события (`addEventListener`), пропускать повторы по `(run_id, event_id)`. Поток закрывается сервером после отправки `run_finished`.

| Событие | Run | `data` |
|---|---|---|
| **`dialogue_updated`** | agent | `{status, round, open_question_ids, version_id}`; полное состояние — `GET /dialogue` |
| `clarification_requested` | agent | `Question` для каждого открытого вопроса |
| `model_proposed` | agent | `{model_id, version_id, number, **spec_hash, changed**}`; `changed:false` — ход не изменил модель, версия прежняя |
| `message_delta` | agent | `{text}` — ответ аналитика (`reply`), одним фрагментом; если LLM не дал ответа — краткая сводка состояния |
| `check_started` | check | `{check_run_id, version_id}` |
| `check_finished` | check | `{check_run_id, version_id, **results:[{property_id,status,conclusive}]**}` |
| **`explanation_queued`** | check | `{check_run_id, explanation_run_id}` |
| **`explanation_started`** | explain | `{check_run_id, version_id}` |
| **`explanation_ready`** | explain | `{check_run_id, version_id, narrative}` |
| `error` | любой | `{code, message}` перед `run_finished`, если есть `error_code` |
| `run_finished` | любой | `{state}` |

Порядок в agent run: `dialogue_updated`, `clarification_requested`*, `model_proposed`?, `message_delta`, `run_finished`.

## Объяснение и повтор

- Отчёт TLC сохраняется до любого вызова LLM. Сбой объяснения не меняет `results` и `run.state` проверки.
- Объясняется отчёт неизменяемой проверенной версии: запрос к LLM строится из сохранённого запроса проверки, а не из текущего состояния диалога или новых версий.
- Повтор: `POST /api/checks/{id}/explanation` с новым ключом. TLC не запускается. Коды: `409 CHECK_PENDING` (нет отчёта или проверка не `completed`), `409 NOT_EXPLAINABLE` (ядро не запускалось: `executed=false`), `409 EXPLANATION_ACTIVE`, `409 EXPLANATION_READY`, `429 QUEUE_FULL`.
- `explain:true` после отчёта ставит объяснение в очередь автоматически. Если очередь заполнена, `explanation.state = not_requested` — кнопка «Объяснить» делает тот же POST.
- Ошибки объяснения в `explanation.error_code`: `EXPLANATION_FAILED`, `INVALID_EXPLANATION` (LLM дважды вернул объяснение, не совпадающее с отчётом), `PROVIDER_*`, `RUN_TIMEOUT`, `SERVER_RESTARTED`, `CANCELLED`.

## Незавершённый ход, отмена и восстановление

Ход аналитика сначала сохраняет сообщение пользователя как pending, затем вызывает LLM. Исход определяется так:

| Что произошло | Run | Pending | Что делать клиенту |
|---|---|---|---|
| Пользователь нажал «Отменить» (`POST /runs/{id}/cancel`) | `cancelled`, `CANCELLED` | удаляется, история сохраняется | Можно сразу отправить другое сообщение |
| Сбой провайдера, лимит, таймаут | `failed`, `PROVIDER_*`/`RUN_TIMEOUT`/`MODEL_OUTPUT_INVALID`… | сохраняется | `pending/retry` или `pending/discard` |
| Остановка сервера во время хода | `cancelled`, `SERVER_SHUTDOWN` | сохраняется | после запуска `pending/retry` или `pending/discard` |
| Перезапуск после аварии | `failed`, `SERVER_RESTARTED` | сохраняется | то же |
| Обрыв SSE / закрытие вкладки | run продолжается | — | переподключиться к SSE |

- Пока есть pending, новое сообщение с другим текстом сразу получает `409 PENDING_MESSAGE` (до создания run). То же сообщение тем же текстом и `question_id` с новым ключом продолжает ход — прежнее поведение сохранено.
- `pending/retry` → `409 NO_PENDING`, если продолжать нечего; `409 SESSION_BUSY`, если активен agent run.
- `pending/discard` идемпотентен, возвращает `DialogueView`; при активном run — `409 SESSION_BUSY` (сначала отмена).
- `DialogueView.pending.run_state = "running"` означает, что ход ещё выполняется; кнопки повтора показывать не нужно.

## Ошибки отправки сообщения

`409 SESSION_BUSY` — в сессии уже идёт ход; `409 PENDING_MESSAGE`; `409 DIALOGUE_STARTED` — `source_id` допустим только для начала разбора; `409 CLARIFICATION_LIMIT` — исчерпан лимит раундов; `409 DIALOGUE_FORMAT` — сессия в старом формате; `422 UNKNOWN_QUESTION` — `question_id` не среди открытых; `422 INVALID_REQUEST` — нужен ровно один из `text`/`source_id`, `question_id` только с `text`; `422 INPUT_LIMIT`; `404 NOT_FOUND`/`SOURCE_NOT_FOUND`.

Коды неудачного agent run: `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_FOUND`, `PROVIDER_ERROR`, `PROVIDER_TIMEOUT`, `PROVIDER_TOOL_USE`, `PROVIDER_ISOLATION`, `CONTEXT_LIMIT`, `TURN_LIMIT`, `RUN_TIMEOUT`, `MODEL_OUTPUT_INVALID`, `PENDING_MESSAGE`, `NO_PENDING`, `AGENT_FAILED`, `CANCELLED`, `SERVER_SHUTDOWN`, `SERVER_RESTARTED`. Текст ответа провайдера в ошибки не попадает.

## Загрузка документов

`POST /api/sessions/{sid}/documents`, `multipart/form-data`, одно поле `file`, `Idempotency-Key`. Файл не сохраняется на диск: извлечённый текст становится обычным `Source`, происхождение — в `DocumentInfo`.

- Формат по расширению имени: `.txt`, `.md`/`.markdown` — UTF-8 (BOM допускается, переводы строк приводятся к `\n`); `.docx` — текст абзацев, табуляций, переносов и ячеек таблиц из `word/document.xml`; удалённый в рецензировании текст не включается.
- Ограничения: тело до `PROVERYALKA_MAX_DOCUMENT_BYTES` (5 МиБ) — проверяется по `Content-Length` до разбора, иначе `413 DOCUMENT_TOO_LARGE` (`411 LENGTH_REQUIRED` без заголовка); текст до `PROVERYALKA_MAX_INPUT_CHARS`; в DOCX не более 2000 частей и 20 МиБ распакованного `document.xml`; DTD и сущности запрещены; зашифрованный DOCX не поддерживается.
- Ошибки: `415 UNSUPPORTED_DOCUMENT`, `422 DOCUMENT_ENCODING`, `422 DOCUMENT_EMPTY`, `422 DOCUMENT_INVALID`, `422 INPUT_LIMIT`, `413 DOCUMENT_TOO_LARGE`.
- `filename` — только подпись: путь клиента отбрасывается, непечатаемые символы удаляются, до 200 символов.
- Повтор ключа с тем же файлом возвращает тот же `source`; другой файл с тем же ключом — `409`.

## LLM-провайдер

`PROVERYALKA_LLM_PROVIDER` выбирает исполнителя аналитика; клиенту выбор не виден, кроме `/ready.llm_provider`.

- `codex` (локальный вариант по умолчанию в `.env.example`): приложение само запускает отдельный `codex app-server --listen stdio://` на время запроса, авторизация — уже выполненный `codex login` с подпиской ChatGPT. Токены приложение не читает. Поток эфемерный, рабочий каталог — пустой временный, sandbox `read-only` без сети, MCP-серверы, плагины, hooks, память, shell и браузер отключены только для этого процесса; изоляция проверяется до запроса к модели. Любая попытка действия вместо ответа прерывает ход (`PROVIDER_TOOL_USE`). Настройки: `PROVERYALKA_CODEX_BIN`, `PROVERYALKA_CODEX_MODEL`, `PROVERYALKA_CODEX_EFFORT` (по умолчанию — значения из конфигурации Codex пользователя).
- `openai`: OpenAI-совместимый Responses API по `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`. Endpoint МАИ отложен: TLS-цепочка `Russian Trusted Root CA` не проходит проверку на этом Mac, автоматического переключения на него нет.

Ответ любого провайдера проходит ту же Pydantic-валидацию, строится BehavioralModel, проверку выполняет только TLC.

Ограничение `codex`: глобальный `~/.codex/AGENTS.md` пользователя Codex подключается к инструкциям потока (Codex сообщает его в `instructionSources`); инструкции аналитика передаются как developer instructions и задают формат ответа. Время хода в live-проверке — 14–20 с на `PROVERYALKA_CODEX_EFFORT=medium`.

## Публичная история диалога

`GET /api/sessions/{sid}/dialogue` дополнен `entries`: упорядоченные фактические реплики со стабильными `id`, `sequence`, `created_at`, `kind: user|assistant`, `text`. По наличию сохраняются `source_id`, `question_id`, `status: processed|pending|discarded`; `questions` у ответа содержит открытые вопросы того сохранённого хода. Их текущие состояния доступны в верхнем `questions`.

Проекция читает сохранённые ходы и ответы аналитика, исключает служебные SDK/tool и verification wrappers, не меняет raw history. Повтор незавершённого хода сохраняет идентичность пользовательской реплики. Отмена/отказ отмечается `discarded`; после refresh порядок и исходный текст остаются теми же. Источники без фактического хода не превращаются в выдуманную историю чата. Все ранее существовавшие поля `/dialogue` сохранены.

### Ход работы агента

`GET /api/sessions/{session_id}/agent-runs?limit=50&before=<cursor>` возвращает новые запуски первыми: `{runs:[AgentRunTrace],next_cursor}`. `limit` от 1 до 100; курсор следующей страницы остаётся устойчивым при появлении новых запусков. Проекция ограничена выбранной сессией и не содержит request_json, SDK traffic, prompt, raw output или private reasoning. У text output остаётся число символов; настоящий ответ виден в dialogue.entries.

Каждый trace содержит публичный run, точные input_entry_id/reply_entry_id, source_id, сохранённые created_at/started_at/finished_at, events и events_truncated. Неизвестные timestamps старых запусков остаются null. Новые SSE events имеют created_at с UTC offset. Новый тип activity содержит factual phase: queued, started, context_ready, model_request, model_response, validation, retry, saving, file_context_ready, answer_ready. У validation есть outcome passed/failed; у model requests - номер попытки и purpose. Никакого восстановленного задним числом плана.

Трейс хранится в существующем run_events. Отдельной миграции нет. История связывается по сохранённым markers/IDs, в том числе после retry, и доступна без browser-local run IDs. Страница возвращает до 200 событий на запуск и явно устанавливает events_truncated при превышении. Старые произвольные tool/provider payloads не проецируются. Вызов модели выполняется прежним исполнителем; трейс не добавляет provider requests, инструменты или новый агентный цикл.
