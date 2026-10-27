# Серверный контракт (#20)

## Запуск

Python 3.9+ (для разработки проверено на 3.9). Из корня:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m pytest
.venv/bin/python -m uvicorn proveryalka.app:app --host 127.0.0.1 --port 8000
```

`GET /health` проверяет HTTP-процесс, а не готовность LLM/TLC. `/docs` и
`/openapi.json` публикуют контракт. Снимок `docs/openapi.json` создаётся командой:

```sh
.venv/bin/python -c 'import json; from proveryalka.app import create_app; print(json.dumps(create_app().openapi(), ensure_ascii=False, indent=2))' > docs/openapi.json
```

`Settings.from_env()` читает пути из `.env.example`; файл `.env` автоматически
не загружается. Пока нет аутентификации, сервер предназначен для локального
использования; идентификатор сессии не является авторизацией пользователя.

## Границы реализации

В #20 созданы HTTP-контракты и интерфейс `Backend.call(operation, **arguments)`.
Неподключённый компонент отвечает 503 `COMPONENT_UNAVAILABLE`; он не имитирует
запуск агента или успешную проверку. Тестовый адаптер `RecordingBackend` в тестах
показывает способ независимой разработки клиента и адаптеров.

Общие `BehavioralModel` и `VerificationResult` из #1 ещё отсутствуют. Передайте
их настоящие классы в `create_app(behavioral_model=..., verification_result=...)`:
OpenAPI и входная валидация будут использовать их напрямую. DSL здесь не
дублируется. До подключения классов поле `spec` — непрозрачный JSON-транспорт,
создание версий и проверки возвращают 503 `CONTRACT_UNAVAILABLE`. **Пункт #20 о
подключении общих схем остаётся заблокирован #1.** #22–25 подключат реализацию
версий, проверок, агента и диагностических файлов; SSE пока только контракт.

## Идентификаторы, повторные запросы, ошибки

ID — непрозрачные строки; `number` — номер версии внутри модели. `run_id` —
идентификатор выполнения, не ID версии и не один из шести статусов TLC.
Жизненный цикл: queued → running → completed/failed, при отмене
queued/running → cancelling → cancelled. `completed` означает завершение работы,
а не доказанность свойства. Статусы проверки принадлежат общему контракту #1.

Каждый создающий POST требует `Idempotency-Key` (1–128 символов). Адаптер сохраняет
ключ, каноническое тело и ответ в одной транзакции. Область ключа — операция и её
родительская сущность; для создания сессии — всё локальное приложение. Повтор с
тем же ключом/телом возвращает прежний ID и ответ; изменённое тело — 409
`IDEMPOTENCY_CONFLICT`. Новый ключ создаёт новую операцию. Approve и cancel
идемпотентны по самой целевой сущности.

Ошибки: `{"error":{"code":"NOT_FOUND","message":"...","details":[]}}`.
404 — неизвестная сущность либо несоответствие родителя; 409 — конфликт;
422 — ошибка запроса (путь поля без отражения входного текста);
503 — неподключённый компонент. Реальная семантическая ошибка модели относится
к `MODEL_INVALID` из #1, а не HTTP-валидации транспорта.

## Основные запросы

```sh
curl -X POST http://127.0.0.1:8000/api/sessions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: session-1' \
  -d '{"title":"Заявка","mode":"analyzer"}'
curl 'http://127.0.0.1:8000/api/sessions?limit=50&offset=0'
curl -X POST http://127.0.0.1:8000/api/sessions/SESSION_ID/messages \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: message-1' \
  -d '{"text":"Отменённую заявку выполнять нельзя"}'
```

Создание сообщения/проверки возвращает **202 и Run**, затем клиент читает
`GET /api/runs/{run_id}` и `GET /api/checks/{run_id}`. Пример результата в README
иллюстрирует содержимое результата, не синхронный ответ POST. Проверка версии
не требует её предварительного утверждения. Файлы доступны только через
`GET /api/checks/{run_id}/artifacts/{name}`, где name — имя из разрешённого
манифеста конкретного запуска, а не путь. Реализация и защита путей — #25.

## Отмена и SSE (#24, #27)

`POST /api/runs/{run_id}/cancel` возвращает 202 с фактическим состоянием Run.
`cancelling` не подтверждает остановку: `cancelled` допустим только после
завершения инструмента и сохранения результата. Завершённый run не изменяется.
Отмена не создаёт ложный `PROPERTY_HOLDS`; причина остановки хранится отдельно.

`GET /api/runs/{run_id}/events` — `text/event-stream`. Сохранённые event_id
монотонны внутри run. При `Last-Event-ID: N` сервер повторяет события > N,
потом продолжает поток; клиент устраняет дубли по (run_id, event_id). Событие
не запускает работу повторно. Неизвестный run — 404; курсор впереди истории или
удалённая история — 409, клиент перечитывает run. Разрыв соединения не отменяет
работу. Heartbeat — комментарий SSE без event_id.

```text
id: 1
event: message_delta
data: {"event_id":1,"run_id":"r1","session_id":"s1","type":"message_delta","data":{"text":"Уточните"}}

```

Конверт Event опубликован в OpenAPI. Payload: message_delta — text;
clarification_requested — question и options; model_proposed — model_id,
version_id, number; check_started/check_finished — check_run_id и version_id;
run_finished — state; error — code/message. Эти поля должен валидировать
адаптер #24; текущий транспорт Event не подменяет будущие типы payload.
