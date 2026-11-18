# Контракт интеграции #46

Issue: https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/46

Ветка `t3/repository-import-snapshots`, base `t3/frontend-live-documents-tests`.
Исходный HEAD `393ac0e`; по указанию интегратора перед full suite добавлен
`fe3e5ca` как `2185f81` (изоляция cleanup/cancel контейнеров). Frontend/PR66 не изменялись.

## Реализация

В PR входят `sources/repositories/{dto,policy,transport,index,service}.py`,
`api/repositories.py`, `storage/repositories.py`, migration
`008_repository_snapshots.sql`, три test modules и README модуля.
Номер 008 подтверждён root; 007 зарезервирован #45, 009 — при необходимости #49.
Общие `app.py`, `contracts.py`, `storage/sqlite.py`, `pyproject.toml` не менялись.

Точный additive wiring находится в `integration.patch` и проверен
`git apply --check` относительно HEAD393ac0e + infra fix. Патч:

1. `app.py`: добавляет server-only конфигурацию limits/hosts/credential provider,
   создаёт `RepositoryService`, подключает его initialize к lifespan после store,
   монтирует router и сохраняет service в `app.state.repositories`.
2. `storage/sqlite.py`: добавляет migration 008 в registry и увеличивает schema ceiling
   с 6 до 8. При объединении с #45 **сохранить также его 007 entry** в этом же registry;
   патч сгенерирован на base без 007 и не должен заменить entry, добавленный соседом.
3. `contracts.py`/dependencies: изменений не требуется. Используется существующий
   `Source{kind:"text"}`; новые DTO локальны. Runtime HTTP transport — stdlib.

Роутер использует существующие error handlers. Для external `backend=` без SQLite
production patch не монтирует маршруты. В tests роутер отдельно монтируется на
изолированный app, с настоящим SQLite/ApplicationBackend/run_analyst lifecycle.

## Consumer DTO для #47 MCP и frontend

Импорт: `RepositoryImport{remote_url,ref="HEAD",credential_ref?:registered-reference}`.
Обновление: `RepositoryRefresh{ref="HEAD",credential_ref?}`; URL наследуется от parent.
Снимок: `RepositorySnapshot{id,session_id,remote_url,commit_sha,manifest_sha256,
parent_snapshot_id,created_at,policy_version,files,excluded}`.
Индекс: `RepositoryFile{path,sha256,size_bytes,lines,provenance_url}`.
Содержимое файлов в index response отсутствует.

Выбор: `RepositorySelection{manifest_sha256,files:[{path,sha256,start_line,end_line}]}`.
Диапазоны включительны, строки с 1, до 20 разных файлов.
Клиентский текст/host path/transport/лимиты в DTO запрещены.
Контекст: `RepositoryContext{snapshot_id,commit_sha,manifest_sha256,excerpts,source}`.
Excerpt дополнительно содержит `text,provenance_url,source_start,source_end`.
Offsets — Python/SourceRef character offsets, не UTF-8 bytes.
`RepositoryService.locate_reference(session_id,source_id,start,end)` переводит source
цитату обратно в commit/file/line/hash, проверив принадлежность и integrity.

Для MCP передавать готовый service, не запускать новый backend и не создавать hostpath
transport. Методы синхронные; вызов из async handler выносить в worker thread:

```python
snapshot = service.import_snapshot(session_id, import_dto, idempotency_key)
snapshot2 = service.refresh(session_id, snapshot["id"], refresh_dto, new_key)
context = service.materialize(session_id, snapshot["id"], selection_dto, context_key)
source = service.validate_source(session_id, context["source"]["id"])
run = service.analyze(session_id, snapshot["id"], selection_dto, analysis_key, backend)
```

`analyze` вызывает существующий `send_message` с server-created Source ID,
без нового LLM адаптера, provider config или новых endpoint/секретов.
Возвращается существующий durable `Run`; его проверяют через существующие run/events.
Сохранённый Source может начать только новый диалог: для уже начатой сессии backend
возвращает `DIALOGUE_STARTED`. Активный run/pending сохраняет существующие 409 semantics.
Это ограничение текущего аналитика отражено в контракте, без расширения его роли.

## Ошибки и безопасность

`REPOSITORY_URL_DENIED`, `REPOSITORY_ADDRESS_DENIED`, `REPOSITORY_REDIRECT_DENIED`
— 422; invalid archive/range — 422; missing/foreign snapshot — 404;
manifest/file/context mismatch — 409; size/file/context limits — 413;
deadline — 504; import concurrency — 429; DNS/HTTPS unavailable — 502/503.
Provider statuses 401/404 нельзя надёжно различить: 403 `REPOSITORY_ACCESS_REQUIRED`
явно означает missing repo/ref **или** необходимость авторизации.
403 upstream — `REPOSITORY_ACCESS_DENIED`, 429 — `REPOSITORY_RATE_LIMIT`.
Отсутствующий registered credential provider/reference —
403 `REPOSITORY_CREDENTIAL_UNAVAILABLE`; пустого успешного snapshot нет.

Production: only public HTTPS allowlisted GitHub/GitHub-compatible hosts; every DNS
answer must be public, numeric address pinned, verified TLS SNI; redirects bounded,
Authorization не передаётся другому host. Нет чтения Git config/netrc/profiles или
исполнения git/hooks/submodules/filters/repo code; tar не извлекается на host.
Test-only transport читает local Git tree/blob plumbing, без checkout/smudge.
Репозиторий не является системной инструкцией; в анализ идут выбранные ranges
из сохранённых bytes с серверной проверкой hash и provenance.

Предложения продуктовой политики и границы secret scanner перечислены в README
модуля: лимиты и conservative deny/allowlist v1 не выдаются за согласованную политику.
Private provider реального аккаунта, реальный LLM и браузер этим PR не проверялись.

## Доказательства

`evidence.md`, `public-smoke.json`, `targeted-tests.txt`, `backend-full.xml/txt`:
targeted72 PASS и один full suite419 PASS с обязательными TLC/sandbox, exit0.
Полный suite выполнен в согласованном слоте после #45, слот освобождён для delivery.
Live demos4180/4182/4183/4184/4185
не изменялись и не останавливались. Временный runtime/dependencies не создавались;
read-only venv/JAR использованы из `/private/tmp/prov-review`.
