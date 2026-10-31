# Веб-клиент Проверялки

React + TypeScript + Vite. Чат показывает публичную историю `/dialogue.entries`, требования и точные цитаты источников, неизменяемые версии модели, диаграмму этапов, проверку всех правил, трассу и объяснение. Генератор и файлы подключаются из `../frontend-extensions/`.

## Запуск

Требуются Node.js/npm и Python-окружение backend. Используется установленная версия Node с поддержкой Vite 8. Backend запускается одним worker; подготовка Java/TLC и параметры провайдера описаны в `../src/proveryalka/api/README.md` и `../src/proveryalka/checker/README.md`.

```sh
npm ci --prefix frontend
npm ci --prefix frontend-extensions
# В отдельном терминале, из корня репозитория:
PROVERYALKA_PYTHON=.venv/bin/python scripts/run-server.sh
# Веб-клиент:
PROVERYALKA_API_TARGET=http://127.0.0.1:8000 npm --prefix frontend run dev
```

`PROVERYALKA_UI_PORT` задаёт порт Vite. `/api`, `/ready`, `/health`, `/openapi.json` идут через proxy: отдельный CORS не нужен. `VITE_API_BASE_URL` задаёт другой origin при наличии CORS или reverse proxy. В окне подключения можно выбрать сервер; провайдер генерации использует тот же адрес. React расширений объединён с экземпляром ядра через `resolve.dedupe`.

Рантайм агента использует GPT через поддержанный backend Codex subscription provider; параметры и авторизация находятся на сервере, клиент ключи не хранит. `agent_configured=false` блокирует отправку аналитических сообщений. `true` означает наличие конфигурации, успешная авторизация проверяется реальным вызовом. MAI endpoint не требуется.

```sh
VITE_PROVERYALKA_ADAPTER=demo npm --prefix frontend run dev
```

Демо использует сохранённые модели и настоящие ранее записанные отчёты TLC. Оно не вызывает LLM/TLC и не воспроизводит вымышленные уточнения. В примере на enum-статусах исходная реплика берётся из fixture source и явно подписана. Отдельный чат «Живой диалог: запись прогона» содержит пять настоящих сохранённых GPT subscription ходов из `backend-acceptance/01..05-turn.json`, две boolean-модели и их TLC-отчёты. Исходные ID, spec_hash и цитаты сохранены; virtual message IDs выведены из run_id+role, неизвестные времена сообщений не выдуманы. Файлы/генерация в демо скрыты; запись отдельного модуля файлов находится в `frontend-extensions/reports/`. Выбранный адаптер сохраняется в браузере; окно подключения позволяет его сменить.

## Поведение

- TXT/MD/DOCX загружается скрепкой, в том числе из нового чата. Загрузка сохраняет источник и имя файла; разбор начинается отдельным действием «Разобрать документ». Backend разрешает `source_id` для начала диалога; новый документ после начала разбора требует нового чата. Ошибка файла сохраняет текстовый draft.
- Уточнение отправляется с `question_id`. Незавершённый ход можно повторить через `/pending/retry` или отбросить через `/pending/discard`. При явной отмене пользовательская реплика остаётся с соответствующим статусом. Retry не дублирует реплику.
- «Проверить» отправляет `property_ids:null, explain:true`: все правила выбранной версии, серверные лимиты. Их диагностика доступна в деталях результата. Отчёт показывается до объяснения; объяснение отслеживается отдельным SSE run и повторяется без TLC.
- TIMEOUT, STATE_LIMIT_REACHED, MODEL_INVALID, ENGINE_ERROR не означают, что правило выполнено. Неизвестная статистика остаётся неизвестной. Версия, spec_hash и отчёт связываются до отображения трассы/объяснения.
- Подтверждение означает, что выбранная модель отражает требования для последующей генерации. Оно не доказывает результат TLC. Правка создаёт новую неподтверждённую версию; старые отчёты не изменяются.
- Границы списка чатов и рабочей области перемещаются указателем или клавишами ←/→, Shift ускоряет, Home/End выбирают границы. Доли сохраняются; на узком экране работают переключатели панелей.
- Граф можно развернуть отдельной кнопкой. Escape/«Закрыть диаграмму» возвращает прежний фокус; выбор и шаг трассы сохраняются. «Вписать граф» меняет масштаб.
- Действия обсуждения контрпримера дополняют draft и переводят фокус в чат, без отправки или правки модели. Старый выбранный отчёт явно отделён в тексте от server latest; draft не затирается.
- Разрешение `allow_unverified` — существующая возможность генератора и отдельное продуктовое решение, ещё не принятое пользователем.

## Проверки

```sh
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend-extensions run check
frontend-extensions/scripts/check-host-types.sh frontend
# На отдельном backend с изолированной БД, Java/TLC и Docker:
PROVERYALKA_HTTP_TEST_URL=http://127.0.0.1:5294 npm --prefix frontend test -- src/api/live-http.test.ts
```

На 31.10.2026: frontend 33 PASS; ранее отдельный live HTTP adapter scenario PASS (TLC bug→fixed, подтверждение, генерация, файлы/ZIP, Docker pytest 79 PASS). Extensions 107 PASS, typecheck/library/host types PASS. Backend 344 PASS с `PROVERYALKA_REQUIRE_TLC=1` и `PROVERYALKA_REQUIRE_SANDBOX=1`. Live test пропускается без `PROVERYALKA_HTTP_TEST_URL`; обычный unit/component набор не выдаётся за его результат.

Это разные уровни доказательств: jsdom/components, настоящий HTTP/TLC/Docker и автономные HTML-снимки. Полный browser + GPT + TLC + генерация пользовательский E2E в этом прогоне NOT_RUN. Серверный GPT-сценарий предыдущего исполнителя — отдельное supplied evidence. Визуальная приёмка пользователем pending.
