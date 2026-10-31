import type { Expression, Value } from "../api/types";
import { formatExpression, formatValue } from "../domain/expression";

export function Expr({ value }: { value: Expression | null | undefined }) {
  if (!value) return <span className="muted">не задано</span>;
  return <code className="expr">{formatExpression(value)}</code>;
}

export function Val({ value }: { value: Value | null | undefined }) {
  if (value === undefined || value === null) return <span className="muted" title="Значение неизвестно">—</span>;
  return <code className={`val val--${typeof value}`}>{formatValue(value)}</code>;
}
