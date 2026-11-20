# Проверки #46

Дата: 31.10.2026. Worktree `t3/repository-import-snapshots`, исходный HEAD393ac0e,
infra fix `fe3e5ca` перенесён как `2185f81` по указанию интегратора.

| Проверка | Результат | Граница |
|---|---|---|
| Targeted repository/API/HTTPS | PASS, 72 теста, 4.52s | Настоящие Git commit/tree/blob, SQLite, real analyst pipeline; LLM scripted |
| Однократный public repository smoke | PASS, commit66d55c6…, 66 файлов/521139bytes | Production HTTPS transport, без credentials и LLM; точный manifest в public-smoke.json |
| Integration wiring patch | PASS `git apply --check` | Патч подготовлен; shared files в этой ветке не изменены |
| Полный backend suite | PASS, 419 тестов, 52.01s, exit0 | REQUIRE_TLC=1 и REQUIRE_SANDBOX=1; один запуск после освобождения слота #45, ownership fix подключён |
| Private authorized account | NOT_RUN | Provider/reference contract и ошибки доступа проверены детерминированно |
| Реальный LLM | NOT_RUN | Состав source payload/role проверен, это не provider E2E |
| Браузер/frontend | NOT_RUN | Frontend/PR66 не менялся; визуальных изменений нет |
| GitHub CI/review | NOT_RUN | Не watch/poll CI |

Проверены: commit refresh с сохранением старого snapshot, restart persistence,
idempotency без повторного fetch/inference, принадлежность сессии, server-only
content/ranges/hash, file/line citations включая CRLF и Unicode, контекст с byte/line
лимитами; URL/credentials/SSRF/IPv6 transition/redirect guards; ограничение DNS workers
и HTTPS total deadline; download/expanded/index/file/entry caps; invalid tar, traversal,
duplicate paths; исключение secret patterns, `.env`, dependencies/caches, binaries,
LFS pointers, links и отсутствие исполнения hooks/filters/scripts/submodules.

Fixture использует фиксированные `git ls-tree`/`git cat-file blob`. Ранний вариант
с `git archive` оказался неподходящим: smudge filter fixture изменял содержимое.
Этот путь удалён; production transport изначально вообще не использует Git process.
Успешный финальный тест проверяет, что malicious fixture marker не создан.

Системный Python дал collection ImportError `DefaultAsyncHttpx2Client` из старого
`openai`. Глобальные зависимости не менялись; найден готовый
`/private/tmp/prov-review/.venv/bin/python`: FastAPI0.162.0/OpenAI3.41.0/agents0.24.0/pytest8.3.5.
Зависимости/JAR используются read-only. Новые установки, Docker builds, runtime stands,
копии node_modules/venv, изменения demo-серверов не выполнялись.
Информационный diskcheck перед планированием полного suite: 22GiB свободно.

Финальная полная команда (419 включает 72 targeted tests; суммы не складываются):

```sh
PYTHONPATH="$PWD/src" PROVERYALKA_REQUIRE_TLC=1 PROVERYALKA_REQUIRE_SANDBOX=1 \
PROVERYALKA_TLA_JAR=/private/tmp/prov-review/tools/tla2tools.jar \
/private/tmp/prov-review/.venv/bin/python -m pytest -q \
  --junitxml=reports/project-review-20261031/sokolov/repositories/backend-full.xml
```

Проверялся implementation commit `2268d8608b6d8956594e49790801909dfc76aa55`;
следующий commit меняет только evidence. `backend-full.xml` и `backend-full.txt`
содержат фактический JUnit/stdout. Полный suite завершён, слот сразу передан root
для delivery. Дополнительные targeted/provider smokes после полного набора не запускались.

Draft PR: https://github.com/kiruha355/Proveryalka_vipolnyalka/pull/69,
base `t3/frontend-live-documents-tests`. Создан через существующую авторизацию `gh`
и немедленно привязан `link_pull_request`. Native GitHub connector read issue сработал,
но create_pull_request вернул точную ошибку:

```text
GitHub API error 403: {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/pulls/pulls#create-a-pull-request","status":"403"}
```

Причина fallback — права GitHub integration на POST pulls; `git push` и тот же PR
через уже настроенный `gh` сработали. Токены/профили не читались, глобальная конфигурация
не менялась. По прямому ограничению задачи новые диагностические агенты не запускались;
ошибка и граница переданы root.
