import json

from ..behavior.contracts import BehavioralModel
from ..behavior.validation import validate_elements
from .analysis import ModelIssue


def semantics(item):
    data = item.model_dump(exclude={"name", "quote", "requirement_ids", "explanation", "origin", "assumption"})
    if data.get("effects") is not None:
        data["effects"] = sorted(data["effects"], key=lambda effect: effect["variable"])
    if data.get("domain") is not None and data["domain"]["kind"] == "enum":
        data["domain"]["values"] = sorted(data["domain"]["values"])
    return json.dumps(data, sort_keys=True, ensure_ascii=False)


def validate_revision(elements, previous, requirements, dismissed):
    if previous is None:
        return
    old_ids = {item.id for item in previous.requirements}
    new_ids = {item.id for item in requirements}
    for section, current in elements.items():
        current_by_id = {item.id: item for item in current}
        for old in getattr(previous, section):
            if section == "properties" and old.id in dismissed:
                continue
            item = current_by_id.get(old.id)
            if set(old.requirement_ids) - new_ids:
                continue
            if item is None:
                raise ValueError(f"Элемент модели удалён без изменения требования: {old.id}")
            if semantics(old) != semantics(item) and not set(item.requirement_ids) - old_ids:
                raise ValueError(f"Выражения изменены без изменения требования: {old.id}")


def formalize(draft, requirements, sources, blocked, previous=None, approvals=None, dismissed=()):
    known_ids = {item.id for item in requirements}
    links = {f"R{index}": item.id for index, item in enumerate(requirements, 1)}
    links.update({identifier: identifier for identifier in known_ids})
    links.update({
        fact.previous_id: item.id for fact, item in zip(draft.requirements, requirements)
        if fact.previous_id is not None
    })
    data = draft.model_dump(exclude={"requirements"})
    elements = {}
    for section in ("variables", "events", "properties"):
        elements[section] = []
        for item in getattr(draft, section):
            if set(item.requirement_ids) - set(links):
                raise ValueError(f"Неизвестная ссылка на требование: {item.id}")
            elements[section].append(item.model_copy(update={
                "requirement_ids": [links[key] for key in item.requirement_ids],
            }))
        data[section] = elements[section]
    validate_elements(elements["variables"], elements["events"], elements["properties"], known_ids)
    validate_revision(elements, previous, requirements, dismissed)
    issues = []
    if not draft.subject or not draft.subject.strip():
        issues.append(ModelIssue(path="subject", message="Не определён объект модели"))
    if not elements["variables"]:
        issues.append(ModelIssue(path="variables", message="Не определены переменные состояния"))
    for section, fields in [("variables", ("domain", "initial_value")), ("events", ("guard", "effects")), ("properties", ("predicate",))]:
        for item in elements[section]:
            for field in fields:
                if getattr(item, field) is None:
                    issues.append(ModelIssue(path=f"{section}.{item.id}.{field}", message="Значение не определено"))
    for prop in elements["properties"]:
        if prop.origin == "proposal" and prop.id not in (approvals or {}):
            issues.append(ModelIssue(path=f"properties.{prop.id}.approval", message="Свойство предложено агентом и ещё не согласовано"))
    unresolved = draft.assumptions or draft.contradictions
    if issues or unresolved or blocked:
        return data, None, issues
    # Модель ссылается только на исходный текст и цитируемые ответы: вопрос без новых правил
    # не меняет spec_hash и не создаёт новую версию.
    cited = {ref.source_id for item in requirements for ref in item.source_refs}
    cited.update(ref.source_id for ref in (approvals or {}).values())
    behavior = BehavioralModel.model_validate({
        "schema_version": "1.0", "name": draft.subject,
        "sources": [source.model_dump() for index, source in enumerate(sources) if index == 0 or source.id in cited],
        "requirements": [item.model_dump() for item in requirements],
        "variables": [item.model_dump(exclude={"quote"}) for item in elements["variables"]],
        "transitions": [item.model_dump(exclude={"quote"}) for item in elements["events"]],
        "properties": [
            {**item.model_dump(exclude={"quote", "assumption"}), "approved_by": (approvals or {}).get(item.id)}
            for item in elements["properties"]
        ],
    })
    return data, behavior, issues
