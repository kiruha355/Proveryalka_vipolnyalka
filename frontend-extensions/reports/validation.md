# Проверки #40 и #49

31.10.2026, continuation реализации в `t3/state-graph-project-files`. Backend и основной frontend не менялись. Команды выполнялись в этом worktree; атрибуция дополнительных моделей не добавлялась.

| Уровень | Результат | Доказательство |
|---|---|---|
| TypeScript | PASS | `npm run typecheck`, strict/noUncheckedIndexedAccess; `check.log` |
| Компоненты/DSL/проекция/трасса/provider/ZIP | PASS | `npm test`: 104 tests, 6 files; `check.log` |
| Библиотечная сборка и declarations | PASS | `npm run build`; `check.log` |
| Совместимость типов host | PASS | `scripts/check-host-types.sh /Users/a/.t3/worktrees/Proveryalka_vipolnyalka/t3-d2c2a8b5/frontend` |
| Standalone demo build | PASS | `npm run demo:build`; `graph.html`, `files.html` |
| Визуальный показ | PASS для inspected состояний | Нативные `html_preview` → `html_render`; ширина 728 и 1000; consoleMessages=[]; `graph-728.png`, `files-728.png` |
| ZIP вне JS | PASS | Тест Python `zipfile`: CRC, обычные файлы, права 0644, количество и SHA-256 |
| Данные генератора/Docker/TLC | supplied recording | `src/fixtures/codegen-recording.json`; настоящие DTO, 17 файлов, ZIP, 79/79 pytest; повтор работы с записью выполнен здесь, сам Docker/генератор здесь не запускался |
| Новый интегрированный frontend + живой HTTP/TLC/Docker | NOT_RUN | Основной frontend находится в другом ownership; локальный порт 8000 при проверке не слушал. Нужен интеграционный прогон родителя с #63/#64 |
| Пользовательская визуальная приёмка | PENDING | Учтены восстановленные exact annotations 7/10; отсутствующие окончания не додумывались |
| GitHub CI / независимое review | Смотри PR | Локальные проверки не считаются GitHub review |

Дополнительно проверены: guards/effects без изменения исходной версии, синхронное присваивание, точные версии/хеши трассы, inconsistent trace, многомерная модель, ограничения количества узлов и >1200 стрелок; keyboard selection; явная генерация при VERIFICATION_REQUIRED; тесты не стартуют автоматически; pending counts неизвестны; cancel, недоступная песочница; pointer dragging и persistence разделителей; смена версии при запоздалом ответе; цикл callback/cache; traversal, absolute/Windows paths, Unicode/case collisions, duplicates, symlink-like metadata и mode; подмена байтов/ZIP/code hash.

`holds`, `violated`, `inconclusive`, `not_checked` сохраняются отдельно от результатов pytest. В демонстрации создания версии используется memory adapter (подписан ниже); real HTTP versions adapter и real codegen adapter поставляются в библиотеке. Никакой live generation в записанном примере не имитируется: mutating actions возвращают RECORDING_READ_ONLY. Статус ready записи реконструирован из supplied receipt и не является текущей проверкой Docker.

Ограничения: выбор model check/property-selector/TLC limits form, история исходных реплик чата, подсветка цитат полного источника и wording подтверждения модели принадлежат `frontend/`. Файловые объяснения — deterministic generator metadata; отдельный LLM-ответ про файл здесь не генерируется. Хост открывает path/line range через `setProjectFocus`, элементы — через общий selection. Ссылка ограничивается точным generationId. Экспорт ограничен 32 МиБ; viewer 5000 строк; это явно сообщается.

Нативный `html_preview` ограничен 512000 символами: первоначальный graph payload был отклонён. Standalone JS упакован gzip внутри того же HTML и показан тем же нативным инструментом; другой браузер и новый сервер не запускались.
