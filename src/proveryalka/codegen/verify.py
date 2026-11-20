"""Статическая проверка app/rules.py без выполнения сгенерированного кода.

Модуль правил разбирается через ast и сверяется с белым списком конструкций: импорт dataclass/Callable,
класс Transition, функции guard_*/effects_* из одного return с выражением над `s[...]`, таблица
TRANSITIONS. Разрешённые выражения вычисляются интерпретатором ниже: так семантику сгенерированных
правил можно сравнить с proveryalka.behavior на хосте, не импортируя и не исполняя файл.
"""
import ast
import operator


class UnsafeCode(ValueError):
    pass


COMPARE = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le,
           ast.Gt: operator.gt, ast.GtE: operator.ge}
ARITHMETIC = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul}
TRANSITION_FIELDS = ("id", "name", "requirement_ids", "assigns", "guard", "effects")


def fail(node, reason):
    raise UnsafeCode(f"line {getattr(node, 'lineno', '?')}: {reason}")


def check_expression(node):
    if isinstance(node, ast.Constant) and type(node.value) in (bool, int, str):
        return
    if isinstance(node, ast.Subscript):
        if not (isinstance(node.value, ast.Name) and node.value.id == "s" and isinstance(node.ctx, ast.Load)
                and isinstance(node.slice, ast.Constant) and type(node.slice.value) is str):
            fail(node, "only s['name'] lookups are allowed")
        return
    if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)) and len(node.values) == 2:
        for value in node.values:
            check_expression(value)
        return
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.Not, ast.USub)):
        check_expression(node.operand)
        return
    if isinstance(node, ast.BinOp) and type(node.op) in ARITHMETIC:
        check_expression(node.left)
        check_expression(node.right)
        return
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in COMPARE:
        check_expression(node.left)
        check_expression(node.comparators[0])
        return
    fail(node, f"{type(node).__name__} is not allowed in rules")


def evaluate(node, state):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Subscript):
        return state[node.slice.value]
    if isinstance(node, ast.BoolOp):
        left = evaluate(node.values[0], state)
        if isinstance(node.op, ast.And):
            return left and evaluate(node.values[1], state)
        return left or evaluate(node.values[1], state)
    if isinstance(node, ast.UnaryOp):
        value = evaluate(node.operand, state)
        return not value if isinstance(node.op, ast.Not) else -value
    if isinstance(node, ast.BinOp):
        return ARITHMETIC[type(node.op)](evaluate(node.left, state), evaluate(node.right, state))
    return COMPARE[type(node.ops[0])](evaluate(node.left, state), evaluate(node.comparators[0], state))


def single_return(function):
    args = function.args
    if (function.decorator_list or function.returns or len(args.args) != 1 or args.args[0].arg != "s"
            or args.posonlyargs or args.kwonlyargs or args.vararg or args.kwarg or args.defaults or args.args[0].annotation):
        fail(function, "rule functions take exactly one parameter s")
    if len(function.body) != 1 or not isinstance(function.body[0], ast.Return) or function.body[0].value is None:
        fail(function, "rule functions consist of a single return")
    return function.body[0].value


def constant_tuple(node):
    if not isinstance(node, ast.Tuple) or any(not (isinstance(item, ast.Constant) and type(item.value) is str) for item in node.elts):
        fail(node, "expected a tuple of strings")
    return tuple(item.value for item in node.elts)


def load_rules(source):
    """Возвращает {transition_id: {"guard": ast, "effects": {variable: ast}, ...}} или поднимает UnsafeCode."""
    tree = ast.parse(source)
    guards, effects, table = {}, {}, None
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and type(node.value.value) is str:
            continue
        if isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module, tuple(a.name for a in node.names)) in {("dataclasses", ("dataclass",)), ("typing", ("Callable",))} and all(a.asname is None for a in node.names):
            continue
        if isinstance(node, ast.ClassDef) and node.name == "Transition":
            if node.bases or node.keywords or len(node.decorator_list) != 1:
                fail(node, "unexpected Transition definition")
            decorator = node.decorator_list[0]
            if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name) and decorator.func.id == "dataclass"
                    and not decorator.args and [(k.arg, getattr(k.value, "value", None)) for k in decorator.keywords] == [("frozen", True)]):
                fail(node, "unexpected Transition decorator")
            if [(item.target.id, item.value) for item in node.body if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name)] != [(name, None) for name in TRANSITION_FIELDS] or len(node.body) != len(TRANSITION_FIELDS):
                fail(node, "unexpected Transition fields")
            for item in node.body:
                if not (isinstance(item.annotation, ast.Name) and item.annotation.id in ("str", "tuple", "Callable")):
                    fail(item, "unexpected annotation")
            continue
        if isinstance(node, ast.FunctionDef) and node.name.startswith("guard_"):
            value = single_return(node)
            check_expression(value)
            guards[node.name[6:]] = value
            continue
        if isinstance(node, ast.FunctionDef) and node.name.startswith("effects_"):
            value = single_return(node)
            if not isinstance(value, ast.Dict) or any(not (isinstance(k, ast.Constant) and type(k.value) is str) for k in value.keys):
                fail(node, "effects return a dict literal with constant keys")
            for item in value.values:
                check_expression(item)
            effects[node.name[8:]] = {k.value: v for k, v in zip(value.keys, value.values, strict=True)}
            continue
        if isinstance(node, ast.Assign) and [getattr(t, "id", None) for t in node.targets] == ["TRANSITIONS"] and table is None:
            table = node.value
            continue
        fail(node, f"{type(node).__name__} is not allowed at module level")
    if not isinstance(table, ast.Dict):
        fail(tree, "TRANSITIONS table is missing")
    rules = {}
    for key, call in zip(table.keys, table.values, strict=True):
        if not (isinstance(key, ast.Constant) and type(key.value) is str and isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name) and call.func.id == "Transition" and not call.args
                and [k.arg for k in call.keywords] == list(TRANSITION_FIELDS)):
            fail(call, "unexpected TRANSITIONS entry")
        fields = {k.arg: k.value for k in call.keywords}
        tid = key.value
        if not (isinstance(fields["id"], ast.Constant) and fields["id"].value == tid and isinstance(fields["name"], ast.Constant) and type(fields["name"].value) is str):
            fail(call, "transition id/name mismatch")
        if not (isinstance(fields["guard"], ast.Name) and fields["guard"].id == f"guard_{tid}" and isinstance(fields["effects"], ast.Name) and fields["effects"].id == f"effects_{tid}"):
            fail(call, "transition must reference its own guard/effects")
        if tid not in guards or tid not in effects or tuple(effects[tid]) != constant_tuple(fields["assigns"]):
            fail(call, "guard/effects/assigns mismatch")
        rules[tid] = {"name": fields["name"].value, "requirement_ids": constant_tuple(fields["requirement_ids"]),
                      "guard": guards[tid], "effects": effects[tid]}
    if set(guards) != set(rules) or set(effects) != set(rules):
        fail(tree, "unreferenced rule functions")
    return rules


def apply(rules, contains, state, transition_id):
    """Семантика сгенерированного engine.apply над разобранными правилами; contains(state) проверяет области."""
    rule = rules[transition_id]
    if not evaluate(rule["guard"], state):
        return "not_enabled", None
    following = {**state, **{name: evaluate(node, state) for name, node in rule["effects"].items()}}
    if not contains(following):
        return "out_of_domain", None
    return "applied", following
