from dataclasses import dataclass, field

from ..behavior.contracts import BooleanDomain, IntegerDomain
from .tla import compile_expression, literal, property_name, transition_name, variable_name


MODULE = "Spec"
TYPE_OK = "TypeOK"
LIMIT_STATES = "LimitStates"
LIMIT_DEPTH = "LimitDepth"
# Меняется при любом изменении перевода модели в TLA+; входит в ключ кэша.
COMPILER_VERSION = "1"


@dataclass(frozen=True)
class Specification:
    text: str
    variables: dict[str, str]
    transitions: dict[str, str]
    properties: dict[str, str]
    sentinels: tuple[str, ...] = field(default=())

    def config(self, property_id):
        """Отдельная конфигурация на каждое свойство: области, лимиты, затем само свойство."""
        lines = ["SPECIFICATION Spec", f"INVARIANT {TYPE_OK}"]
        lines += [f"INVARIANT {name}" for name in self.sentinels]
        lines.append(f"INVARIANT {property_name(property_id)}")
        return "\n".join(lines) + "\n"


def comment_text(text):
    return " ".join(text.split())


def domain_set(domain):
    if isinstance(domain, BooleanDomain):
        return "BOOLEAN"
    if isinstance(domain, IntegerDomain):
        return f"{literal(domain.minimum)}..{literal(domain.maximum)}"
    return "{" + ", ".join(literal(value) for value in domain.values) + "}"


def conjunction(items, indent):
    if not items:
        return "TRUE"
    return f"\n{' ' * indent}".join(f"/\\ {item}" for item in items)


def disjunction(items):
    return " \\/ ".join(items) if items else "FALSE"


def property_formula(model, prop, predicate):
    if prop.kind == "invariant":
        return predicate
    if prop.kind in {"forbidden_state", "reachable"}:
        # Для reachable нарушение этого инварианта означает найденный путь к цели.
        return f"~{predicate}"
    guards = [compile_expression(t.guard, f"transitions.{t.id}.guard") for t in model.transitions]
    # Тупик допустим только в согласованном конечном состоянии (предикат свойства).
    return disjunction([predicate, *guards])


def generate(model, limits, comment=""):
    names = [variable_name(variable.id) for variable in model.variables]
    lines = [f"---- MODULE {MODULE} ----"]
    if comment:
        lines.append(f"\\* {comment_text(comment)}")
    lines += [
        "EXTENDS Integers, TLC",
        "",
        f"VARIABLES {', '.join(names)}",
        f"vars == <<{', '.join(names)}>>",
        "",
        f"{TYPE_OK} ==",
        "    " + conjunction([f"{variable_name(v.id)} \\in {domain_set(v.domain)}" for v in model.variables], 4),
        "",
        "Init ==",
        "    " + conjunction([f"{variable_name(v.id)} = {literal(v.initial_value)}" for v in model.variables], 4),
    ]
    for transition in model.transitions:
        path = f"transitions.{transition.id}"
        assigned = {effect.variable for effect in transition.effects}
        # Правые части вычисляются по исходному состоянию: в TLA+ они ссылаются на нештрихованные переменные.
        items = [compile_expression(transition.guard, f"{path}.guard")]
        items += [
            f"{variable_name(effect.variable)}' = {compile_expression(effect.value, f'{path}.effects[{index}].value')}"
            for index, effect in enumerate(transition.effects)
        ]
        kept = [variable_name(v.id) for v in model.variables if v.id not in assigned]
        if kept:
            items.append(f"UNCHANGED <<{', '.join(kept)}>>")
        lines += ["", f"\\* {comment_text(transition.name)}", f"{transition_name(transition.id)} ==", "    " + conjunction(items, 4)]
    lines += [
        "",
        f"Next == {disjunction([transition_name(t.id) for t in model.transitions])}",
        "Spec == Init /\\ [][Next]_vars",
        "",
        "\\* Сторожевые инварианты лимитов: их нарушение означает неполное исследование, а не ошибку модели.",
        f"{LIMIT_STATES} == TLCGet(\"distinct\") <= {limits.max_states}",
    ]
    sentinels = [LIMIT_STATES]
    if limits.max_depth is not None:
        # TLCGet("level") у начального состояния равен 1.
        lines.append(f"{LIMIT_DEPTH} == TLCGet(\"level\") <= {limits.max_depth + 1}")
        sentinels.append(LIMIT_DEPTH)
    for prop in model.properties:
        predicate = compile_expression(prop.predicate, f"properties.{prop.id}.predicate")
        lines += ["", f"\\* {prop.kind}: {comment_text(prop.name)}", f"{property_name(prop.id)} == {property_formula(model, prop, predicate)}"]
    lines.append("====")
    return Specification(
        text="\n".join(lines) + "\n",
        variables={variable_name(v.id): v.id for v in model.variables},
        transitions={transition_name(t.id): t.id for t in model.transitions},
        properties={p.id: property_name(p.id) for p in model.properties},
        sentinels=tuple(sentinels),
    )
