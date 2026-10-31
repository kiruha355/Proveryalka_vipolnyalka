# Интеграция MCP #47

31.10.2026. Код: `src/proveryalka/mcp/`; tests: `tests/mcp/`.
Base: `t3/frontend-live-documents-tests` с родительским HEAD `393ac0e`.
Dependency sandbox ownership: `fe3e5ca` → cherry-pick `b4bbdac` в этой ветке.

## Wiring

Общие `api/app.py`, contracts, storage/sqlite и pyproject не редактировались этим блоком.
`app-wiring.patch` и `pyproject-mcp-extra.patch` — конкретные не применённые патчи для интегратора.
`requirements-runtime.lock` уже содержит `mcp==2.3.0`, `mcp-types==2.3.0`; установки/изменения
чужой venv не было. Опциональный extra делает прямую dependency явной для pip-install.

В самом конце `create_app`, после подключения всех HTTP routers, при наличии
`PROVERYALKA_MCP_ENABLED=1` вызывается:

```python
from ..mcp.integration import install_mcp
from ..mcp import LocalAccessPolicy
install_mcp(app, adapter, app.state.codegen, LocalAccessPolicy.from_env())
```

`install_mcp` сохраняет host lifespan, входит в него (включая backend и codegen), затем
в MCP session manager; завершает в обратном порядке. Сам не запускает и не закрывает
существующие backend/codegen. Mount `/` ставится последним, чтобы SDK endpoint оставался
точно `/mcp` без slash redirect, а все существующие HTTP routes имели приоритет.
Повторная установка отвергается. После mount не добавлять другие HTTP routers.

`tests/mcp/test_integration.py` поднимает изолированный FastAPI с host lifespan и health route,
применяет именно helper, выполняет initialize и проверяет порядок start/close. Полная HTTP
проверка четырёх tools использует изолированный FastAPI + SQLite + настоящие SDK clients,
TLC и штатный Docker executor; основной app/demos не менялись.

Нужна одна SQLite на backend worker. Standalone `python -m proveryalka.mcp` требует явный
отдельный `PROVERYALKA_DATABASE_PATH`, использует обычные ApplicationBackend / CodegenService;
не запускать вторым процессом над работающей SQLite. Локальное подключение и scopes описаны
в `src/proveryalka/mcp/README.md`. Личные coding-agent configs/токены не читаются и не меняются.

## Данные и статусы

Входы schema 1.0. get_model разрешает конкретный model_id + version_number и возвращает
`{model_id, version_number, version_id, spec_hash}`. Остальные tools требуют всю эту ссылку;
get_tests/compare требуют ещё generation_id + code_hash. Модель и файлы проверяются по hash
через existing services. На ошибке до разрешения версии model_ref=null; это не semantic result.
Результаты данных всегда имеют immutable reference, включая технически неуспешные TLC/tests.

get_model возвращает approved как данные; согласование сам не делает. check_behavior запускает
обычный durable create_check → get_check, explain=false, без provider LLM. get_tests читает
существующие tests/*, ничего не генерирует. compare_with_code запускает только точную stored
generation в том же Docker executor. Произвольные/изменённые файлы/пути/URL unsupported.
Снимок `tlc_at_generation` отделён от `test_run.status`; тестовый passed не объявляет arbitrary
code equivalence или новое TLC доказательство.

## Доступ и эксплуатационные предложения

LocalAccessPolicy — single-operator loopback boundary, не multiuser authorization.
Предлагаемые defaults: модели deny-all; get_model/get_tests включены, check/compare явно
включает оператор; Origin deny-all, Host loopback allowlist, optional bearer env. Все HTTP
методы проходят одну boundary; proxy peer headers не доверенные. Контракт/лимиты, ошибки,
legacy/modern lifecycle и проверенные primary источники перечислены в README модуля.

## Sandbox dependency

Без fe3e5ca старый startup cleanup мог удалить чужой live container по общей label.
Временный test-only cleanup→0 использовался до готовности ownership fix, затем удалён.
Production и финальные тесты используют обычный DockerSandbox из infra commit; второй
постоянной семантики cleanup нет. Это не доказательство orphan recovery старого процесса:
чужие/legacy owners не удаляются автоматически. См. `reports/sandbox-ownership-contract.md`.
