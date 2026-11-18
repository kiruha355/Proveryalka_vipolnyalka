# Доступ к GitHub: три независимые границы

Проверено 31.10.2026, 10:27 UTC. Диагностика read-only: без test writes, изменения авторизации, браузера, токенов или permissions.

| Канал | Подтверждённый результат | Вывод |
|---|---|---|
| Native GitHub connector: update issue #36 | Переданная root точная ошибка `403 Resource not accessible by integration`; documentation URL: `https://docs.github.com/rest/issues/issues#update-an-issue` | Credential приложения не имеет достаточных прав на эту операцию. Это не ошибка тела issue. |
| Native connector: get collaborator permission | Такой же 403 на read-only endpoint `.../collaborators/Mput13/permission` | Ограничение воспроизводится вне изменения issue. |
| Native connector: get_repo | Репозиторий публичный; `permissions.push=true`, `triage=true`, admin=false | Пользовательский repo Write существует, но не снимает ограничение credential приложения. |
| `gh api repos/.../collaborators/Mput13/permission` | `permission=write`, `role_name=write`, login=Mput13 | У текущей CLI-авторизации есть действующий доступ пользователя к репозиторию. Root уже подтвердил успешные create PR/push. |
| Native `list_installations` | В доступном ответе только installation 140406764 на аккаунте **Mput13**, repository_selection=all; kiruha355 не перечислен | Вероятная причина: app не установлено/не предоставлено этому connector на аккаунте владельца kiruha355. Точный набор выданных installation permissions ответом не раскрыт, поэтому конкретный missing grant окончательно не установлен. `all` здесь относится к выбранному аккаунту, а не ко всем чужим репозиториям пользователя. |
| GitHub CLI Projects | Переданная root ошибка `missing required scopes [read:project]` | CLI credential не авторизован для чтения Projects; для изменения требуется scope `project`. Это отдельный доступ от `repo`. |
| Browser Project #3 | GitHub `memex-viewer-privileges` для авторизованного Mput13: `role="read"`, `canCopy=true`, `canChangeProjectVisibility=false` | Точная роль чтения проекта подтверждена данными самой страницы, дополнительно карточки имеют `aria-disabled=true`. Repo Write не даёт Project Write. |

## Безопасный рабочий путь

1. Для разрешённых repo-изменений использовать уже настроенный `gh`, сохраняя точный текст native 403 как основание fallback. Не читать или переносить token.
2. Для колонок канбана владелец проекта kiruha355 или project Admin выдаёт Mput13 **Write**: Project → Settings → Manage access. Repo Write автоматически этим правом не является. Можно вместо этого выполнить разрешённые изменения в уже авторизованном браузере владельца.
3. Если использовать CLI для канбана, отдельно пройти штатное расширение OAuth scope `gh auth refresh -h github.com -s project`. Наличие scope не заменяет роль Write в конкретном проекте. В диагностике команда не запускалась.
4. Для восстановления native connector владелец аккаунта проверяет установку/доступ GitHub App к `kiruha355/Proveryalka_vipolnyalka` и разрешения Issues/Pull requests write. Только после явного исправления доступа имеет смысл повторить конкретную необходимую операцию; бесполезные test writes не нужны.

## Официальные основания

- GitHub определяет `Resource not accessible by integration` как недостаточные permissions credential GitHub App/fine-grained token: [REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible).
- Update issue требует Issues write либо Pull requests write для fine-grained credential: [Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue).
- У персонального Project отдельные Read / Write / Admin; Write позволяет просмотр и редактирование: [Managing access to user-level projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-access-to-your-projects#managing-access-for-user-level-projects).

NOT_RUN: изменение app installation/permissions, OAuth refresh, project membership change и проверка записи после такого изменения. Конфигурация и живые сессии не менялись.
