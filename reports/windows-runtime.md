# Windows-запуск и процессы (#81)

Проверены все опубликованные ветки репозитория и история файлов на 17–18.11.2026.
`processes.py` и `scripts/start-local.ps1` из описания аудита там отсутствуют.
Эта ветка содержит самостоятельные изменения поверх d68aa29; неизвестные локальные
Windows-правки не перезаписывались и не объявляются проверенными.

## Подготовка Windows

Нужны Python 3.10+ (для воспроизводимого тестирования 3.12), Node 22.12+,
Java 11+ (рекомендуется 21), Git, Docker Desktop в режиме Linux containers.
В PowerShell из корня проекта:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-runtime.lock
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
npm --prefix frontend ci
npm --prefix frontend run build
# Git Bash: скачивание TLC с обязательной проверкой закреплённого SHA-256
bash scripts/fetch_tla2tools.sh
.\.venv\Scripts\python.exe -m proveryalka.codegen sandbox-build
.\scripts\start-local.ps1 -Java 'C:\Program Files\Java\jdk-21\bin\java.exe' -TlcJar '.\tools\tla2tools.jar' -DataDir 'C:\My projects\proveryalka data' -CheckOnly
.\scripts\start-local.ps1 -Java 'C:\Program Files\Java\jdk-21\bin\java.exe' -DataDir 'C:\My projects\proveryalka data'
```

Параметры передаются отдельными аргументами, без Invoke-Expression/cmd /c.
.env загружается python-dotenv. Java выбирается в порядке: явно заданный путь /
PROVERYALKA_JAVA → JAVA_HOME/bin/java → PATH. Явно неверный путь не маскируется
fallback. Java 8 отклоняется до миграции БД и запуска сервера с инструкцией,
какую настройку исправить. Пустой/отсутствующий frontend build, Node, Docker daemon
или sandbox image дают ошибку preflight. Launcher ничего не скачивает автоматически.
Если политика исполнения блокирует ps1, используйте установленную политику своей
организации или эквивалентный вызов Python ниже; отключать политику не требуется.

Codex app-server должен быть нативным `codex.exe`, заданным через
`PROVERYALKA_CODEX_BIN`; .cmd/.bat shim намеренно отклоняется без запуска shell.
Авторизация выполняется через `codex login` вне приложения.

## Unix и общий Python-вход

```sh
.venv/bin/python -m proveryalka.launch --env-file .env --data-dir '/path/with spaces/data' --check-only
.venv/bin/python -m proveryalka.launch --env-file .env --data-dir '/path/with spaces/data'
# Прежняя поставка также работает (без обязательной проверки Docker):
sh scripts/run-stack.sh --data-dir '/path/with spaces/data'
```

Ctrl+C завершает сервер и принадлежащие ему задачи. TLC/Codex/Docker CLI
запускаются отдельной группой. Unix использует SIGTERM/SIGKILL этой группы;
Windows использует taskkill /PID <PID своего живого процесса> /T /F. Нет убийства
по имени java/node/docker и глобальных cleanup. Контейнеры по-прежнему удаляются
только после проверки owner label и точного container ID. Директория данных не
удаляется при остановке. Для проверки перезапуска используйте отдельный временный
DataDir и один и тот же путь при втором старте.

Symlink в git-тесте создаётся записью mode=120000 в настоящем git index: права
Windows на файловые symlink не нужны. Проверка HTTP-отказа по пути выполняется
всегда; дополнительный тест реального symlink явно skipped при WinError 1314 с
инструкцией о Developer Mode/правах. Другие ошибки не скрываются.

Локальная проверка выполнена на macOS, включая настоящий дочерний процесс,
сохранение постороннего процесса, пути с пробелами и диагностику Java 8.
Windows/PowerShell и Docker Desktop на этой машине отсутствуют; нативный прогон
Windows и сверка с незакоммиченными исправлениями автора аудита остаются открыты.
