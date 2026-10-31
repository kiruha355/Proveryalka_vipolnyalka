# Интеграция клиента 31.10.2026

Ветка `t3/frontend-live-documents-tests`. База включает backend PR63 `00ebad9`, frontend `f16721a`, feature генератора `5faed01` (из `dbbf757`), wiring `6168e69`. Расширения PR65 перенесены всей цепочкой `fa14b3d`, `c855509`, `6464c98` как `07fcc5f`, `0849657`, `5a46852`. Merge/закрытие issues не выполнялись.

Публичные `DialogueView.entries` добавлены в contracts.py, API history projection и read-only storage helper. `SessionDetail.messages` не используется live frontend для SDK-парсинга. История строится из фактических сохранённых реплик; источники без хода не порождают реплики. Адресные ответы, pending/retry/discard, отдельные загрузка документа и разбор source_id подключены.

Проверка отправляет все правила и explain:true с серверными лимитами. Объяснение живёт в отдельном run после завершения TLC. Проверены повтор объяснения без повторной проверки, stale acceptance после unmount и границы версии/spec_hash. Граф и файлы регистрируются через существующий host API; createVersion выполняет POST, ждёт refresh и выбирает новую неподтверждённую версию. configureProjectFiles выполняется до основного render, при смене подключения провайдер следует тому же backend. Demo не включает live генерацию.

DOCX UTF-16 DTD bypass воспроизведён и закрыт отдельным `2d45f28`: XMLParser callback вместо ASCII blacklist. 18 document tests PASS, в том числе нормальный UTF-16.

Проверки: frontend 30 PASS; отдельный opt-in реальный HTTP adapter scenario PASS с Java/TLC, codegen и Docker pytest 79 PASS; extensions 104 PASS, typecheck/library/host types PASS; полный backend с обязательными TLC/Docker 344 PASS (47.99 s). Ядро и расширения собираются вместе. Полный browser+GPT E2E NOT_RUN; пользовательская визуальная приёмка pending. Политика allow_unverified генерации остаётся открытым продуктовым вопросом.

Стабильная demo-сборка, автономные walkthrough/check/requirements HTML, PNG и logs сохранены вне временного runtime: `/Users/a/Proveryalka_vipolnyalka/reports/project-review-20261031/frontend-integration/`. Отдельный runtime5294 использовался только для HTTP adapters test и штатно остановлен; его БД сохранена. Старый demo4180 не изменён. Dependencies сохранены для активного frontend5291 и ручной проверки; не удалять их, пока стенд используется.
