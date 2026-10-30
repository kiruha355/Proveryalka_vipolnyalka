"""Генератор эталонных моделей: python tests/fixtures/models/build.py

JSON-файлы рядом — результат этого скрипта; правьте модели здесь и перегенерируйте.
Ожидаемые статусы (ручные эталоны) лежат в expected.json и не зависят от логов TLC.
"""
import copy
import json
from pathlib import Path


HERE = Path(__file__).parent


def var(name):
    return {"kind": "variable", "name": name}


def lit(value):
    return {"kind": "literal", "value": value}


def op(name, left, right):
    return {"kind": "binary", "op": name, "left": left, "right": right}


def no(operand):
    return {"kind": "unary", "op": "not", "operand": operand}


def both(*items):
    result = items[0]
    for item in items[1:]:
        result = op("and", result, item)
    return result


def model(name, requirements, variables, transitions, properties):
    text = "\n".join(requirements.values())
    reqs, offset = [], 0
    for identifier, sentence in requirements.items():
        reqs.append({"id": identifier, "text": sentence, "source_refs": [
            {"source_id": "source1", "quote": sentence, "start": offset, "end": offset + len(sentence)},
        ]})
        offset += len(sentence) + 1
    return {
        "schema_version": "1.0", "name": name,
        "sources": [{"id": "source1", "session_id": "fixtures", "kind": "text", "text": text}],
        "requirements": reqs, "variables": variables, "transitions": transitions, "properties": properties,
    }


def variable(identifier, name, domain, initial, reqs=("R1",)):
    return {"id": identifier, "name": name, "requirement_ids": list(reqs), "domain": domain, "initial_value": initial}


def transition(identifier, name, reqs, guard, **effects):
    return {"id": identifier, "name": name, "requirement_ids": list(reqs), "guard": guard,
            "effects": [{"variable": key, "value": value} for key, value in effects.items()]}


def prop(identifier, name, reqs, kind, predicate):
    return {"id": identifier, "name": name, "requirement_ids": list(reqs), "kind": kind,
            "predicate": predicate, "explanation": name}


BOOL = {"kind": "boolean"}


def order(fixed):
    requirements = {
        "R1": "Заявка имеет статус Created, Approved, Cancelled или Executed; признаки approved и cancelled логические. Изначально Created, approved=false, cancelled=false.",
        "R2": "Заявку в статусе Created можно согласовать: статус Approved, approved=true.",
        "R3": "Заявку в статусе Created или Approved можно отменить: статус Cancelled, cancelled=true"
              + (", согласование снимается: approved=false." if fixed else "."),
        "R4": "Исполнить можно только согласованную заявку: статус Executed.",
        "R5": "Отменённая заявка не должна быть исполнена.",
        "R6": "Процесс может завершиться только отменой или исполнением.",
    }
    status = var("status")
    cancel = {"status": lit("Cancelled"), "cancelled": lit(True)}
    if fixed:
        cancel["approved"] = lit(False)
    return model(
        "Заявка" + (" (исправлено)" if fixed else ""), requirements,
        [
            variable("status", "Статус заявки", {"kind": "enum", "values": ["Created", "Approved", "Cancelled", "Executed"]}, "Created"),
            variable("approved", "Согласована", BOOL, False),
            variable("cancelled", "Отменена", BOOL, False),
        ],
        [
            transition("Approve", "Согласовать", ["R2"], op("eq", status, lit("Created")), status=lit("Approved"), approved=lit(True)),
            transition("Cancel", "Отменить", ["R3"], op("or", op("eq", status, lit("Created")), op("eq", status, lit("Approved"))), **cancel),
            transition("Execute", "Исполнить", ["R4"], op("eq", var("approved"), lit(True)), status=lit("Executed")),
        ],
        [
            prop("NoCancelledExecution", "Отменённая заявка не исполняется", ["R5"], "forbidden_state",
                 both(var("cancelled"), op("eq", status, lit("Executed")))),
            prop("CanExecute", "Заявку можно исполнить", ["R4"], "reachable", op("eq", status, lit("Executed"))),
            prop("EndsProperly", "Завершение только отменой или исполнением", ["R6"], "deadlock_free",
                 op("or", op("eq", status, lit("Cancelled")), op("eq", status, lit("Executed")))),
        ],
    )


def tickets():
    requirements = {
        "R1": "Продажа открыта или закрыта; продано от 0 до 3 билетов; vip-продажа выполнялась или нет. Изначально продажа открыта, продано 0, vip не было.",
        "R2": "Пока продажа открыта и продано меньше 3, можно продать один билет.",
        "R3": "Пока продажа открыта, продано меньше 2 и vip-продажи не было, можно продать vip-пару из двух билетов.",
        "R4": "Открытую продажу можно закрыть.",
        "R5": "Закрытую продажу можно открыть снова, если билеты остались.",
        "R6": "Продано не больше 3 билетов.",
        "R7": "После vip-продажи зал не заполняется полностью.",
        "R8": "Должна быть возможность закрыть полностью распроданную продажу.",
        "R9": "Vip-продажа без проданных билетов невозможна.",
        "R10": "Процесс останавливается только закрытием распроданной продажи.",
        "R11": "Процесс не должен останавливаться никогда.",
        "R12": "Хотя бы один билет продан всегда.",
    }
    phase, sold, vip = var("phase"), var("sold"), var("vip")
    is_open = op("eq", phase, lit("Open"))
    closed_full = both(op("eq", phase, lit("Closed")), op("eq", sold, lit(3)))
    return model(
        "Продажа билетов", requirements,
        [
            variable("phase", "Состояние продажи", {"kind": "enum", "values": ["Open", "Closed"]}, "Open"),
            variable("sold", "Продано билетов", {"kind": "integer", "minimum": 0, "maximum": 3}, 0),
            variable("vip", "Была vip-продажа", BOOL, False),
        ],
        [
            transition("Sell", "Продать билет", ["R2"], both(is_open, op("lt", sold, lit(3))), sold=op("add", sold, lit(1))),
            transition("SellVip", "Продать vip-пару", ["R3"], both(is_open, op("lt", sold, lit(2)), no(vip)),
                       sold=op("add", sold, lit(2)), vip=lit(True)),
            transition("Close", "Закрыть продажу", ["R4"], is_open, phase=lit("Closed")),
            transition("Reopen", "Открыть снова", ["R5"], both(op("eq", phase, lit("Closed")), op("lt", sold, lit(3))), phase=lit("Open")),
        ],
        [
            prop("Capacity", "Не больше трёх билетов", ["R6"], "invariant", op("le", sold, lit(3))),
            prop("VipNotFull", "После vip зал не полон", ["R7"], "invariant", no(both(vip, op("eq", sold, lit(3))))),
            prop("ClosedSoldOut", "Можно закрыть распроданную продажу", ["R8"], "reachable", closed_full),
            prop("VipWithoutSales", "Vip без продаж", ["R9"], "reachable", both(vip, op("eq", sold, lit(0)))),
            prop("StopsOnlySoldOut", "Остановка только у распроданной закрытой продажи", ["R10"], "deadlock_free", closed_full),
            prop("NeverStops", "Без остановок", ["R11"], "deadlock_free", lit(False)),
            prop("SomethingSold", "Хотя бы один билет продан", ["R12"], "invariant", op("gt", sold, lit(0))),
        ],
    )


def counter(name, maximum, step_to=None):
    requirements = {
        "R1": f"Счётчик принимает значения от 0 до {maximum}, изначально 0.",
        "R2": "Счётчик можно увеличить на единицу.",
        "R3": "Счётчик не бывает отрицательным.",
    }
    n = var("n")
    guard = lit(True) if step_to is None else op("lt", n, lit(step_to))
    return model(name, requirements,
                 [variable("n", "Счётчик", {"kind": "integer", "minimum": 0, "maximum": maximum}, 0)],
                 [transition("Inc", "Увеличить", ["R2"], guard, n=op("add", n, lit(1)))],
                 [prop("NonNegative", "Неотрицательность", ["R3"], "invariant", op("ge", n, lit(0)))])


def grid(size):
    requirements = {
        "R1": f"Координаты x и y принимают значения от 0 до {size - 1}, изначально 0.",
        "R2": "Каждую координату можно увеличить, пока она меньше максимума.",
        "R3": "Сумма координат неотрицательна.",
    }
    x, y = var("x"), var("y")
    top = size - 1
    return model(f"Решётка {size}x{size}", requirements,
                 [variable("x", "x", {"kind": "integer", "minimum": 0, "maximum": top}, 0),
                  variable("y", "y", {"kind": "integer", "minimum": 0, "maximum": top}, 0)],
                 [transition("IncX", "Увеличить x", ["R2"], op("lt", x, lit(top)), x=op("add", x, lit(1))),
                  transition("IncY", "Увеличить y", ["R2"], op("lt", y, lit(top)), y=op("add", y, lit(1))),
                  transition("Reset", "Сбросить", ["R2"], op("eq", x, lit(top)), x=lit(0), y=lit(0))],
                 [prop("SumNonNegative", "Сумма неотрицательна", ["R3"], "invariant", op("ge", op("add", x, y), lit(0)))])


def invalid_cases(base):
    def case(name, path, message, mutate):
        data = copy.deepcopy(base)
        mutate(data)
        return {"name": name, "path": path, "message": message, "model": data}

    variables = lambda data: {item["id"]: item for item in data["variables"]}  # noqa: E731
    transitions = lambda data: {item["id"]: item for item in data["transitions"]}  # noqa: E731
    return [
        case("initial_outside_domain", "variables.sold.initial_value", "вне области",
             lambda d: variables(d)["sold"].update(initial_value=7)),
        case("boolean_instead_of_integer", "variables.sold.initial_value", "вне области",
             lambda d: variables(d)["sold"].update(initial_value=True)),
        case("missing_initial_value", "variables.1.initial_value", "Field required",
             lambda d: variables(d)["sold"].pop("initial_value")),
        case("empty_enum", "variables.0.domain.values", "at least 1",
             lambda d: variables(d)["phase"]["domain"].update(values=[])),
        case("reversed_range", "variables.1.domain", "Нижняя граница",
             lambda d: variables(d)["sold"]["domain"].update(minimum=5, maximum=1)),
        case("unknown_variable", "transitions.Sell.guard.left", "Неизвестная переменная",
             lambda d: transitions(d)["Sell"].update(guard=op("and", var("ghost"), lit(True)))),
        case("type_mismatch", "transitions.Close.guard", "Ожидался тип boolean",
             lambda d: transitions(d)["Close"].update(guard=op("add", var("sold"), lit(1)))),
        case("enum_value_unknown", "transitions.Close.guard.right", "отсутствует в enum",
             lambda d: transitions(d)["Close"].update(guard=op("eq", var("phase"), lit("Archived")))),
        case("repeated_assignment", "transitions.Close.effects", "Повторное присваивание",
             lambda d: transitions(d)["Close"]["effects"].append({"variable": "phase", "value": lit("Open")})),
        case("literal_outside_domain", "transitions.Close.effects[0].value", "вне области",
             lambda d: transitions(d)["Close"]["effects"][0].update(value=lit("Archived"))),
        case("unsupported_operation", "transitions.0.guard.op", "Input should be",
             lambda d: transitions(d)["Sell"].update(guard={"kind": "binary", "op": "div", "left": var("sold"), "right": lit(2)})),
        case("duplicate_transition", "transitions.Close", "Повторяющийся ID",
             lambda d: d["transitions"].append(copy.deepcopy(transitions(d)["Close"]))),
        case("unknown_requirement", "properties.Capacity.requirement_ids", "Недостоверная ссылка",
             lambda d: d["properties"][0].update(requirement_ids=["R99"])),
    ]


def main():
    models = {
        "order_bug": order(False),
        "order_fixed": order(True),
        "tickets": tickets(),
        "counter_overflow": counter("Счётчик без ограничения роста", 2),
        "grid": grid(3000),
    }
    for name, data in models.items():
        (HERE / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (HERE / "invalid_models.json").write_text(
        json.dumps(invalid_cases(models["tickets"]), ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )


if __name__ == "__main__":
    main()
