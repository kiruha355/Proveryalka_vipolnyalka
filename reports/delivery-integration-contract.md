# Контракт интеграции доставки (#31/#44/#48)

Ветка `t3/delivery-ci-runtime-persistence`, base `t3/frontend-live-documents-tests`, исходный HEAD `393ac0e`. Frontend, business agent/checker/storage, app.py/contracts.py/pyproject.toml не меняются. Узкие shared изменения: root README (ссылка на runbook и команда полного запуска), codegen sandbox/service lifecycle по отдельному разрешению пользователя (коммит `fe3e5ca`).

## Подключение

Новый модуль `proveryalka.deployment` вызывает существующий `create_app(settings)` без второго backend/очереди/SQLite. Существующий lifespan владеет всеми worker/TLC/codegen операциями. Статика Vite монтируется последней; API/SSE сохраняют прежние пути. Delivery middleware усиливает `/ready` проверкой index/его entry assets и записи artifacts, без LLM вызова. `/health` и `/ready` сохраняют HTTP-контракт API; в ошибке delivery используется `DELIVERY_UNAVAILABLE`. Миграции/dependencies/wiring в чужих shared files не нужны. Setuptools уже включает новые `.py` модули.

`sh scripts/run-stack.sh` через exec запускает один native uvicorn на loopback. Параметры `--env-file`, `--data-dir`, `--frontend-dist`, `--port` описаны в runbook. `--data-dir` явно переопределяет три data-пути; shell overrides `.env`, defaults остаются в Settings. Отсутствующая сборка/SQLite/TLC останавливает запуск до bind. Режим GPT-подписки использует существующий локальный Codex adapter; никакой упаковки или переноса auth не добавлено.

Из `fe3e5ca` интегрировать **одну** семантику DockerSandbox в REST/MCP. Убрать временные guard/подклассы `cleanup_orphans -> 0` после применения commit. Чужие/legacy containers никогда не выбираются автоcleanup. Подробности: [sandbox ownership](sandbox-ownership-contract.md).

## CI и проверочные уровни

| Уровень | Реализация | Граница доказательства |
|---|---|---|
| Frontend components | frontend typecheck/test/build; extensions check | 33 + 107 tests на исходном frontend HEAD, не browser |
| API + real TLC | полный Python набор с require TLC | оба acceptance, ошибки моделей/лимиты, сессии/версии; LLM scripted |
| Explicit refinement | test_delivery_acceptance.py | настоящий run_analyst, DialogueDraft fixture только на границе LLM, версия 2 только после текста пользователя; старый отчёт/трасса/объяснение сохраняются |
| Native process | test_delivery.py | настоящий HTTP child, Vite artifact, SQLite restart, readiness и собственный SIGTERM; без provider |
| Real Docker delivery | test_delivery_sandbox.py | настоящий TLC→approved generation→Docker pytest, version/spec/code hashes и image ID; отчёт/лог неизменны после версии 2, другой сессии и restart |
| Concurrent Docker ownership | test_sandbox_ownership*.py | два instance c одним run_id; startup/cleanup/cancel A сохраняют B |
| Optional provider | manual provider-acceptance.yml + delivery_provider.py | opt-in один конкретный сценарий, bounded SDK requests; реальный запуск NOT_RUN в этом блоке |
| Browser GPT #39 | отдельный frontend агент | receipt передаётся root отдельно, не заменяется тестовым LLM |
| Corpus quality #30 | вне блока доставки | NOT_RUN; один live backend case не является корпусной оценкой |

Обязательные jobs: `frontend`, `backend-tlc`, `sandbox`. `PROVERYALKA_REQUIRE_TLC=1` и `PROVERYALKA_REQUIRE_SANDBOX=1` запрещают отсутствие движка выдавать за skip/PASS. Docker tests исключены только из job `backend-tlc`, затем обязательно запускаются в `sandbox` вместе с ownership regression. На локальной финальной проверке оба движка обязательны одновременно. CI JUnit/logs/receipts/TLC bundles сохраняются даже при failure. GitHub execution/checks в этом блоке не отслеживаются; YAML parse не считается выполненным CI.

Ручной provider lane требует explicit endpoint/model/API secret из environment GitHub, ограничивает calls/суммарные input chars/output tokens/wall time, retries=0. Это не денежный cap и не оценка качества на корпусе. Subscription auth не поддерживается в GitHub lane. Локальный subscription сценарий выполняется через обычный native stack и receipt #39. GitHub protection rules environment — предложение оператору, не новая автоматически включённая продуктовая политика.

## Соответствие задачам основной версии

Прочитаны актуальные GitHub #31/#44/#48 и зависимые #30/#3 31.10.2026. Исходный отдельный документ ТЗ не присутствует в этом checkout (исторические ссылки README на docs/ не имеют tracked target); ниже соответствие явным разделам задач, без заявления о сверке с недоступной нумерацией ТЗ.

| Раздел | Что поставлено / что ещё нужно |
|---|---|
| #31 unit/API/SANY/TLC/диагностика | обязательный CI + реальные engine тесты, JUnit/logs/bundles |
| #31 текст→агент→версия→TLC→результат/объяснение | deterministic acceptance с настоящим backend/SQLite/TLC и scripted LLM; provider lane отдельно |
| #31 оба сценария/лимиты/isolation | исходная ошибка и явная правка, test_checker_tlc/test_api_tlc/test_run_resilience + новая delivery isolation/provenance |
| #44 поставляемый запуск и сохранение | single-process native UI/API, preflight/readiness/shutdown, process restart test; чистая новая машина NOT_RUN |
| #44 настройки/DSL/лимиты/диагностика/порядок действий | reports/runtime-runbook.md, ссылки на API/checker спецификации |
| #44 полный live сценарий | зависит от отдельной receipt #39; не заявлять весь #44 закрытым по deterministic PASS |
| #44 качество переводов | корпусная evaluation #30 NOT_RUN; один backend-acceptance case недостаточен |
| #48 безопасное выполнение | существующий executor сохранён; фикс межпроцессного cleanup и реальные конкурентные tests |
| #48 логи/версия/код/persistence/CI | новая real TLC→Docker→restart receipt; обязательный sandbox job |

Не выполнены GitHub merge/закрытие issues, запросы к отложенному МАИ endpoint, перенос секретов, смена глобальной конфигурации, перезапуски T3/browser host/чужих demo-серверов. Новые субагенты не запускались.
