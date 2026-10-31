# Репозитории как источники анализа

Модуль issue [#46](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/46):
read-only импорт GitHub-репозитория, immutable снимок commit SHA, индекс и выбранные
фрагменты для существующего аналитика. Production transport не вызывает `git`,
shell или инструменты из репозитория. Архив разбирается в памяти без filesystem extraction.

## Импорт и обновление

`RepositoryService(store, limits=RepositoryLimits(), host_policy=RepositoryHost(),
credential_provider=None)` использует существующий `SQLiteStore`.
После `store.initialize()` вызвать `service.initialize()`; migration
`008_repository_snapshots.sql` идемпотентна и добавляет отдельные таблицы.
Функция не меняет `PRAGMA user_version`; единый registry миграций подключает интегратор.
Новые DTO находятся в `dto.py`, общий `Source.kind="text"` сохраняется.

```python
service = RepositoryService(store)
service.initialize()
snapshot = service.import_snapshot(session_id, {
    "remote_url": "https://github.com/kiruha355/Proveryalka_vipolnyalka",
    "ref": "HEAD",
}, "repo-import-1")
next_snapshot = service.refresh(session_id, snapshot["id"], {"ref": "HEAD"}, "repo-refresh-2")
```

Сначала HTTPS API разрешает ref в полный commit SHA; архив запрашивается только по SHA.
Refresh всегда создаёт новый snapshot ID с `parent_snapshot_id`, даже если commit
не изменился. Старый снимок остаётся доступен после обновления и перезапуска.
Повтор того же idempotency key возвращает прежний результат без нового fetch;
изменённое тело с прежним ключом даёт `409 IDEMPOTENCY_CONFLICT`.
Snapshot содержит `remote_url`, `commit_sha`, `manifest_sha256`, `policy_version`,
`files[{path,sha256,size_bytes,lines,provenance_url}]`, счётчики исключений.
Manifest хеширует отсортированный индекс, commit, remote, policy и счётчики исключений.
Hash файла считается от исходных UTF-8 bytes; CRLF сохраняется, строки считаются по LF.

## Передача в анализ

Вход `RepositorySelection` не принимает клиентский текст, host paths, transport,
новые лимиты или инструкции. Клиент выбирает до 20 файлов и диапазоны:

```json
{
  "manifest_sha256": "<64 hex из snapshot>",
  "files": [{
    "path": "README.md",
    "sha256": "<64 hex из индекса>",
    "start_line": 2,
    "end_line": 12
  }]
}
```

`materialize(session_id, snapshot_id, selection, key)` проверяет принадлежность
сессии, manifest и текущий hash сохранённого содержимого. Возвращает
`RepositoryContext{snapshot_id,commit_sha,manifest_sha256,excerpts,source}`;
`excerpts` содержат диапазоны, текст, ссылку commit/file/line и `source_start/source_end`.
Сохраняются только выбранные фрагменты в обычном `Source`, с отдельной записью
`repository_source_contexts` для происхождения и integrity-check. В LLM не передаётся
весь индекс, архив или невыбранные файлы. По умолчанию суммарно до 48 KiB и 800 строк,
включая заголовки. Нельзя выбирать один файл несколько раз или выходить за конец файла.

`analyze(session_id,snapshot_id,selection,key,backend)` материализует контекст,
повторно сверяет его с серверным snapshot и вызывает существующий
`backend.call("send_message", session_id=..., body={"source_id":...}, key=...)`.
Это настоящий путь в `ApplicationBackend -> run_analyst -> start_dialogue`.
Его ограничения сохраняются: stored Source начинает новый диалог;
активный/незавершённый/начатый диалог даёт существующий `409`, без повторной LLM-инференции.
Для snapshot analysis требуется новая сессия, если диалог уже начат.

Можно отдельно сохранить `/context`, затем вызвать существующий
`POST /api/sessions/{id}/messages` с `source_id`. Для проверок перед таким вызовом
доступен `validate_source(session_id,source_id)` без дополнительных записей.
`locate_reference(session_id,source_id,start,end)` переводит `SourceRef` из аналитика
в `{snapshot_id,commit_sha,path,sha256,start_line,end_line,provenance_url}`.
Ссылка должна лежать внутри содержимого одного выбранного фрагмента;
цитата metadata/header не превращается в ложную ссылку на код.

Файлы остаются данными в user/source payload. Они не добавляются в system instructions;
существующая инструкция аналитика запрещает менять роль по исходным текстам.
Тесты подтверждают состав payload, а не устойчивость реального LLM к любому prompt injection.

## HTTP и потребители MCP/frontend

`create_repository_router(service,backend)` подключается к существующему FastAPI app.
Использует его error handlers и backend lifecycle, своего сервера не запускает.

| Метод | `/api/sessions/{session_id}/repositories` | Результат |
|---|---|---|
| POST | пустой suffix | `201 RepositorySnapshot` |
| GET | пустой suffix, `limit/offset` | список snapshot |
| GET | `/{snapshot_id}` | индекс snapshot |
| POST | `/{snapshot_id}/refresh` | новый snapshot |
| POST | `/{snapshot_id}/context` | `201 RepositoryContext` |
| POST | `/{snapshot_id}/analysis` | `202 Run` существующего аналитика |

POST требует `Idempotency-Key` 1–128 символов. MCP #47 может вызывать те же service
методы без HTTP loopback; передавать `session_id` и selection DTO, а не произвольный
код/инструкцию. Для `/analysis` ключи входят также в существующий scope `agent:{session_id}`;
использовать отдельный ключ для каждого намерения анализа.

## Ограничения транспорта и доступа

Первый поддерживаемый backend — GitHub archive API. `RepositoryHost` позволяет оператору
задать точные remote/API/archive hosts для GitHub-compatible публичного HTTPS сервиса.
GitLab/general Git/SCP/SSH/file transport не реализованы; настройки не принимаются от HTTP-клиента.
URL с credentials, query, fragment, портом, encoded traversal и чужим host отклоняются.
Каждый HTTP-hop проверяет allowlist и все DNS-ответы, запрещает private/link-local/loopback/
multicast/reserved и IPv6 transition addresses. Соединение идёт к уже проверенному
числовому адресу, TLS проверяет исходное имя. Proxy env, netrc и Git credentials не читаются.
Authorization снимается при смене host. Redirects ограничены четырьмя запросами.
DNS ожидание и вся HTTPS-операция имеют deadline; число resolver workers ограничено четырьмя.
Одновременно на service допускается два импорта.

`credential_ref` — зарегистрированная ссылка оператора, не token. Только внедрённый
`CredentialProvider.authorization(reference,canonical_remote)` может вернуть ephemeral
Authorization. Provider обязан сам проверить reference/remote scope; модуль не читает
профили, env secrets, ключи, конфигурацию аккаунтов. Без provider запрос с reference даёт
`403 REPOSITORY_CREDENTIAL_UNAVAILABLE`. Без reference public flow работает без секретов.
401/404 upstream возвращают `REPOSITORY_ACCESS_REQUIRED` (отсутствие repo/ref или private
access не различаются провайдером); 403 — `REPOSITORY_ACCESS_DENIED`, 429 — rate limit.
Ни одна ошибка доступа не превращается в успешный пустой snapshot.

Предлагаемые значения продуктовой политики v1: download 8 MiB, expanded tar 32 MiB,
индекс 4 MiB/1000 файлов, один текст 256 KiB, 5000 archive entries, fetch/index 30 секунд.
Серверные лимиты меняются через `RepositoryLimits`, не через репозиторий.
SQLite использует существующий transaction timeout до 10 секунд отдельно от fetch/index.
Превышение размера/числа допустимых файлов отклоняет импорт целиком: нет скрытого усечения.
Небезопасные/повторные paths также отклоняют архив целиком. Symlinks, hardlinks, special files,
submodules и LFS pointers не читаются; hooks, filters и код не выполняются.

Обязательные исключения: `.git`, `.env*`, credentials, runtime caches, dependencies,
бинарные и не-UTF-8 файлы. Дополнительное консервативное предложение v1 — allowlist текстовых
расширений, исключение lock-файлов, build/cache каталогов и целого файла при совпадении
с шаблоном секрета. Полный список в `policy.py`, причины видны в счётчиках без содержимого
или потенциально чувствительных filenames исключённых файлов. Scanner распознаёт private
keys, известные token formats, JWT, Bearer, credential URLs и именованные secret assignments.
Он не может доказать отсутствие произвольно названного секрета в обычном тексте;
это ограничение deterministic scanner, а не гарантия DLP. Provider-level LLM проверки не запускались.

## Проверки

```sh
PYTHONPATH=src /private/tmp/prov-review/.venv/bin/python -m pytest -q \
  tests/test_repositories.py tests/test_repositories_http.py tests/test_repositories_transport.py
```

Fixtures используют реальные git commit/tree/blob через фиксированные plumbing команды,
без checkout и smudge filters. Local transport определён исключительно в tests;
production API не принимает host path. HTTP testapp подключает роутер отдельно, настоящий
SQLite/ApplicationBackend/run_analyst и scripted `generate_state`; Docker для этих тестов отключён.
Production wiring patch и точные результаты находятся в
`reports/project-review-20261031/sokolov/repositories/`.
