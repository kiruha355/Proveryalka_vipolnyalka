# Проверка изображений (#45)

31.10.2026. Draft PR: https://github.com/kiruha355/Proveryalka_vipolnyalka/pull/67, base `t3/frontend-live-documents-tests`. Issue #45 оставлен открытым.

## Результаты

| Уровень | Результат | Что выполнено лично |
|---|---|---|
| Decoder/API/component | PASS | 45 tests в `tests/images`: реальные PNG/JPEG/WebP, EXIF orientation, stripping metadata/trailer, dimensions/pixel/bytes limits, animated/corrupt files, archives/model payloads, path/URL/symlink refusal, crop pixels, image refs, cross-session access, idempotency/recovery/concurrency, corrupted storage, unsupported/error paths |
| Codex protocol/component | PASS | 17 tests `test_codex_runtime.py` + `test_codex_images.py`: native image item, model/list capability gate, tools/hooks/MCP/network isolation, отказ local/remote paths, interrupt tool attempt, прежний text flow |
| Responses transport/component | PASS | Входит в 45: официальный `input_image` + data URL и strict JSON schema через настоящий SDK с MockTransport; это не реальный Responses provider proof |
| Sandbox ownership unit | PASS | 2 tests на точном исправлении `fe3e5ca`, cherry-picked как `30a0236` |
| TypeScript client contract | PASS | `tsc --noEmit --strict --lib DOM,ES2022 .../client-contract.ts`; использован существующий compiler read-only из соседнего frontend worktree |
| Финальный полный backend | **PASS, 400 tests, 0 failures/errors/skips, 52.73s** | `REQUIRE_TLC=1`, `REQUIRE_SANDBOX=1`, настоящий TLC и существующий Docker sandbox, после освобождения слота #47 по разрешению root |
| Реальный provider | **PASS, один smoke** | ImageService → existing CodexClient app-server → `gpt-6.1-sol`, xhigh, подписка пользователя; число `4827` находилось только в synthetic PNG, отсутствовало в prompt, модель прочитала его в ответе |
| Browser/frontend/общая image-to-formal-model цепочка | NOT_RUN | Frontend не менялся. Изображения возвращают отдельные typed requirements и image refs; автоматическая formalization не реализована и не заявляется |
| Реальный OpenAI-compatible provider / МАИ | NOT_RUN | На МАИ запросов не было, новый ключ не требовался |
| CI/reviews/production | NOT_CHECKED / NOT_RUN | CI не watch/poll; PR draft, merge и issue closure не выполнялись |

JUnit финального полного набора: `backend-tests.xml` (timestamp `2026-10-31T12:39:03.063810+03:00`, tests=400, failures=0, errors=0, skipped=0). Полный bounded лог сохранён в root reports как `backend-tests.log`, он не является runtime-журналом сервиса.

## Воспроизведение

Использован готовый `/private/tmp/prov-review/.venv` **read-only**: Python3.12.12, OpenAI3.41.0, Agents0.24.0. Глобальный Python не подходит (его SDK старее); глобальные пакеты не менялись. Pillow12.1.1 был установлен отдельным временным target под CPython3.12, не в общий venv. Его pin дан root в `integration.patch` для pyproject и runtime lock.

```sh
PYTHONPATH="$PWD/src:/private/tmp/proveryalka-image-pillow" \
PROVERYALKA_TLA_JAR=/private/tmp/prov-review/tools/tla2tools.jar \
PROVERYALKA_REQUIRE_TLC=1 PROVERYALKA_REQUIRE_SANDBOX=1 \
/private/tmp/prov-review/.venv/bin/python -m pytest -q -r a \
  --junitxml=reports/project-review-20261031/sokolov/images/backend-tests.xml
```

SHA256 TLC jar: `011267fca25d0752cf18894dd585cd28b96960c112ea8a20b823ea770e7e10cd`.

Реальный smoke воспроизводится скриптом `smoke_image_provider.py` при явно разрешённом обращении к подписке. Его повтор не выполнялся. Пиксели и raw структурированный ответ: `synthetic-source.png`, `provider-smoke.json`. В исходнике smoke число не добавляется в provider text; bytes проходят штатные ingestion/service/provider. Auth-файлы, токены и ключи скрипт не читает и не копирует.

Локальная JSON schema `codex-cli 0.166.0` подтверждает native image input (`protocol-schema-evidence.json`). Форма протокола сверена также с официальной [Codex app-server документацией](https://learn.chatgpt.com/docs/app-server); Responses input — с [Images and vision](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses).

## Исправления и ограничения проверки

Первый collection attempt обнаружил конфликт одинаковых имён test_api в nested tests; новые файлы переименованы в `test_images_*`. Следующий старый full suite остановлен по указанию root: SIGINT только своему PID27874 после проверки cwd. Он завершился KeyboardInterrupt, 233 PASS — **PARTIAL**. Последний завершённый testcase не доказывает отсутствие старого broad cleanup: `TestClient(create_app())` мог запустить его через lifespan в более ранних API/analyst тестах. Ранее высказанный обратный вывод отозван.

Безопасное основание финального прогона: старый процесс фактически остановлен; точный ownership fix `fe3e5ca7ce867ff65ee99969aa154d4daa04cc77` применён отдельным `30a02361c247eb80083713602b159ffb35f4c1a4`; слот root освобождён после #47. Финальный pytest exit0, процесс завершён, слот передан #46. Чужие серверы, браузеры, T3, демо4180/4182/4183/4184/4185 и агенты не останавливались.

GitHub native connector прочитал issue, но create PR вернул `403 Resource not accessible by integration` (нет write permission). Для создания использован `gh pr create`, затем немедленный `link_pull_request`. Отдельный диагностический subagent не запускался по явному запрету task. Никаких комментариев/сообщений людям не отправлялось.

Основной app в этой ветке не подключает новый router автоматически: по ownership необходимые shared wiring/dependency/migration правки переданы **точным** `integration.patch`, `git apply --check` PASS. Изолированный testapp использует production router+SQLite+007 SQL. Полный suite проверяет ветку с этим модулем и existing app; он не является доказательством уже применённого shared wiring на root. Обычный text-only `/messages` не принимает img_*; клиентский образец и integration-contract это явно указывают.

Собственные временные Pillow targets (CPython3.11/3.12) и protocol schema directory удалены после проверки отсутствия открытых файлов через lsof; итоговый минимальный protocol excerpt сохранён. Общий venv, compiler, Docker images и TLC jar сохранены. Для воспроизведения установить pin Pillow в собственное окружение; временный target из команды выше после завершения отсутствует.
