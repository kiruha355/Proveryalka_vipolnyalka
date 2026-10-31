# Проверка MCP #47

31.10.2026, macOS, Codex/T3 implementation. Ветка `t3/mcp-streamable-http-server`,
base `t3/frontend-live-documents-tests` / исходный HEAD `393ac0e`.

## Выполнено

Реальный Streamable HTTP через официальный `mcp==2.3.0`, versioned schema 1.0,
локальный access boundary, get_model/check_behavior/get_tests/compare_with_code.
`compare_with_code` поддерживает только immutable stored generation + model ref + code_hash;
произвольная/изменённая реализация не получает заключение о соответствии.

- SDK loopback: настоящий TCP uvicorn/FastAPI, `ClientSession.initialize`, `list_tools`,
  `call_tool`; также современный `Client` без protocol sessions.
- Правила доступа: optional bearer positive/negative, Origin invalid/null/explicit allowlist,
  Host, loopback peer и недоверенный X-Forwarded-For. Личные профили/токены не читались.
- Request/body/time/parallel limits: Content-Length и chunked overflow, slow-body timeout,
  HTTP concurrency, tool concurrency, tool deadline; schema version/extra fields, unknown
  protocol, wrong/deleted session, negotiated session version, session capacity.
- Immutable reference/hash: tests из реально сохранённой генерации, проверка каждого SHA-256,
  отказ при model/version/hash mismatch и повреждении сохранённого файла.
- Cancellation: официальный SDK legacy notification и modern stream close доходят до
  обычного cancel_run; durable run финализируется cancelled. Для compare отмена проходит
  существующий CodegenService stop. Fixture checker/sandbox здесь — component evidence,
  не доказательство настоящего TLC/контейнера.
- Technical statuses: TIMEOUT/STATE_LIMIT_REACHED/ENGINE_ERROR/MODEL_INVALID сохраняются
  inconclusive/error; отсутствие Docker — engine_unavailable с null counts;
  TESTS_FAILED отделён от OOM/NO_TESTS/PYTEST_EXIT_3.
- Реальный TLC: order_fixed, три свойства, PROPERTY_HOLDS, mode=engine/executed=true,
  engine=TLC. Отчёт сохранён в `real-tlc.json`.
- Реальный Docker через MCP compare_with_code: тесты той же generation, 79/79,
  no network/read-only/user 10001/resource caps. Полный MCP результат с моделью/hash,
  durable test_run и отдельным `tlc_at_generation` — `real-docker-comparison.json`.
- Изолированный integration-helper test: host start/close, health route и MCP initialize;
  основной app.py не изменён. Конкретные wiring/dependency patches проверены `git apply --check`.

## Окружение и команды

Venv `/private/tmp/prov-review/.venv` использована read-only; PYTHONPATH указывает на этот
worktree, не на editable старого checkout. Ни зависимостей, ни Docker images не устанавливал.
Свободный диск перед работой: 22 GiB.

TLC jar `/private/tmp/prov-review/tools/tla2tools.jar`:
`011267fca25d0752cf18894dd585cd28b96960c112ea8a20b823ea770e7e10cd`.
Образ: `proveryalka-codegen-sandbox:4d76b97118d8df7e`; точный image_id в Docker результате.

```sh
PYTHONPATH=src:tests \
PROVERYALKA_TLA_JAR=/private/tmp/prov-review/tools/tla2tools.jar \
PROVERYALKA_REQUIRE_TLC=1 PROVERYALKA_REQUIRE_SANDBOX=1 \
PROVERYALKA_MCP_EVIDENCE=reports/project-review-20261031/sokolov/mcp \
/private/tmp/prov-review/.venv/bin/python -m pytest -q \
  --junitxml=reports/project-review-20261031/sokolov/mcp/backend-junit.xml \
  > reports/project-review-20261031/sokolov/mcp/backend-full.txt 2>&1
```

Предварительные targeted: 17/17 MCP PASS с настоящими TLC/Docker; затем 2/2 helper
и 4/4 классификации sandbox failure PASS (без новых Docker startup).
Финальный full suite: **370 PASS, 0 FAIL, 0 SKIP**, 2 deprecation warnings зависимостей,
56.04 с. Внутри него MCP: 23/23 PASS. Подтверждение: `backend-full.txt` / `backend-junit.xml`.
Это один финальный полный backend запуск после всех изменений кода; TLC и Docker обязательны.
После завершения процесса Docker-слот освобождён, root уведомлён.

## Границы доказательства

Provider LLM: NOT_RUN, в этом блоке не нужен. Browser/frontend E2E: NOT_RUN, UI не менялся.
CI/reviews: не ожидались и не опрашивались. Основное FastAPI wiring: PATCH_ONLY до интегратора;
тестировалась реальная отдельная testapp и install helper, не production demo.
Многопользовательская авторизация/OAuth: НЕ реализованы и не заявлены.

fe3e5ca sandbox ownership подключён cherry-pick b4bbdac. Временный test-only cleanup→0
удалён перед финальными проверками; используется единый Docker executor. Чужие services,
контейнеры, browser hosts, агенты и demo 4180/4182/4183/4184/4185 не останавливались.
Новые тестовые серверы живут только внутри тестов и закрываются их lifespan. Runtime/venv/
БД не копировались в evidence. Сохранение чужих/legacy orphan контейнеров не считается
доказательством восстановления; см. ownership contract infra-блока.
