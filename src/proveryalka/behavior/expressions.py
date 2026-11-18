from typing import Annotated, Literal, Union

from pydantic import Field, StrictBool, StrictInt, StrictStr

from ..contracts import Contract


Identifier = Annotated[StrictStr, Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,63}$")]
Value = Union[StrictBool, StrictInt, StrictStr]


class LiteralExpression(Contract):
    kind: Literal["literal"]
    value: Value


class VariableExpression(Contract):
    kind: Literal["variable"]
    name: Identifier


class UnaryExpression(Contract):
    kind: Literal["unary"]
    op: Literal["not", "neg"]
    operand: "Expression"


class BinaryExpression(Contract):
    kind: Literal["binary"]
    op: Literal["and", "or", "implies", "eq", "ne", "lt", "le", "gt", "ge", "add", "sub", "mul"]
    left: "Expression"
    right: "Expression"


Expression = Union[LiteralExpression, VariableExpression, UnaryExpression, BinaryExpression]
UnaryExpression.model_rebuild()
BinaryExpression.model_rebuild()
