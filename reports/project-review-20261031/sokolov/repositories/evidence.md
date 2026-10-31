# Проверки #46

Дата: 31.10.2026. Worktree `t3/repository-import-snapshots`, исходный HEAD393ac0e,
infra fix `fe3e5ca` перенесён как `2185f81` по указанию интегратора.

| Проверка | Результат | Граница |
|---|---|---|
| Targeted repository/API/HTTPS | PASS, 72 теста, 4.52s | Настоящие Git commit/tree/blob, SQLite, real analyst pipeline; LLM scripted |
| Однократный public repository smoke | PASS, commit66d55c6…, 66 файлов/521139bytes | Production HTTPS transport, без credentials и LLM; точный manifest в public-smoke.json |
| Integration wiring patch | PASS `git apply --check` | Патч подготовлен; shared files в этой ветке не изменены |
| Полный backend suite | NOT_RUN, ожидается слот repositories после #47→#45 | Набор не запускался одновременно со старым cleanup |
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
