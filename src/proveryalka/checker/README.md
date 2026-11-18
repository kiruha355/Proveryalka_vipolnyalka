# Проверяющее ядро на TLC

Пакет `proveryalka.checker` переводит `BehavioralModel 1.0` в TLA+, запускает настоящие SANY и TLC
и возвращает `VerificationReport` по общему контракту `proveryalka.verification`. LLM и HTTP не участвуют:
ядро детерминировано, агент и сервер вызывают одну и ту же функцию.

```text
модель → контракт и preflight → Spec.tla + cfg на свойство → SANY → TLC (процесс на свойство) → разбор → сверка с семантикой модели → отчёт
```

## Установка

1. Java 11+ (в CI — Temurin 21).
2. `tla2tools.jar` закреплённой версии:

   ```bash
   sh scripts/fetch_tla2tools.sh
   ```

   Скрипт кладёт jar в `tools/` (каталог не коммитится) и сверяет sha256. Версия и хэш записаны в самом скрипте;
   при смене версии меняют обе строки.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PROVERYALKA_JAVA` | `java` | Путь к Java |
| `PROVERYALKA_TLA_JAR` | `tools/tla2tools.jar` | Путь к tla2tools.jar |
| `PROVERYALKA_TLC_HEAP_MB` | `512` | `-Xmx` для каждого процесса TLC |
| `PROVERYALKA_TLC_PARALLEL` | `2` | Сколько свойств проверяется одновременно |
| `PROVERYALKA_ARTIFACTS_PATH` | `data/artifacts` | Комплекты запусков: `<path>/checks/<run_id>/` |
| `PROVERYALKA_CHECK_CACHE` | `data/check-cache` | Кэш завершённых результатов; пустая строка выключает |

## Использование

Из Python, без веб-сервера:

```python
import asyncio
from pathlib import Path

from proveryalka.behavior import BehavioralModel
from proveryalka.checker import TLCChecker
from proveryalka.verification import CheckLimits, check_behavior

model = BehavioralModel.model_validate_json(Path("tests/fixtures/models/order_bug.json").read_text())
report = asyncio.run(check_behavior(model, TLCChecker(), ["NoCancelledExecution"], CheckLimits(timeout_seconds=10)))
print(report.results[0].status, [step.transition_id for step in report.results[0].trace])
# PROPERTY_VIOLATED [None, 'Approve', 'Cancel', 'Execute']
```

`check_behavior` из `proveryalka.verification` дополнительно сверяет отчёт с моделью и пересчитывает
`related_requirements`. Тот же `TLCChecker` передаётся агенту: `verify_and_explain(model, TLCChecker(), ...)`.

Для серверного адаптера есть `TLCChecker.run(request, run_id=None)`: возвращает `CheckRun` с `run_id`,
отчётом, каталогом материалов и списком свойств, взятых из кэша. `TLCChecker.cancel(run_id)` останавливает запуск.

Командная строка:

```bash
python -m proveryalka.checker check tests/fixtures/models/order_bug.json
python -m proveryalka.checker check model.json --property P1 --timeout 10 --max-states 50000 --max-depth 20 --json
python -m proveryalka.checker replay data/artifacts/checks/chk_0123456789abcdef
python -m proveryalka.checker schema request
python -m proveryalka.checker < request.json > report.json
```

Последняя форма — протокол `CommandChecker`: `VerificationRequest` в stdin, `VerificationReport` в stdout,
код 0 при любом статусе проверки. Некорректный вход даёт код 2 и список проблем с путями к полям в stderr.
`schema model|request|report` печатает JSON Schema контрактов.

## Поддерживаемый DSL

| Выражение DSL | TLA+ |
|---|---|
| `literal` boolean / integer / строка enum | `TRUE`/`FALSE`, `5`, `(-5)`, `"Created"` |
| `variable` | `v_<id>` |
| `unary not`, `unary neg` | `(~x)`, `(-x)` |
| `and`, `or`, `implies` | `(a /\ b)`, `(a \/ b)`, `(a => b)` |
| `eq`, `ne`, `lt`, `le`, `gt`, `ge` | `=`, `#`, `<`, `<=`, `>`, `>=` |
| `add`, `sub`, `mul` | `+`, `-`, `*` |

- Каждое составное выражение заключается в скобки: приоритеты TLA+ не влияют на смысл.
- Идентификаторы получают префиксы `v_`, `t_`, `p_`: имя `Next` или `ENABLED` не столкнётся с ключевыми словами.
- Строки экранируются (`\"`, `\\`, `\n`, `\t`, `\r`, `\f`); другие управляющие символы отклоняются. Входной текст
  никогда не вставляется в TLA+ без разбора, названия в комментариях схлопываются в одну строку.
- Целые — 32-битные TLC, диапазон `[-(2^31-1), 2^31-1]`. До запуска Java интервальный анализ по областям
  переменных ищет возможное переполнение и возвращает `MODEL_INVALID` с путём к выражению.
- Глубина выражения — не больше 32.
- Принадлежности множеству (`in`), деления, кванторов и множеств в контракте нет. «Статус Created или Approved»
  записывается как `or` двух `eq`.

Семантика перехода: guard проверяется в текущем состоянии, все правые части `effects` вычисляются по исходному
состоянию (одновременное присваивание), неупомянутые переменные сохраняются через `UNCHANGED`. Неявного
«ничего не произошло» нет. Если переход выводит значение за область переменной, это `MODEL_INVALID`
с путём к шагу: ядро не отбрасывает такие переходы молча.

## Свойства

Каждое свойство проверяется отдельным запуском TLC со своей конфигурацией: результат одного свойства
не переносится на другие.

| kind | Что проверяется | Нарушение | Успех |
|---|---|---|---|
| `invariant` | предикат истинен во всех достижимых состояниях | `PROPERTY_VIOLATED` + путь к первому нарушению | `PROPERTY_HOLDS` после полного перебора |
| `forbidden_state` | ни одно достижимое состояние не удовлетворяет предикату | `PROPERTY_VIOLATED` + путь | `PROPERTY_HOLDS` после полного перебора |
| `reachable` | существует путь к состоянию с предикатом | `PROPERTY_VIOLATED` без трассы, только после полного перебора | `PROPERTY_HOLDS` + путь к цели |
| `deadlock_free` | в каждом состоянии разрешён переход либо состояние — согласованное завершение | `PROPERTY_VIOLATED` + путь к тупику | `PROPERTY_HOLDS` после полного перебора |

Для `deadlock_free` предикат описывает допустимые конечные состояния: `status = Cancelled or status = Executed`.
Литерал `false` означает, что останавливаться нельзя нигде. Других исключений ядро не добавляет.

TLC ищет в ширину одним воркером, поэтому трасса кратчайшая, а при повторе та же. Каждый шаг трассы ядро
сверяет с семантикой модели (`behavior.step`); при расхождении результат — `ENGINE_ERROR`, а не угаданный переход.

## Статусы

| Статус | Когда | Окончательный |
|---|---|---|
| `PROPERTY_HOLDS` | TLC полностью перебрал конечную модель в пределах лимитов и не нашёл нарушения; для `reachable` — нашёл путь | да |
| `PROPERTY_VIOLATED` | найдено нарушение с трассой; для `reachable` — цель недостижима после полного перебора | да |
| `MODEL_INVALID` | ошибка контракта, переполнение целого, значение вне области во время перебора | нет |
| `TIMEOUT` | истекло `timeout_seconds` | нет |
| `STATE_LIMIT_REACHED` | различных состояний больше `max_states` или глубина больше `max_depth` | нет |
| `ENGINE_ERROR` | нет Java/jar (`ENGINE_UNAVAILABLE`), отмена (`CANCELLED`), SANY отклонил спецификацию, сбой или непонятный вывод TLC | нет |

**Что значит `PROPERTY_HOLDS`.** Свойство выполняется во всех состояниях *этой конечной модели* с её областями
значений. Это не доказательство корректности работающего приложения: вывод верен, пока модель верно описывает
процесс, а области не меньше реальных. `TIMEOUT` и `STATE_LIMIT_REACHED` никогда не считаются успехом.
Ошибка разбора вывода TLC никогда не превращается в `PROPERTY_HOLDS`: успех требует кода 0, сообщения TLC
«No error has been found» и статистики перебора.

## Лимиты

- `timeout_seconds` — общий бюджет запроса. Ядро ставит себе срок чуть раньше (минус 10 %, не больше 1 с),
  чтобы успеть остановить процессы и записать материалы. Свойства, до которых очередь не дошла, получают `TIMEOUT`.
- `max_states` — сторожевой инвариант `TLCGet("distinct") <= max_states`.
- `max_depth` — сторожевой инвариант `TLCGet("level") <= max_depth + 1`; у начального состояния уровень 1.
  Нарушение на меньшей глубине найдётся раньше сторожа, потому что поиск идёт в ширину.

Остановка: процесс TLC запускается в своей группе. По сроку или `cancel(run_id)` группа получает SIGTERM,
через 2 с — SIGKILL. При внешней отмене задачи (`asyncio`) процессы тоже завершаются, а манифест помечается
`"interrupted": true`. Причина остановки записывается в манифест (`stopped`, `reason`).

## Комплект материалов

```text
data/artifacts/checks/<run_id>/
  request.json          запрос: модель, свойства, лимиты, version_id
  Spec.tla              сгенерированная спецификация
  sany.stdout.log       вывод SANY
  properties/<P>/
    Spec.cfg            конфигурация свойства
    tlc.stdout.log      вывод TLC (-tool)
    tlc.stderr.log
    trace.json          контрпример TLC (-dumpTrace json), если есть
    changes.json        изменённые переменные по шагам
  report.json           итоговый VerificationReport
  manifest.json         версия TLC, sha256 jar, версия Java, лимиты, команды, коды выхода, длительности, хэши файлов
```

Параллельные запуски пишут в разные каталоги; временные каталоги JVM и `states/` TLC удаляются после прогона.
В манифест не попадают окружение процесса и абсолютный путь к jar. Серверу файлы отдаются только по манифесту:
`ArtifactStore(root).bundle(run_id).open(name)` отклоняет имена вне перечня и попытки выйти из каталога.

Воспроизведение: `python -m proveryalka.checker replay <каталог>` проверяет хэши комплекта, повторяет прогон
без кэша и сравнивает статусы и трассы (код 3 при расхождении). Вручную — команды из `manifest.json`,
выполненные в каталоге комплекта с тем же jar.

## Кэш

Ключ — `spec_hash` модели, `property_id`, версия TLC с отпечатком jar и версия перевода в TLA+
(`COMPILER_VERSION`). Переиспользуются только `PROPERTY_HOLDS` и `PROPERTY_VIOLATED` и только если новые лимиты
не меньше фактически пройденных (различных состояний и глубины). Сообщение такого результата начинается с
`[из кэша]`, а `CheckRun.cached` и манифест перечисляют такие свойства.

## Тесты

```bash
python -m pytest tests/test_checker.py          # без Java: компилятор, генератор, разбор записанного вывода TLC
python -m pytest tests/test_checker_tlc.py      # настоящие SANY/TLC
PROVERYALKA_REQUIRE_TLC=1 python -m pytest      # как в CI: без TLC набор падает, а не пропускается
```

Эталонные модели и ручные ожидания: `tests/fixtures/models/` (`build.py` их генерирует, `expected.json` — ожидания).
Записанный вывод TLC для тестов разбора: `tests/fixtures/tlc/`. В CI при падении материалы прогонов
выгружаются артефактом `tlc-runs`.

## Что осталось серверу

Маршруты `POST /api/models/{id}/versions/{n}/checks`, `GET /api/checks/{id}` и `GET /api/checks/{id}/artifacts/{name}`
ждут хранилища версий моделей. Адаптеру остаётся найти `spec` версии, вызвать `TLCChecker.run`
и отдавать файлы через `RunBundle.open`.
