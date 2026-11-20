# Объяснение сгенерированного файла (#49)

`POST /api/sessions/{sid}/messages` дополнен полем:

```json
{"text":"Объясни условие перехода в этом файле. Ничего не меняй.","file_context":{"generation_id":"gen_...","version_id":"v_...","path":"app/rules.py","sha256":"64 lowercase hex characters"}}
```

`text` обязателен, `source_id` и `question_id` с file_context недопустимы. Стандартный Idempotency-Key и ответ202 Run(agent) сохранены. Нет нового продуктового режима и нет изменения файлов/модели.

Сервер разрешает только безопасный путь, существующий в `codegen_files` указанной генерации и той же сессии. До вызова модели проверяются размер≤64KiB, UTF-8, SHA-256 сохранённых байтов/metadata/ожидаемого хеша, generation/version/spec_hash и неизменяемая спецификация. Произвольные host paths не читаются. Клиент передаёт ссылку, не содержимое. Файл и выбранная модель подаются модели как JSON-данные `untrusted_file`/`selected_model`, а не системные инструкции. У агента нет tools/handoffs; вопрос read-only. Передаётся verification snapshot именно этой генерации, не latest отчёт диалога.

Публичные `DialogueView.entries[]` для вопроса и ответа содержат `file_context`: generation_id, version_id, path, sha256 и серверно подтверждённые model_id/version_number/spec_hash/code_hash. UI показывает связь с файлом; переход открывает точную генерацию/версию. После refresh вопрос и ответ сохраняются. Поле верхнего `dialogue.reply` продолжает описывать business analyst state, объяснение файла читается из entries.

Файл не становится источником бизнес-требований: file_discussion записывается отдельно от analyst_dialogue/pending; при ответе нет save_dialogue_sources/save_version. Текущая модель и её требования остаются прежними. Idempotent replay не вызывает модель повторно. Сбой/таймаут хранит unfinished file turn в обычном `dialogue.pending` (добавлено file_context); `/pending/retry` продолжает тот же вопрос без дубля, `/pending/discard` отказывается от него. Явная отмена освобождает чат. Обычный и file pending не могут быть активны одновременно.

UI: «Спросить агента о файле» доступно после загрузки/проверки текста файла. Действие сохраняет контекст и дополняет имеющийся draft, переводит фокус в чат и ничего не отправляет. Перед отправкой контекст виден и снимается отдельным действием. При submit уходит text+file_context. В demo live file discussion скрыта.

Targeted proof: `tests/test_file_dialogue.py` (selected older immutable version, provider payload bytes/hash, no source/version mutation, idempotency, cross-session/path/hash/version/size/integrity rejection, retry/discard/cancel) и component/adapter tests ядра/расширений. Живой T3 Browser прогон и границы его screenshots — root reports/project-review-20261031/end-to-end-acceptance/receipt.md.

Миграций не добавлено. Ownership fix sandbox fe3e5ca включён как8925ca6; глобальный cleanup старой версии не использовать параллельно с активными Docker runs.
