# Проверка доставки 31.10.2026

**Доставка и детерминированный прогон: PASS.** Source head `3939fa9d136e97af8e68d22f3fb713437e283c65`, включая ownership fix `fe3e5ca`. Последующий commit добавляет только этот отчёт и уточнения документации. Draft PR: https://github.com/kiruha355/Proveryalka_vipolnyalka/pull/70, base `t3/frontend-live-documents-tests`. Issues не закрывались.

| Уровень | Лично выполнено | Результат |
|---|---|---|
| Полный backend | pytest, REQUIRE_TLC=1, REQUIRE_SANDBOX=1, реальный frontend/dist | **355 PASS, 0 skip, 53.72 с**, exit0 |
| Frontend | typecheck → test → build | **33 PASS / 1 live-http skipped**, types/build PASS |
| Extensions | npm run check | **107 PASS**, types/build PASS |
| Ownership отдельно | 2 deterministic + 1 concurrent real Docker | **3 PASS**, 1.21 с |
| Целевые delivery до full | process/static/refinement/TLC→Docker persistence/provider guards | 7 PASS на момент запуска; дополнительный budget factory test затем включён в успешный полный набор |
| CI syntax | Ruby YAML parse двух workflows | PASS; GitHub execution/checks/reviews **не проверялись** |
| Чистая новая машина | fresh venv/npm ci/image build | **NOT_RUN**; использованы готовые зависимости/jar/image |
| Manual API-provider lane | только deterministic budget/guard tests | живой provider **NOT_RUN** |
| GPT browser #39 | выполняется отдельным frontend агентом | в этом блоке **NOT_RUN**, receipt на момент handoff не получена |
| LLM quality corpus #30 | корпусный quality evaluation | **NOT_RUN**; один прежний backend live-case не заменяет корпус |

## Команды и окружение

```sh
PROVERYALKA_TLA_JAR=/private/tmp/prov-review/tools/tla2tools.jar \
PROVERYALKA_TEST_FRONTEND_DIST=frontend/dist \
PROVERYALKA_REQUIRE_TLC=1 PROVERYALKA_REQUIRE_SANDBOX=1 PYTHONPATH=src \
/private/tmp/prov-review/.venv/bin/python -m pytest -q -rs \
  --basetemp=/tmp/proveryalka-delivery-validated \
  --junitxml=/tmp/proveryalka-delivery-validated.xml \
  > /tmp/proveryalka-delivery-validated.log 2>&1

npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend-extensions run check
```

macOS; Python 3.12.12, Node v26.13.0/npm 11.20.0, Temurin Java 25.0.2, Docker 29.1.3. CI настроен отдельно на Node24/Python3.12/Java21; локальный PASS не является CI execution. Jar SHA256 `011267fca25d0752cf18894dd585cd28b96960c112ea8a20b823ea770e7e10cd`. Готовый sandbox image `proveryalka-codegen-sandbox:4d76b97118d8df7e`, ID `sha256:e052badb7925dc75a36c07a7f952c038946f277f7dd96970baf3a3b74dbcd1d6`.

Использован существующий Python venv через PYTHONPATH и собственные symlinks на готовые JS dependencies. Конфигурация venv и чужие исходники не менялись; symlinks/собственные build folders после проверки удалены. БД/данные тестов сохранены в своём временном basetemp, в Git/evidence не копировались. Generated Python выполнялся только внутри sandbox. Новых provider calls, новых агентов и перезапусков чужих процессов не было.

## Что проверяет новый acceptance

`test_delivery.py`: один origin для static/API, data/.env не смонтированы, потеря assets даёт 503, отсутствующий build отклоняется, настоящий subprocess поднимается на своём свободном порту, SIGTERM и повторный запуск сохраняют SQLite. В финальном прогоне subprocess использует настоящий Vite build.

`test_delivery_acceptance.py`: HTTP→настоящий run_analyst/SQLite→версия1→настоящий TLC→контрпример Approve/Cancel/Execute→объяснение с теми же номерами шагов→явный текст правки→версия2 с parent_id→PROPERTY_HOLDS. Источник LLM scripted и явно не считается provider evidence. Старый отчёт/объяснение/версия сохраняются после restart; другая сессия не получает модель.

`test_delivery_sandbox.py`: настоящий TLC всех свойств approved модели→generation с check_run_id→реальный Docker pytest→сохранённый report/log. `version_id/spec_hash/code_hash` и manifest сверяются, image ID фиксируется. Более новая версия/generation и чужая сессия не меняют старую receipt. После restart отчёт, лог, generation и TLC report побайтно/структурно прежние. Лог и receipt сохраняются до утверждения PASS, чтобы failure оставлял диагностику.

`test_sandbox_ownership*.py`: доверия к одному общему label недостаточно. Даже ошибочный ps listing перепроверяется через inspect; foreign/legacy/active/running контейнеры не удаляются. Cleanup использует rm без force; kill/final rm проверяют owner и immutable ID. Реальный конкурентный тест запускает два instance с одним run_id, выполняет startup/cleanup, отменяет A, проверяет работающий B; оба собственных контейнера в конце удалены.

## Первый полный прогон и граница причинности

До выделенного слота первый full завершился 350 PASS/5 sandbox FAIL за 49.12 с. Docker events подтверждают `kill signal9 → die137 → destroy`, включая hang примерно через 2 секунды при timeout5 и HTTP sandbox run в секунду старта. SQLite записал `SANDBOX_OUTPUT_INVALID`, без container_exit_code после удаления.

**Caller неизвестен.** Опасная broad-cleanup семантика прежнего executor установлена по коду; её связь с конкретными kill событиями — гипотеза. Старый cleanup мог запускаться при любом `TestClient(create_app())`, до codegen test files. Финальный успешный прогон выполнен после остановки legacy suite и предоставления delivery слота. Первые FAIL не удалены и не выданы за PASS.

Сохранено отдельно в ROOT `reports/project-review-20261031/sokolov/delivery/`: `initial-full-failed.xml/.log`, `initial-docker-events.txt`, `initial-full-analysis.md`, затем `backend-tests.xml`, `backend-tests.log`, `sandbox-receipt.json`, `sandbox.log`, `delivery-process.log`, `frontend-checks.json`, ownership/targeted JUnit, integration-contract и runbook. Там только небольшие доказательные материалы, без DB/node_modules/venv/auth.

## Ограничения выпуска

Delivery implementation и обязательные CI definitions готовы отдельно. Полный #44 не объявляется завершённым: нужен отдельный #39 browser receipt и #30 quality evaluation. Manual provider lane подготовлен, но живым API не проверен. Fresh-machine install также не выполнялся. В checkout нет исходного отдельного файла ТЗ: соответствие сверено с точными актуальными разделами #31/#44/#48/#3, не с недоступной нумерацией документа ТЗ.

GitHub connector create PR вернул `403 Resource not accessible by integration`; draft создан через `gh pr create --draft` с теми же base/head/body и сразу привязан `link_pull_request`. Права/config не менялись, секреты не читались. CI не watch/poll; GitHub merge и закрытие issues не выполнялись.
