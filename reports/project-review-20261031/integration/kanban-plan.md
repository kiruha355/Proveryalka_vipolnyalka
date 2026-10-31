# План обновления GitHub Projects

Статусы соответствуют фактической готовности на 31.10.2026. In review означает реализацию и локальные проверки, а не merge/приёмку. Issues остаются открытыми.

| Issue | Статус | Основание |
|---|---|---|
| [#28](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/28) | In review | Ядро подключено к серверу; ошибочная/исправленная заявки, все статусы и эксплуатация проверены. Требуется review. |
| [#29](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/29) | In review | Явная правка создаёт v2, старые v1/report сохранены; live violated→holds. Требуется review. |
| [#30](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/30) | Ready | Один live-сценарий выполнен; корпус перефразирований/неоднозначностей с реальным LLM не прогонялся. |
| [#31](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/31) | In review | CI workflows и отчёты подготовлены; общая локальная интеграция 513 PASS. Финальный GitHub CI результат проверяется отдельно. |
| [#32](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/32) | In review | Рабочая область, API-клиент, адаптеры и UI-правки реализованы; визуальная приёмка пользователем pending. |
| [#33](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/33) | In review | Настоящие public entries/SSE, multi-turn, refresh/retry/cancel; live-диалог пройден. |
| [#34](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/34) | In review | Адресные ответы question_id, точные source_refs, исходные сообщения и требования сохраняются. |
| [#35](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/35) | In review | Переменные/переходы/правила, версии, подтверждение модели и source_refs подключены. |
| [#36](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/36) | In review | Ручная проверка выбранной версии по всем согласованным правилам; шесть статусов, без технических TLC-лимитов в UI. |
| [#37](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/37) | In review | Фактическая трасса/значения/первое нарушение и объяснение сохранённого отчёта; discuss заполняет draft. |
| [#38](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/38) | In review | Pending/retry/discard/cancel, SSE и refresh протестированы; StrictMode OpenAPI abort исправлен. |
| [#39](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/39) | In progress | Настоящий browser→GPT→TLC→fix→generation→ZIP→file answer→Docker 54/54 выполнен. Пользовательская визуальная/клавиатурная приёмка ещё pending. |
| [#40](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/40) | In review | React Flow, этапы/проекция, trace, guards/effects→новая версия, полноэкранный граф, wrap footer; UX-приёмка pending. |
| [#41](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/41) | In review | Детерминированный Python/FastAPI/pytest, immutable generation/hash; ошибочные реализации и контрпример проверены. |
| [#42](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/42) | Backlog | Исследование мультиагентного ревью/стоимости/задержки не выполнялось; зависит от корпусной оценки #30. |
| [#43](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/43) | In review | Реализованный кэш ядра включён в общий TLC-набор; PR56 ранее merged. Закрытие issue оставлено владельцу. |
| [#44](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/44) | In progress | Единый запуск и локальный итоговый прогон готовы; финальная UX-приёмка, корпус #30 и чистая установка не завершены. |
| [#45](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/45) | In review | TXT/MD/DOCX в UI; images API/vision/crop/recovery подключены, real pixel smoke PASS. Image→BehavioralModel и image UI отсутствуют. |
| [#46](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/46) | In review | HTTPS immutable snapshot/manifest/ranges/hash/context/analyze подключены к основному API; private-account/LLM/browser не прогонялись. |
| [#47](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/47) | In review | MCP SDK /mcp и 4 инструмента, policy/shared services подключены; arbitrary-code comparison unsupported. |
| [#48](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/48) | In review | Docker isolation/timeout/OOM/cancel/hostile tests PASS; owner cleanup не затрагивает чужие контейнеры. |
| [#49](https://github.com/kiruha355/Proveryalka_vipolnyalka/issues/49) | In review | Дерево/файлы/ZIP/tests и проверенный server file_context→GPT с сохранением истории; live ZIP+54/54 PASS. |
