"""Перевод выражений BehavioralModel в исходный текст Python и безопасная вставка текста модели.

Строки модели попадают в код только как литералы repr() или как однострочные комментарии;
идентификаторы Python строятся лишь из ID с шаблоном ^[A-Za-z][A-Za-z0-9_]*$.
"""
from ..behavior.expressions import BinaryExpression, LiteralExpression, UnaryExpression, VariableExpression
from .scope import UnsupportedModel


BINARY = {
    "and": "and", "or": "or", "eq": "==", "ne": "!=", "lt": "<", "le": "<=",
    "gt": ">", "ge": ">=", "add": "+", "sub": "-", "mul": "*",
}


def literal(value):
    if type(value) is bool:
        return "True" if value else "False"
    if type(value) is int:
        return str(value)
    if type(value) is str:
        return repr(value)
    if isinstance(value, tuple):
        items = ", ".join(literal(item) for item in value)
        return f"({items},)" if len(value) == 1 else f"({items})"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{literal(key)}: {literal(item)}" for key, item in value.items()) + "}"
    raise TypeError(f"Unsupported literal type: {type(value).__name__}")


def compile_expression(expression, state="s", path="expression", top=True):
    """Каждое составное подвыражение в скобках: нет цепочек сравнений Python и вопросов приоритета."""
    if isinstance(expression, LiteralExpression):
        text = literal(expression.value)
        return text if top or not text.startswith("-") else f"({text})"
    if isinstance(expression, VariableExpression):
        return f"{state}[{expression.name!r}]"
    if isinstance(expression, UnaryExpression):
        operand = compile_expression(expression.operand, state, f"{path}.operand", top=False)
        text = f"not {operand}" if expression.op == "not" else f"-{operand}"
    elif isinstance(expression, BinaryExpression):
        left = compile_expression(expression.left, state, f"{path}.left", top=False)
        right = compile_expression(expression.right, state, f"{path}.right", top=False)
        if expression.op == "implies":
            text = f"(not {left}) or {right}"
        else:
            text = f"{left} {BINARY[expression.op]} {right}"
    else:
        raise UnsupportedModel([{"path": path, "reason": f"Конструкция {type(expression).__name__} не поддерживается"}])
    return text if top else f"({text})"


def variables_read(expression):
    if isinstance(expression, VariableExpression):
        return {expression.name}
    if isinstance(expression, UnaryExpression):
        return variables_read(expression.operand)
    if isinstance(expression, BinaryExpression):
        return variables_read(expression.left) | variables_read(expression.right)
    return set()


def one_line(text, limit=240):
    """Одна строка без управляющих и невидимых символов (переводы строк, bidi и т.п. экранируются)."""
    text = " ".join(str(text).split())
    text = "".join(char if char.isprintable() else char.encode("unicode_escape").decode("ascii") for char in text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def comment(text, limit=240):
    return "# " + one_line(text, limit)


def markdown(text, limit=1000):
    """Текст модели в Markdown без HTML и разметки таблиц."""
    text = one_line(text, limit)
    for source, target in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ("|", "\\|"), ("`", "\\`"), ("*", "\\*"), ("_", "\\_"), ("[", "\\["), ("]", "\\]")):
        text = text.replace(source, target)
    return text
