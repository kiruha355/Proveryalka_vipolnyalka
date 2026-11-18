from ..behavior.expressions import BinaryExpression, LiteralExpression, UnaryExpression, VariableExpression


# Целые TLC — 32-битные со знаком; литерал -2^31 TLC не разбирает, поэтому диапазон симметричный.
INT_MIN, INT_MAX = -(2**31 - 1), 2**31 - 1
MAX_DEPTH = 32
BINARY = {
    "and": "/\\", "or": "\\/", "implies": "=>", "eq": "=", "ne": "#",
    "lt": "<", "le": "<=", "gt": ">", "ge": ">=", "add": "+", "sub": "-", "mul": "*",
}
ESCAPES = {'"': '\\"', "\\": "\\\\", "\n": "\\n", "\t": "\\t", "\r": "\\r", "\f": "\\f"}


class UnsupportedConstruct(ValueError):
    def __init__(self, path, message):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.reason = message


def variable_name(identifier):
    return f"v_{identifier}"


def transition_name(identifier):
    return f"t_{identifier}"


def property_name(identifier):
    return f"p_{identifier}"


def string(value, path="value"):
    if any(ord(char) < 32 and char not in ESCAPES for char in value):
        raise UnsupportedConstruct(path, "управляющие символы в строке не поддерживаются")
    return '"' + "".join(ESCAPES.get(char, char) for char in value) + '"'


def literal(value, path="value"):
    if type(value) is bool:
        return "TRUE" if value else "FALSE"
    if type(value) is int:
        if not INT_MIN <= value <= INT_MAX:
            raise UnsupportedConstruct(path, f"целое {value} не помещается в 32-битное целое TLC")
        return str(value) if value >= 0 else f"({value})"
    if type(value) is str:
        return string(value, path)
    raise UnsupportedConstruct(path, f"неподдерживаемый тип значения {type(value).__name__}")


def compile_expression(expression, path="expression", depth=0):
    """Переводит выражение DSL в TLA+; составные выражения всегда заключаются в скобки."""
    if depth > MAX_DEPTH:
        raise UnsupportedConstruct(path, f"глубина выражения превышает {MAX_DEPTH}")
    if isinstance(expression, LiteralExpression):
        return literal(expression.value, f"{path}.value")
    if isinstance(expression, VariableExpression):
        return variable_name(expression.name)
    if isinstance(expression, UnaryExpression):
        operand = compile_expression(expression.operand, f"{path}.operand", depth + 1)
        if expression.op == "not":
            return f"(~{operand})"
        if expression.op == "neg":
            return f"(-{operand})"
        raise UnsupportedConstruct(f"{path}.op", f"неподдерживаемая операция {expression.op}")
    if isinstance(expression, BinaryExpression):
        if expression.op not in BINARY:
            raise UnsupportedConstruct(f"{path}.op", f"неподдерживаемая операция {expression.op}")
        left = compile_expression(expression.left, f"{path}.left", depth + 1)
        right = compile_expression(expression.right, f"{path}.right", depth + 1)
        return f"({left} {BINARY[expression.op]} {right})"
    raise UnsupportedConstruct(path, f"неподдерживаемая конструкция {type(expression).__name__}")
