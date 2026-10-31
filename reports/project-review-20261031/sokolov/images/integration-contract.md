# Интеграция изображений (#45)

Актуальный issue: https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/45, прочитан 31.10.2026. Оставлен открытым. База работы: `393ac0e`, draft PR должен иметь base `t3/frontend-live-documents-tests`.

## Коммиты и ownership

- `74110d047e21988243d8524e1bcd7940570f414d`: независимый additive Codex adapter (`complete(..., image_urls=...)`, `image_model()`), fixture и 8 protocol tests. Existing text path не меняет форму wire input. Секреты не читались/копировались.
- `30a02361c247eb80083713602b159ffb35f4c1a4`: точный cherry-pick infra fix `fe3e5ca7ce867ff65ee99969aa154d4daa04cc77`, по указанию root; ownership tests и sandbox changes принадлежат infra блоку. Не сливать повторно как отдельную новую реализацию.
- Images module, migration `007_images.sql`, tests/images и docs принадлежат #45. Frontend и активная ветка #39/#49 не менялись.

## Точное подключение root

В `integration.patch` четыре additive изменения к базовому checkout:

1. `src/proveryalka/storage/sqlite.py`: поддержка `user_version=7`, `(7, "007_images.sql")` в migration sequence. SQL находится в обычном storage package, существующий package-data уже включает `migrations/*.sql`. Учесть общую последовательность с reserved `008_repository_snapshots.sql` и возможным `009`.
2. `src/proveryalka/api/app.py`: после существующих router вызвать `create_images_router(store)`, установить `app.state.images`, `app.include_router(images_router)`. Router lifespan запускается после SQLite initialization и восстанавливает прерванные image analyses.
3. `pyproject.toml`: runtime dependency `Pillow==12.1.1`.
4. `requirements-runtime.lock`: тот же точный pin, без дополнительных транзитивных runtime packages.

`git apply --check .../integration.patch` проходит на этой ветке. Изменения shared файлов **не применены** в implementation worktree по ownership. Они необходимы, чтобы стандартный `create_app` публиковал images API. Тесты используют отдельный testapp с production router, настоящим SQLiteStore и точным `007_images.sql`. В `contracts.py` правки не требуются: новые DTO additive и находятся в `images/dto.py`.

При обновлении общего OpenAPI fixture root следует регенерировать его через стандартный `create_app` после подключения router; schema из isolated app намеренно не подменяет основной fixture.

## Контракт клиента

Готовая additive реализация клиента и типы — `client-contract.ts`. Её можно перенести в общий frontend client/hook без зависимости от изображения как текстового документа. Проверена `tsc --noEmit --strict --lib DOM,ES2022`. Существующий frontend не менялся.

- Загрузка: `POST /api/sessions/{sid}/images`, `FormData.file`, `Idempotency-Key`, браузер выставляет multipart boundary/Content-Length. Результат 201 `ImageSource`, поле `kind=image`, без `text`.
- Получение: GET того же prefix, GET `/{source_id}`, GET `/{source_id}/content` (canonical PNG).
- Разбор: `POST /{source_id}/analysis`, JSON `{}`/`{region:null}` для всего кадра или `{region:{x,y,width,height}}` для выделения. Явный `Idempotency-Key`. Результат `ImageAnalysis`, text requirements с `origin=visible|proposal` и image-only `source_refs`.
- Восстановление: `GET /{source_id}/analyses` возвращает сохранённые записи `running|failed|completed`, `error_code`, `result`. При разрыве соединения сначала прочитать их; автоматический повтор POST запрещён клиентским контрактом.
- Bounds: `region` — целые canonical pixels, полуоткрытый прямоугольник. Экранные CSS px нужно пересчитать через naturalWidth/naturalHeight canonical `/content`. EXIF orientation уже применена. Сервер проверяет границы, crop-ит изображение и отправляет именно crop.
- `ImageRef.kind=image_reference`, `coordinate_space=canonical_pixels`, original/canonical SHA, `region=null,scope=whole_image` либо `region,scope=selected_region`. `quote/start/end` отсутствуют. На UI показывать «изображение»/«область изображения», не дословную цитату документа.
- `visible` означает интерпретацию видимого моделью, а не независимо подтверждённое правило. Продуктовые выводы `proposal` должны показываться как предложения. Сохранять uncertainties.
- `503/PROVIDER_IMAGE_UNSUPPORTED` — явная недоступность vision; нельзя заменять выдуманным OCR, пустым успешным анализом или скрытым текстовым fallback. `429/IMAGE_ANALYSIS_BUSY` — текущий слот занят. После ошибки нужен новый ключ для явного повтора.

Полная таблица API, limits и provider behavior — `src/proveryalka/images/README.md`.

## Границы

Модуль реализует загрузку, сохранение metadata+canonical bytes, pixel delivery, структурированное извлечение требований, provenance и восстановление результатов image analysis. Он не создаёт формальную BehavioralModel и не выдаёт image source за прежний текстовый Source: отправлять `img_*` в `/messages.source_id` нельзя. Если нужен единый image-to-formal-model сценарий, root должен отдельно согласовать расширение text-oriented dialogue/formalization contracts; этот draft его не заявляет. Browser/frontend visual acceptance, CI и production E2E не выполнялись.

Все defaults ImageLimits (8 MiB, 16M pixels, 8192 edge, 32 MiB canonical, 180 секунд, один concurrent analysis) и OpenAI-compatible vision opt-in являются **предложениями реализации**, не новыми согласованными продуктовыми политиками.
