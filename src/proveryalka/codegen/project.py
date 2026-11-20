"""Сборка проекта из согласованной модели: файлы, SHA-256, ссылки на правила и code_hash."""
import hashlib
import json
import re
from dataclasses import dataclass, field

from ..behavior import BehavioralModel, initial_state, step
from ..verification import spec_hash as compute_spec_hash
from . import templates
from .explore import explore
from .paths import safe_path
from .render import (
    GENERATOR, conformance_data, render_api_tests, render_readme, render_rules, render_spec,
    render_transition_tests, to_json,
)
from .scope import (
    DEPENDENCIES, GENERATOR_NAME, GENERATOR_VERSION, TARGET, TECHNICAL_CONDITIONS, check_supported,
)


MANIFEST = "GENERATION.json"
VERIFICATION_STATES = ("holds", "violated", "inconclusive", "not_checked")
MEDIA = {".py": "text/x-python", ".md": "text/markdown", ".json": "application/json", ".txt": "text/plain", ".ini": "text/plain"}
TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
                    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t",
                     "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"], strict=True))


@dataclass(frozen=True)
class Provenance:
    """Откуда генерируется проект; verification — снимок результатов TLC для этой версии."""
    version_id: str
    spec_hash: str
    verification: dict = field(default_factory=lambda: {"state": "not_checked", "acknowledged": True, "properties": [], "traces": []})


@dataclass
class GeneratedFile:
    path: str
    content: bytes
    role: str
    explanation: str
    requirement_ids: list = field(default_factory=list)
    elements: list = field(default_factory=list)

    @property
    def sha256(self):
        return hashlib.sha256(self.content).hexdigest()

    @property
    def media_type(self):
        return MEDIA[self.path[self.path.rindex("."):]]

    def entry(self):
        return {"path": self.path, "size": len(self.content), "sha256": self.sha256, "role": self.role,
                "media_type": self.media_type, "explanation": self.explanation,
                "requirement_ids": self.requirement_ids, "elements": self.elements}


@dataclass
class GeneratedProject:
    name: str
    files: list
    coverage: dict
    verification: dict

    @property
    def code_hash(self):
        return code_hash(self.files)


def code_hash(files):
    """SHA-256 канонического списка (path, size, sha256) всех файлов проекта, включая GENERATION.json."""
    listing = sorted(({"path": f.path, "size": len(f.content), "sha256": f.sha256} for f in files), key=lambda item: item["path"])
    return hashlib.sha256(json.dumps(listing, sort_keys=True, separators=(",", ":")).encode("ascii")).hexdigest()


def project_name(model):
    text = "".join(TRANSLIT.get(char, char) for char in model.name.lower())
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:48].strip("-")
    return f"{slug or 'model'}-service"


def ordered_ids(model, ids):
    wanted = set(ids)
    return [item.id for item in model.requirements if item.id in wanted]


def replay(model, trace):
    """Трасса TLC включается в тесты, только если она воспроизводится эталонной семантикой."""
    steps = trace.get("steps") or []
    if not steps or steps[0].get("transition_id") is not None or steps[0].get("state") != initial_state(model):
        return False
    state = steps[0]["state"]
    try:
        for item in steps[1:]:
            state = step(model, state, item["transition_id"])
            if state != item["state"]:
                return False
    except (ValueError, KeyError, TypeError):
        return False
    return True


def generate_project(model, provenance, target=TARGET):
    """Детерминированно: одинаковые модель, происхождение и версия генератора дают одинаковые байты."""
    if not isinstance(model, BehavioralModel):
        model = BehavioralModel.model_validate(model)
    check_supported(model, target)
    if provenance.spec_hash != compute_spec_hash(model):
        raise ValueError("spec_hash не соответствует модели")
    verification = provenance.verification
    if verification.get("state") not in VERIFICATION_STATES:
        raise ValueError("Неизвестное состояние проверки")
    exploration = explore(model)
    props = {prop.id: prop for prop in model.properties}
    traces = [trace for trace in verification.get("traces", []) if trace.get("property_id") in props and replay(model, trace)]
    every_requirement = [item.id for item in model.requirements]
    transition_reqs = ordered_ids(model, [r for t in model.transitions for r in t.requirement_ids])
    trace_reqs = ordered_ids(model, [r for trace in traces for r in props[trace["property_id"]].requirement_ids] if traces else [])
    ids = ", ".join(t.id for t in model.transitions) or "нет переходов"

    spec = render_spec(model, provenance)
    rules = render_rules(model, provenance)
    transition_tests = render_transition_tests(model, exploration)
    api_tests = render_api_tests(model, exploration)
    files = [
        GeneratedFile("requirements.txt", ("\n".join(DEPENDENCIES) + "\n").encode(), "config",
                      "Зафиксированные версии всех зависимостей (Python ≥3.11)."),
        GeneratedFile("pytest.ini", templates.PYTEST_INI.encode(), "config", "Настройка pytest: каталог тестов и путь импорта."),
        GeneratedFile("model/behavioral_model.json", to_json(model.model_dump(mode="json")).encode(), "model",
                      "Согласованная модель BehavioralModel 1.0 этой версии; её канонический SHA-256 равен spec_hash.",
                      every_requirement),
        GeneratedFile("app/__init__.py", b'"""Generated service package."""\n', "source", "Пакет сервиса."),
        GeneratedFile("app/spec.py", spec.text().encode(), "source",
                      "Данные модели: требования, переменные с областями значений, начальное состояние, version_id и spec_hash.",
                      every_requirement, spec.elements),
        GeneratedFile("app/domain.py", templates.DOMAIN.encode(), "source", "Проверка типов и конечных областей значений состояния."),
        GeneratedFile("app/rules.py", rules.text().encode(), "source",
                      f"Условия и одновременные присваивания переходов ({ids}); у каждого перехода указаны требования.",
                      transition_reqs, rules.elements),
        GeneratedFile("app/engine.py", templates.ENGINE.encode(), "source",
                      "Применение события: проверка состояния, условие, одновременное присваивание, проверка областей."),
        GeneratedFile("app/api.py", templates.API.encode(), "source",
                      "FastAPI: GET /model, GET /state, POST /events, POST /evaluate, POST /reset."),
        GeneratedFile("tests/data/conformance.json", to_json(conformance_data(model, provenance, exploration, traces)).encode(), "test_data",
                      "Ожидаемые исходы переходов, недопустимые состояния и трассы TLC; вычислены по семантике модели при генерации.",
                      transition_reqs),
        GeneratedFile("tests/test_transitions.py", transition_tests.text().encode(), "test",
                      "Тесты переходов: применение, неизменные переменные, одновременность, ложное условие, выход за область, таблица исходов.",
                      transition_reqs, transition_tests.elements),
        GeneratedFile("tests/test_domain.py", templates.DOMAIN_TESTS.encode(), "test", "Тесты типов и конечных областей значений."),
        GeneratedFile("tests/test_api.py", api_tests.text().encode(), "test", "Тесты HTTP API: последовательность событий, отказы 404/409/422, сброс."),
        GeneratedFile("tests/test_provenance.py", templates.PROVENANCE_TESTS.encode(), "test",
                      "Связь кода с моделью: spec_hash, состав переходов и переменных, ссылки на требования."),
    ]
    if traces:
        files.append(GeneratedFile("tests/test_traces.py", templates.TRACE_TESTS.encode(), "test",
                                   "Повтор трасс TLC этой версии через сгенерированный код; статус свойства определяет TLC.", trace_reqs))
    coverage = {
        "reachable_states": len(exploration.states), "exhaustive": exploration.exhaustive,
        "boundary_states": exploration.boundary_states, "conformance_cases": len(exploration.rows),
        "invalid_state_cases": len(exploration.invalid_states), "trace_replays": len(traces),
    }
    summary = {"state": verification["state"], "acknowledged": bool(verification.get("acknowledged")),
               "properties": verification.get("properties", [])}
    readme = render_readme(model, provenance, summary, coverage, rules.elements,
                           [{"path": "README.md", "explanation": "Описание, запуск, связь переходов с требованиями, результаты TLC."},
                            {"path": MANIFEST, "explanation": "Происхождение: генератор, version_id, spec_hash, проверка TLC, SHA-256 файлов."}]
                           + [{"path": f.path, "explanation": f.explanation} for f in files])
    files.insert(0, GeneratedFile("README.md", readme.encode(), "doc",
                                  "Описание проекта: версия модели, запуск, API, связь переходов с требованиями, результаты TLC, границы тестов.",
                                  every_requirement))
    manifest = {
        "schema_version": "1.0",
        "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION},
        "target": target, "technical_conditions": TECHNICAL_CONDITIONS,
        "model": {"name": model.name, "schema_version": model.schema_version,
                  "version_id": provenance.version_id, "spec_hash": provenance.spec_hash},
        "verification": summary, "coverage": coverage,
        "files": [{k: v for k, v in f.entry().items() if k in ("path", "size", "sha256", "role", "requirement_ids")} for f in files],
    }
    files.insert(1, GeneratedFile(MANIFEST, to_json(manifest).encode(), "manifest",
                                  "Происхождение: генератор, version_id, spec_hash, снимок проверки TLC, SHA-256 и требования файлов."))
    for item in files:
        safe_path(item.path)
    if len({item.path for item in files}) != len(files):
        raise AssertionError("Duplicate generated path")
    return GeneratedProject(project_name(model), files, coverage, summary)


__all__ = ["GENERATOR", "GeneratedFile", "GeneratedProject", "Provenance", "code_hash", "generate_project"]
