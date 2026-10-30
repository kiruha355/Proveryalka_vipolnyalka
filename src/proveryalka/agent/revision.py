import json
from collections.abc import Awaitable, Callable

from agents import Session

from ..contracts import Contract
from ..verification import BehaviorChecker, CheckLimits, spec_hash
from ..verification.contracts import VerificationEvent
from .clarification import AppliedCorrection
from .dialogue import load_dialogue, load_pending
from .verification import STATUS_TEXT, VerificationOutcome, load_verification, verify_dialogue


class PropertyChange(Contract):
    property_id: str
    before_status: str | None
    after_status: str | None
    same_property: bool


class RevisionLink(Contract):
    before_hash: str
    after_hash: str
    before_version_id: str | None
    after_version_id: str | None
    before_check_id: str | None = None
    after_check_id: str | None = None
    corrections: list[AppliedCorrection]
    properties: list[PropertyChange]


class RevisionOutcome(Contract):
    previous: VerificationOutcome
    current: VerificationOutcome
    link: RevisionLink


def compare(before: VerificationOutcome, after: VerificationOutcome, corrections: list[AppliedCorrection]) -> RevisionLink:
    old_results = {item.property_id: item.status for item in before.report.results}
    new_results = {item.property_id: item.status for item in after.report.results}
    old_properties = {item.id: item for item in before.request.model.properties}
    new_properties = {item.id: item for item in after.request.model.properties}
    ids = list(old_results) + [identifier for identifier in new_results if identifier not in old_results]
    properties = []
    for identifier in ids:
        old = old_properties.get(identifier)
        new = new_properties.get(identifier)
        properties.append(PropertyChange(
            property_id=identifier, before_status=old_results.get(identifier), after_status=new_results.get(identifier),
            same_property=identifier in old_results and identifier in new_results and old is not None and new is not None and old.kind == new.kind and old.predicate == new.predicate,
        ))
    return RevisionLink(
        before_hash=before.report.spec_hash, after_hash=after.report.spec_hash,
        before_version_id=before.report.version_id, after_version_id=after.report.version_id,
        before_check_id=before.check_id, after_check_id=after.check_id,
        corrections=corrections, properties=properties,
    )


async def load_revision(session: Session) -> RevisionLink | None:
    for item in reversed(await session.get_items()):
        content = item.get("content")
        if item.get("role") == "assistant" and isinstance(content, str) and content.startswith('{"analyst_revision":'):
            return RevisionLink.model_validate(json.loads(content)["analyst_revision"])
    return None


async def load_revision_outcome(session: Session) -> RevisionOutcome | None:
    link = await load_revision(session)
    if link is None:
        return None
    if link.before_check_id is None or link.after_check_id is None:
        raise ValueError("В старой истории отсутствуют ID проверок для восстановления пары результатов")
    found = {}
    for item in reversed(await session.get_items()):
        content = item.get("content")
        if item.get("role") == "assistant" and isinstance(content, str) and content.startswith('{"analyst_verification":'):
            outcome = VerificationOutcome.model_validate(json.loads(content)["analyst_verification"])
            if outcome.check_id in {link.before_check_id, link.after_check_id} and outcome.check_id not in found:
                found[outcome.check_id] = outcome
    if set(found) != {link.before_check_id, link.after_check_id}:
        raise ValueError("Связанные результаты проверок не найдены в истории")
    before = found[link.before_check_id]
    after = found[link.after_check_id]
    if before.report.spec_hash != link.before_hash or after.report.spec_hash != link.after_hash or before.report.version_id != link.before_version_id or after.report.version_id != link.after_version_id:
        raise ValueError("Связь не соответствует сохранённым версиям проверок")
    return RevisionOutcome(previous=before, current=after, link=link)


async def verify_revision(
    session: Session,
    checker: BehaviorChecker | None = None,
    property_ids: list[str] | None = None,
    limits: CheckLimits | None = None,
    *,
    version_id: str | None = None,
    on_event: Callable[[VerificationEvent], Awaitable[None]] | None = None,
) -> RevisionOutcome:
    if await load_pending(session) is not None:
        raise ValueError("Сначала завершите или отмените незавершённое сообщение")
    state = await load_dialogue(session)
    before = await load_verification(session)
    if state is None or state.status != "ready" or state.analysis.behavior is None:
        raise ValueError("Для повторной проверки нужна уточнённая готовая модель")
    if before is None or not any(item.status == "PROPERTY_VIOLATED" for item in before.report.results):
        raise ValueError("Для исправления нужен предыдущий результат с нарушением")
    if any(source.session_id != session.session_id for source in before.request.model.sources):
        raise ValueError("Предыдущая проверка относится к другой сессии")
    old_sources = {source.id for source in before.request.model.sources}
    old_requirements = {item.id for item in before.request.model.requirements}
    corrections = [item for item in state.corrections if item.answer_source_id not in old_sources and item.requirement_id in old_requirements]
    if not corrections or spec_hash(state.analysis.behavior) == before.report.spec_hash:
        raise ValueError("Нужно явное уточнение пользователя, изменившее модель")
    if version_id is not None and version_id == before.report.version_id:
        raise ValueError("Для изменённой модели нужна другая версия")
    link = None
    try:
        after = await verify_dialogue(session, checker, property_ids, limits, version_id=version_id, on_event=on_event)
    finally:
        latest = await load_verification(session)
        if latest is not None and latest.report.spec_hash == spec_hash(state.analysis.behavior) and latest.report.version_id == version_id:
            link = compare(before, latest, corrections)
            await session.add_items([{"role": "assistant", "content": json.dumps({"analyst_revision": link.model_dump(mode="json")}, ensure_ascii=False)}])
    return RevisionOutcome(previous=before, current=after, link=link)


def render_revision(outcome: RevisionOutcome) -> str:
    lines = ["Сравнение проверок после уточнения пользователя:"]
    if outcome.previous.report.mode == "test" or outcome.current.report.mode == "test":
        lines.append("Тестовый адаптер: сравнение не является результатом TLC.")
    if outcome.link.before_version_id is not None:
        lines.append(f"Прежняя версия: {outcome.link.before_version_id}")
    if outcome.link.after_version_id is not None:
        lines.append(f"Новая версия: {outcome.link.after_version_id}")
    names = {item.id: item.name for item in outcome.current.request.model.properties}
    for item in outcome.link.corrections:
        lines.append(f"Уточнение: {item.quote}")
    for item in outcome.link.properties:
        if item.same_property:
            before = f"тестовый ответ {item.before_status}" if outcome.previous.report.mode == "test" else STATUS_TEXT[item.before_status]
            after = f"тестовый ответ {item.after_status}" if outcome.current.report.mode == "test" else STATUS_TEXT[item.after_status]
            lines.append(f"{names[item.property_id]}: раньше — {before}; после уточнения — {after}.")
        else:
            lines.append(f"{item.property_id}: свойство изменилось или не проверялось в одном из запусков")
    if any(not item.conclusive for item in outcome.current.report.results):
        lines.append("Новая проверка не дала окончательного вывода по всем свойствам.")
    return "\n".join(lines)
