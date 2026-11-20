# Интеграция клиента 31.10.2026

Ветка `t3/frontend-live-documents-tests`. База включает backend PR63 `00ebad9`, frontend `f16721a`, feature генератора `5faed01` (из `dbbf757`), wiring `6168e69`. Расширения PR65 перенесены всей цепочкой `fa14b3d`, `c855509`, `6464c98` как `07fcc5f`, `0849657`, `5a46852`. Merge/закрытие issues не выполнялись.

Публичные `DialogueView.entries` добавлены в contracts.py, API history projection и read-only storage helper. `SessionDetail.messages` не используется live frontend для SDK-парсинга. История строится из фактических сохранённых реплик; источники без хода не порождают реплики. Адресные ответы, pending/retry/discard, отдельные загрузка документа и разбор source_id подключены.

Проверка отправляет все правила и explain:true с серверными лимитами. Объяснение живёт в отдельном run после завершения TLC. Проверены повтор объяснения без повторной проверки, stale acceptance после unmount и границы версии/spec_hash. Граф и файлы регистрируются через существующий host API; createVersion выполняет POST, ждёт refresh и выбирает новую неподтверждённую версию. configureProjectFiles выполняется до основного render, при смене подключения провайдер следует тому же backend. Demo не включает live генерацию.

DOCX UTF-16 DTD bypass воспроизведён и закрыт отдельным `2d45f28`: XMLParser callback вместо ASCII blacklist. 18 document tests PASS, в том числе нормальный UTF-16.

Проверки: frontend 30 PASS; отдельный opt-in реальный HTTP adapter scenario PASS с Java/TLC, codegen и Docker pytest 79 PASS; extensions 104 PASS, typecheck/library/host types PASS; полный backend с обязательными TLC/Docker 344 PASS (47.99 s). Ядро и расширения собираются вместе. Полный browser+GPT E2E NOT_RUN; пользовательская визуальная приёмка pending. Политика allow_unverified генерации остаётся открытым продуктовым вопросом.

Стабильная demo-сборка, автономные walkthrough/check/requirements HTML, PNG и logs сохранены вне временного runtime: `/Users/a/Proveryalka_vipolnyalka/reports/project-review-20261031/frontend-integration/`. Отдельный runtime5294 использовался только для HTTP adapters test и штатно остановлен; его БД сохранена. Старый demo4180 не изменён. Dependencies сохранены для активного frontend5291 и ручной проверки; не удалять их, пока стенд используется.


## Второй просмотр

Новые прямые отзывы: footer трассы/zoom больше не накладывается; отдельное разворачивание сохраняет тот же граф, выбор и шаг; Escape/close/focus return. Основные controls/cards/nodes получили radius4–6px по уточнению пользователя. Два действия контрпримера только дополняют draft и фокусируют чат, не отправляя сообщение и не меняя модель.

В demo добавлен отдельный настоящий пятиходовый GPT subscription transcript из supplied backend-acceptance; статусы, модели и отчёты принадлежат ему, fixture status-enum с ним не смешивается. Reimport: `python3 frontend/scripts/import-recorded-dialogue.py /path/to/backend-acceptance`. Provenance hashes сохранены в `recorded-dialogue.json`; backend timestamps отсутствуют и не выдуманы. Read-only checkcards размещены в порядке записанного сценария.

Frontend33PASS, extensions107PASS, types/build/hosttypesPASS. Новых provider/TLC/Docker calls нет; прежние344backendPASS не являются новым запуском. before/after/expanded/recorded HTML/PNG и отдельный stable demo-dir — root reports/.../frontend-integration/revision-2/. Old demo-dist и4182/4183 сохранены. Browser walkthrough и пользовательская приёмка pending у root.

## Вопрос о файле и main39

`6648917` добавляет реальный read-only вопрос о сгенерированном файле через existing messages/run protocol. Backend проверяет generation/session/version/path/size/hash и сохранённые байты, передаёт точную immutable модель и её verification snapshot. Публичные entries содержат связь с файлом; retry/discard/cancel не дублируют реплику. Sources/версии при объяснении не меняются. Миграции не нужны; подробности в `file-discussion-contract.md`. Исправлен общий read-only OpenAPI capability probe при StrictMode abort/remount; regression покрывает этот случай.

Ownership fix `fe3e5ca` перенесён как`8925ca6` до следующего startup своего idle API и финального full suite. Итоговый backend355PASS /48.38s, обязательные TLC+Docker; frontend36PASS (+1 opt-in skipped), extensions108PASS, types/build/host-types PASS. Предыдущие349PASS/3sandboxFAIL до ownership fix сохранены отдельно; targeted повтор3PASS и чистый итоговый full не суммируются.

В настоящем T3 Browser main39 создан отдельный живой диалог, пройдены адресные уточнения, ручной counterexample→явная правка→новая модель/HOLDS→confirm→генерация16файлов→native ZIP→вопрос GPT по app/rules.py→refresh→Docker54/54PASS. Native act/evaluate и durable receipts сохранены в root `end-to-end-acceptance/`. Snapshot/AX timeout диагностирован read-only отдельно; новых попыток после диагностики нет, T3 не перезапускался. Функциональный результат не означает screenshot/UX acceptance. Визуальная приёмка pending.

Новая immutable сборка `frontend-integration/revision-3/demo-dist`, отдельно HTTP snapshot `http-dist`. Старые4180/4182/4183/4184/4185 и revision-2 не изменены. Текущие реальные main39 данные не подмешаны в fixture или прежнюю пятиходовую запись. API5296/UI5298 оставлены для root/delivery handoff с той же изолированной DB. Images67/MCP68/repos69/delivery70 patches в этот прогон не включались.
