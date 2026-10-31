"""Поддерживаемая цель генерации и границы входной модели.

Генератор 1.0 принимает весь DSL BehavioralModel 1.0 (boolean, integer с конечным диапазоном, enum;
literal, variable, unary not/neg, binary and/or/implies/eq/ne/lt/le/gt/ge/add/sub/mul) и выдаёт
проект Python 3.11+ / FastAPI / pytest. Всё остальное — явная ошибка UNSUPPORTED_MODEL, без
изменения или «упрощения» согласованной модели.
"""
from ..behavior.contracts import BooleanDomain, EnumDomain, IntegerDomain
from ..behavior.expressions import BinaryExpression, LiteralExpression, UnaryExpression, VariableExpression


GENERATOR_NAME = "proveryalka-codegen"
# Меняется при любом изменении выдаваемых файлов; входит в происхождение каждого файла.
GENERATOR_VERSION = "1.0.0"
TARGET = "python-fastapi"
TECHNICAL_CONDITIONS = {
    "language": "python",
    "python": ">=3.11",
    "framework": "fastapi==0.162.0",
    "validation": "pydantic==2.14.1",
    "test_runner": "pytest==8.3.5",
    "dependencies": "requirements.txt (все версии зафиксированы)",
    "state": "одно состояние в памяти процесса",
}
# Полное замыкание зависимостей; совпадает с sandbox_image/requirements.lock (проверяется тестом).
DEPENDENCIES = (
    "annotated-doc==0.0.5", "annotated-types==0.8.0", "anyio==4.15.1", "click==8.5.0",
    "fastapi==0.162.0", "h11==0.16.0", "httpcore2==2.16.0", "httpx2==2.16.0", "idna==3.20",
    "iniconfig==2.3.1", "opentelemetry-api==1.45.2", "packaging==26.3", "pluggy==1.7.0",
    "pydantic==2.14.1", "pydantic-core==2.50.1", "pytest==8.3.5", "starlette==1.10.0",
    "truststore==0.10.5", "typing-extensions==4.16.0", "typing-inspection==0.4.4", "uvicorn==0.34.2",
)
LIMITS = {
    "variables": 128,
    "transitions": 256,
    "properties": 256,
    "requirements": 1000,
    "enum_values": 256,
}
BINARY = {"and", "or", "implies", "eq", "ne", "lt", "le", "gt", "ge", "add", "sub", "mul"}
UNARY = {"not", "neg"}


class UnsupportedModel(ValueError):
    """Модель или её часть не поддерживается целью генерации; issues — [{path, reason}]."""

    def __init__(self, issues):
        self.issues = list(issues)
        super().__init__("; ".join(f"{issue['path']}: {issue['reason']}" for issue in self.issues))


def expression_issues(expression, path):
    if isinstance(expression, LiteralExpression):
        if type(expression.value) not in (bool, int, str):
            return [{"path": path, "reason": f"Литерал типа {type(expression.value).__name__} не поддерживается"}]
        return []
    if isinstance(expression, VariableExpression):
        return []
    if isinstance(expression, UnaryExpression):
        if expression.op not in UNARY:
            return [{"path": f"{path}.op", "reason": f"Операция {expression.op} не поддерживается"}]
        return expression_issues(expression.operand, f"{path}.operand")
    if isinstance(expression, BinaryExpression):
        if expression.op not in BINARY:
            return [{"path": f"{path}.op", "reason": f"Операция {expression.op} не поддерживается"}]
        return expression_issues(expression.left, f"{path}.left") + expression_issues(expression.right, f"{path}.right")
    return [{"path": path, "reason": f"Конструкция {type(expression).__name__} не поддерживается генератором {GENERATOR_VERSION}"}]


def check_supported(model, target=TARGET):
    """Возвращает None или поднимает UnsupportedModel со всеми найденными причинами."""
    issues = []
    if target != TARGET:
        issues.append({"path": "target", "reason": f"Поддерживается только цель {TARGET}"})
    if model.schema_version != "1.0":
        issues.append({"path": "schema_version", "reason": "Поддерживается только BehavioralModel 1.0"})
    for field in ("variables", "transitions", "properties", "requirements"):
        if len(getattr(model, field)) > LIMITS[field]:
            issues.append({"path": field, "reason": f"Больше {LIMITS[field]} элементов не поддерживается"})
    for variable in model.variables:
        domain = variable.domain
        if isinstance(domain, EnumDomain):
            if len(domain.values) > LIMITS["enum_values"]:
                issues.append({"path": f"variables.{variable.id}.domain.values", "reason": f"Больше {LIMITS['enum_values']} значений enum не поддерживается"})
        elif not isinstance(domain, (BooleanDomain, IntegerDomain)):
            issues.append({"path": f"variables.{variable.id}.domain", "reason": "Поддерживаются только boolean, integer с границами и enum"})
    for transition in model.transitions:
        issues += expression_issues(transition.guard, f"transitions.{transition.id}.guard")
        for index, effect in enumerate(transition.effects):
            issues += expression_issues(effect.value, f"transitions.{transition.id}.effects[{index}].value")
    if issues:
        raise UnsupportedModel(issues)
