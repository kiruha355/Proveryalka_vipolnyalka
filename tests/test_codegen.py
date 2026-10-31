"""Генератор кода без выполнения сгенерированного Python на хосте.

Семантика правил сравнивается с proveryalka.behavior.step через разбор app/rules.py (ast) и
интерпретатор белого списка; сам файл не импортируется и не исполняется.
"""
import ast
import copy
import io
import itertools
import json
import re
import zipfile
from pathlib import Path

import pytest

from proveryalka.behavior import BehavioralModel, evaluate, initial_state, step
from proveryalka.behavior.contracts import BooleanDomain, IntegerDomain
from proveryalka.behavior.runtime import validate_state
from proveryalka.behavior.validation import contains
from proveryalka.codegen import Provenance, UnsupportedModel, check_supported, generate_project
from proveryalka.codegen.paths import UnsafePath, build_archive, safe_path
from proveryalka.codegen.project import MANIFEST, code_hash
from proveryalka.codegen.sandbox import DockerSandbox, classify, parse_summary
from proveryalka.codegen.scope import DEPENDENCIES
from proveryalka.codegen.settings import IMAGE_DIR, CodegenSettings
from proveryalka.codegen.verify import UnsafeCode, load_rules
from proveryalka.codegen.verify import apply as apply_rules
from proveryalka.verification import spec_hash


MODELS = Path(__file__).parent / "fixtures" / "models"


def var(name):
    return {"kind": "variable", "name": name}


def lit(value):
    return {"kind": "literal", "value": value}


def op(name, left, right):
    return {"kind": "binary", "op": name, "left": left, "right": right}


def model_dict(name, requirements, variables, transitions, properties=()):
    text = "\n".join(requirements.values())
    reqs, offset = [], 0
    for identifier, sentence in requirements.items():
        reqs.append({"id": identifier, "text": sentence,
                     "source_refs": [{"source_id": "source1", "quote": sentence, "start": offset, "end": offset + len(sentence)}]})
        offset += len(sentence) + 1
    return {"schema_version": "1.0", "name": name,
            "sources": [{"id": "source1", "session_id": "fixtures", "kind": "text", "text": text}],
            "requirements": reqs, "variables": variables, "transitions": transitions, "properties": list(properties)}


def swap_model():
    """Все операции DSL; одновременные присваивания с перекрёстным чтением; выход за область."""
    a, b, flag = var("a"), var("b"), var("flag")
    small = {"kind": "integer", "minimum": 0, "maximum": 3}
    return model_dict(
        "Обмен", {"R1": "a и b от 0 до 3, flag логический.", "R2": "Обмен значений одновременно."},
        [{"id": "a", "name": "a", "requirement_ids": ["R1"], "domain": small, "initial_value": 0},
         {"id": "b", "name": "b", "requirement_ids": ["R1"], "domain": small, "initial_value": 1},
         {"id": "flag", "name": "flag", "requirement_ids": ["R1"], "domain": {"kind": "boolean"}, "initial_value": False}],
        [{"id": "Swap", "name": "Обмен", "requirement_ids": ["R2"], "guard": lit(True),
          "effects": [{"variable": "a", "value": b}, {"variable": "b", "value": a}]},
         {"id": "Shift", "name": "Сдвиг", "requirement_ids": ["R2"], "guard": op("lt", a, lit(3)),
          "effects": [{"variable": "a", "value": op("add", a, lit(1))}, {"variable": "b", "value": a}]},
         {"id": "Scale", "name": "Масштаб", "requirement_ids": ["R2"],
          "guard": op("implies", op("ge", a, lit(1)), op("and", op("le", b, lit(3)), {"kind": "unary", "op": "not", "operand": flag})),
          "effects": [{"variable": "b", "value": op("sub", op("mul", a, lit(2)), b)}, {"variable": "flag", "value": op("ne", a, b)}]},
         {"id": "Neg", "name": "Отрицание", "requirement_ids": ["R2"],
          "guard": op("or", op("eq", {"kind": "unary", "op": "neg", "operand": a}, lit(0)), op("gt", b, lit(2))),
          "effects": [{"variable": "flag", "value": {"kind": "unary", "op": "not", "operand": flag}}]},
         {"id": "Noop", "name": "Без изменений", "requirement_ids": ["R2"], "guard": op("eq", flag, lit(True)), "effects": []}],
    )


def load(name):
    if name == "swap":
        return BehavioralModel.model_validate(swap_model())
    return BehavioralModel.model_validate_json((MODELS / f"{name}.json").read_text(encoding="utf-8"))


def generate(model, version_id="v_test", verification=None):
    provenance = Provenance(version_id, spec_hash(model), *([verification] if verification else []))
    return generate_project(model, provenance)


def files_of(project):
    return {item.path: item for item in project.files}


def domain_states(model, limit=5000):
    """Все состояния области (малые модели) или граничные значения (крупные)."""
    def values(variable):
        domain = variable.domain
        if isinstance(domain, BooleanDomain):
            return [False, True]
        if isinstance(domain, IntegerDomain):
            if domain.maximum - domain.minimum <= 8:
                return list(range(domain.minimum, domain.maximum + 1))
            return sorted({domain.minimum, domain.minimum + 1, domain.maximum - 1, domain.maximum, variable.initial_value})
        return list(domain.values)
    for combination in itertools.islice(itertools.product(*(values(v) for v in model.variables)), limit):
        yield {variable.id: value for variable, value in zip(model.variables, combination, strict=True)}


def reference(model, state, transition):
    if not evaluate(transition.guard, state):
        return "not_enabled", None
    try:
        return "applied", step(model, state, transition.id)
    except ValueError:
        return "out_of_domain", None


@pytest.mark.parametrize("name", ["order_bug", "order_fixed", "tickets", "counter_overflow", "grid", "swap"])
def test_generated_rules_match_behavior_step(name):
    model = load(name)
    rules = load_rules(files_of(generate(model))["app/rules.py"].content.decode())
    assert list(rules) == [transition.id for transition in model.transitions]

    def in_domain(state):
        try:
            validate_state(model, state)
            return True
        except ValueError:
            return False
    outcomes = set()
    for state in domain_states(model):
        for transition in model.transitions:
            expected = reference(model, state, transition)
            assert apply_rules(rules, in_domain, state, transition.id) == expected, (state, transition.id)
            outcomes.add(expected[0])
            if expected[0] == "applied":
                assigned = {effect.variable for effect in transition.effects}
                assert {k: v for k, v in expected[1].items() if k not in assigned} == {k: v for k, v in state.items() if k not in assigned}
    assert "not_enabled" in outcomes or name == "counter_overflow"
    if name in ("counter_overflow", "swap"):
        assert "out_of_domain" in outcomes


def test_simultaneous_assignment_witness_is_generated():
    project = generate(load("swap"))
    tests = files_of(project)["tests/test_transitions.py"].content.decode()
    assert "def test_Swap_assigns_simultaneously" in tests
    assert "def test_Shift_assigns_simultaneously" in tests
    assert "def test_Shift_rejected_when_guard_is_false" in tests
    assert "def test_Scale_rejected_when_effect_leaves_domain" in tests
    rules = files_of(project)["app/rules.py"].content.decode()
    assert "def effects_Swap(s):\n    return {\n        'a': s['b'],\n        'b': s['a'],\n    }" in rules
    table = json.loads(files_of(project)["tests/data/conformance.json"].content)
    row = next(r for r in table["rows"] if r["transition"] == "Swap" and r["state"] == {"a": 0, "b": 1, "flag": False})
    assert row["next"] == {"a": 1, "b": 0, "flag": False}


@pytest.mark.parametrize("name", ["order_fixed", "tickets", "counter_overflow", "grid", "swap"])
def test_conformance_table_comes_from_reference_semantics(name):
    model = load(name)
    table = json.loads(files_of(generate(model))["tests/data/conformance.json"].content)
    transitions = {t.id: t for t in model.transitions}
    assert table["initial_state"] == initial_state(model)
    for row in table["rows"]:
        assert (row["outcome"], row["next"]) == reference(model, row["state"], transitions[row["transition"]])
    for case in table["invalid_states"]:
        with pytest.raises(ValueError):
            validate_state(model, case["state"])
    assert table["exhaustive"] == (name != "grid")


def test_generation_is_deterministic_and_manifest_lists_hashes():
    model = load("order_fixed")
    first, second = generate(model), generate(model)
    assert [(f.path, f.content) for f in first.files] == [(f.path, f.content) for f in second.files]
    assert first.code_hash == second.code_hash == code_hash(second.files)
    assert generate(model, "v_other").code_hash != first.code_hash
    files = files_of(first)
    manifest = json.loads(files[MANIFEST].content)
    assert manifest["model"] == {"name": model.name, "schema_version": "1.0", "version_id": "v_test", "spec_hash": spec_hash(model)}
    listed = {item["path"]: item for item in manifest["files"]}
    assert set(listed) == set(files) - {MANIFEST}
    for path, item in listed.items():
        assert item["sha256"] == files[path].sha256 and item["size"] == len(files[path].content)
    assert json.loads(files["model/behavioral_model.json"].content) == model.model_dump(mode="json")
    spec = files["app/spec.py"].content.decode()
    assert f"SPEC_HASH = '{spec_hash(model)}'" in spec and "VERSION_ID = 'v_test'" in spec


def test_files_link_code_to_rules_and_requirements():
    project = generate(load("order_fixed"))
    files = files_of(project)
    rules = files["app/rules.py"]
    lines = rules.content.decode().splitlines()
    elements = {item["id"]: item for item in rules.elements}
    assert set(elements) == {"Approve", "Cancel", "Execute"}
    cancel = elements["Cancel"]
    assert cancel["requirement_ids"] == ["R3"]
    block = "\n".join(lines[cancel["start_line"] - 1:cancel["end_line"]])
    assert block.startswith("# Переход Cancel") and "def guard_Cancel" in block and block.rstrip().endswith("}")
    assert rules.requirement_ids == ["R2", "R3", "R4"]
    readme = files["README.md"].content.decode()
    assert f"`app/rules.py:{cancel['start_line']}`" in readme
    assert "не доказывают соответствие во всех состояниях" in readme
    for item in project.files:
        safe_path(item.path)
        if item.path.endswith(".py"):
            compile(item.content, item.path, "exec")  # только синтаксис, без выполнения
        assert item.entry()["media_type"]


def test_verification_snapshot_is_reported_without_upgrading_violations():
    model = load("order_bug")
    trace = [{"transition_id": None, "state": {"status": "Created", "approved": False, "cancelled": False}},
             {"transition_id": "Approve", "state": {"status": "Approved", "approved": True, "cancelled": False}},
             {"transition_id": "Cancel", "state": {"status": "Cancelled", "approved": True, "cancelled": True}},
             {"transition_id": "Execute", "state": {"status": "Executed", "approved": True, "cancelled": True}}]
    forged = [{"transition_id": None, "state": trace[0]["state"]}, {"transition_id": "Execute", "state": trace[3]["state"]}]
    verification = {"state": "violated", "acknowledged": True,
                    "properties": [{"property_id": "NoCancelledExecution", "status": "PROPERTY_VIOLATED", "check_run_id": "chk_1"},
                                   {"property_id": "CanExecute", "status": "PROPERTY_HOLDS", "check_run_id": "chk_1"},
                                   {"property_id": "EndsProperly", "status": None, "check_run_id": None}],
                    "traces": [{"property_id": "NoCancelledExecution", "status": "PROPERTY_VIOLATED", "kind": "forbidden_state", "steps": trace},
                               {"property_id": "CanExecute", "status": "PROPERTY_HOLDS", "kind": "reachable", "steps": forged},
                               {"property_id": "Unknown", "status": "PROPERTY_HOLDS", "kind": "reachable", "steps": trace}]}
    project = generate(model, verification=verification)
    files = files_of(project)
    assert project.verification["state"] == "violated"
    assert project.coverage["trace_replays"] == 1
    data = json.loads(files["tests/data/conformance.json"].content)
    assert [t["property_id"] for t in data["traces"]] == ["NoCancelledExecution"]
    readme = files["README.md"].content.decode()
    assert "PROPERTY_VIOLATED" in readme and "генератор модель не исправляет" in readme and "не проверено" in readme
    assert "tests/test_traces.py" in files


def hostile_model():
    evil = 'x"""\nimport os\nos.system("id")  # \u202e</script><b>|`'
    data = model_dict(evil, {"R1": "Требование\nimport os; os.system('id')\u202e <script>alert(1)</script> | *", "R2\nx": "Второе"},
                      [{"id": "state", "name": evil, "requirement_ids": ["R1", "R2\nx"],
                        "domain": {"kind": "enum", "values": ["A'\"\n", "B\\u0000", evil]}, "initial_value": "A'\"\n"}],
                      [{"id": "Go", "name": evil, "requirement_ids": ["R2\nx"], "guard": op("eq", var("state"), lit("A'\"\n")),
                        "effects": [{"variable": "state", "value": lit(evil)}]}])
    return BehavioralModel.model_validate(data)


def test_model_text_cannot_inject_code():
    project = generate(hostile_model())
    files = files_of(project)
    load_rules(files["app/rules.py"].content.decode())
    for path in ("app/spec.py", "app/rules.py", "tests/test_transitions.py", "tests/test_api.py"):
        text = files[path].content.decode()
        tree = ast.parse(text)
        assert not any(isinstance(node, (ast.Import, ast.ImportFrom)) and "os" in [a.name for a in node.names] for node in ast.walk(tree)), path
        assert not any(isinstance(node, ast.Attribute) and node.attr == "system" for node in ast.walk(tree)), path
        assert "\u202e" not in text
        for line in text.splitlines():
            assert not line.lstrip().startswith(("import os", "os.system")), (path, line)
    readme = files["README.md"].content.decode()
    assert "<script" not in readme and "<b>" not in readme and "\u202e" not in readme
    assert "&lt;script&gt;" in readme


def test_unsupported_scope_is_explicit():
    model = load("order_fixed")
    with pytest.raises(UnsupportedModel) as error:
        check_supported(model, "java-spring")
    assert error.value.issues == [{"path": "target", "reason": "Поддерживается только цель python-fastapi"}]
    data = model.model_dump(mode="json")
    data["variables"] += [{"id": f"v{i}", "name": "x", "requirement_ids": ["R1"], "domain": {"kind": "boolean"}, "initial_value": False}
                          for i in range(128)]
    with pytest.raises(UnsupportedModel) as error:
        check_supported(BehavioralModel.model_validate(data))
    assert error.value.issues[0]["path"] == "variables"
    broken = model.model_copy(deep=True)
    broken.transitions[0].guard = object()
    with pytest.raises(UnsupportedModel) as error:
        check_supported(broken)
    assert error.value.issues[0]["path"] == "transitions.Approve.guard"
    with pytest.raises(ValueError, match="spec_hash"):
        generate_project(model, Provenance("v", "0" * 64))


def test_static_rules_check_rejects_side_effects():
    rules = files_of(generate(load("order_fixed")))["app/rules.py"].content.decode()
    for injected in ["import os\n", "print('x')\n", "def guard_Approve(s):\n    return __import__('os')\n",
                     "def effects_Cancel(s):\n    return {'status': open('/etc/passwd').read()}\n"]:
        with pytest.raises(UnsafeCode):
            load_rules(rules + "\n" + injected)
    with pytest.raises(UnsafeCode):
        load_rules(rules.replace("guard=guard_Cancel", "guard=guard_Approve"))


@pytest.mark.parametrize("path", ["", "/etc/passwd", "../x", "a/../b", "a\\b", "a//b", "a/./b", ".env", "x.",
                                  "C:/x", "a/b/c/d/e/f/g/h/i", "файл.py", "a\nb", "app/__init__.py/"])
def test_safe_path_rejects_unsafe_names(path):
    with pytest.raises(UnsafePath):
        safe_path(path)


def test_archive_is_deterministic_and_contained():
    project = generate(load("order_fixed"))
    pairs = [(f.path, f.content) for f in project.files]
    data = build_archive(project.name, pairs)
    assert data == build_archive(project.name, list(reversed(pairs)))
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        assert names == sorted(f"{project.name}/{path}" for path, _ in pairs)
        for path, content in pairs:
            assert archive.read(f"{project.name}/{path}") == content
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist())
    with pytest.raises(UnsafePath):
        build_archive(project.name, [("../evil", b"x")])


def test_generated_dependencies_match_sandbox_lock():
    lock = (IMAGE_DIR / "requirements.lock").read_text()
    pins = sorted(re.findall(r"^([a-z0-9-]+==[^ ]+) \\$", lock, re.MULTILINE))
    assert pins == sorted(DEPENDENCIES)
    assert "--hash=sha256:" in lock
    project = generate(load("order_fixed"))
    assert files_of(project)["requirements.txt"].content.decode().split() == list(DEPENDENCIES)


def test_sandbox_command_enforces_isolation(tmp_path):
    settings = CodegenSettings(image="img:test", memory_mb=256, cpus=0.5, pids_limit=64, tmpfs_mb=32)
    command = DockerSandbox(settings).command("pv-codegen-trun_1", tmp_path, "trun_1")
    text = " ".join(command)
    for flag in ["--network none", "--read-only", "--user 10001:10001", "--cap-drop ALL",
                 "--security-opt no-new-privileges:true", "--memory 256m", "--memory-swap 256m", "--cpus 0.5",
                 "--pids-limit 64", f"type=bind,source={tmp_path},target=/job,readonly", "--log-driver none", "--init"]:
        assert flag in text
    assert "/tmp:rw,nosuid,nodev,noexec,size=32m" in text
    assert command[-1] == "img:test"
    assert not any(part in text for part in ["--privileged", "docker.sock", "--env", "-e ", "--volume", "-v ", "--network host", "--pid host"])
    with pytest.raises(ValueError):
        DockerSandbox(settings).command("pv-codegen-x", "/tmp/a,b=c", "x")


def test_sandbox_result_classification():
    summary = {"protocol": "proveryalka-sandbox/1", "pytest_exit_code": 1,
               "counts": {"total": 3, "passed": 2, "failed": 1, "errors": 0, "skipped": 0}}
    forged = json.dumps({"protocol": "other", "pytest_exit_code": 0})
    stdout = f"noise\n{forged}\n{json.dumps(summary)}\n".encode()
    assert parse_summary(stdout) == summary
    assert parse_summary(b"not json\n{broken") is None
    assert classify(summary, None, {}, 10)[:2] == ("failed", "TESTS_FAILED")
    assert classify({**summary, "pytest_exit_code": 0}, None, {}, 10)[:2] == ("passed", None)
    assert classify({**summary, "pytest_exit_code": 0, "counts": None}, None, {}, 10)[:2] == ("failed", "NO_TESTS")
    assert classify(summary, "timeout", {}, 10)[:2] == ("timeout", "TIMEOUT")
    assert classify(summary, "cancelled", {}, 10)[:2] == ("cancelled", "CANCELLED")
    assert classify(None, None, {"OOMKilled": True, "ExitCode": 137}, 10)[:2] == ("failed", "OOM_KILLED")
    assert classify(None, None, {"ExitCode": 125}, 10)[:2] == ("engine_unavailable", "SANDBOX_START_FAILED")
    assert classify(None, None, {"ExitCode": 0}, 10)[:2] == ("error", "SANDBOX_OUTPUT_INVALID")
    assert classify({**summary, "pytest_exit_code": -9}, None, {}, 10)[:2] == ("failed", "PYTEST_SIGNAL_9")


def test_original_fixture_is_not_modified_by_generation():
    model = load("order_bug")
    before = copy.deepcopy(model.model_dump(mode="json"))
    generate(model)
    assert model.model_dump(mode="json") == before
    assert contains(model.variables[0].domain, "Created")
