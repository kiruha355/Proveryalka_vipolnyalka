"""Интеграционная регрессия на настоящих SANY/TLC.

Без Java и tla2tools.jar тесты пропускаются локально, но при PROVERYALKA_REQUIRE_TLC=1 (так в CI)
отсутствие движка — ошибка, а не успешная проверка.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest

from proveryalka.behavior import BehavioralModel
from proveryalka.checker import TLCChecker
from proveryalka.checker.__main__ import main as cli
from proveryalka.checker.runner import EngineUnavailable, detect_engine
from proveryalka.config import Settings
from proveryalka.verification import CommandChecker, check_behavior
from proveryalka.verification.checker import make_request
from proveryalka.verification.contracts import CheckLimits


ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "tests/fixtures/models"
EXPECTED = json.loads((MODELS / "expected.json").read_text(encoding="utf-8"))
JAR = Path(os.getenv("PROVERYALKA_TLA_JAR", ROOT / "tools/tla2tools.jar"))
JAVA = os.getenv("PROVERYALKA_JAVA", "java")


def engine_ready():
    try:
        asyncio.run(detect_engine(JAVA, JAR))
    except EngineUnavailable as error:
        return str(error)
    return None


PROBLEM = engine_ready()
if PROBLEM and os.getenv("PROVERYALKA_REQUIRE_TLC") == "1":
    raise RuntimeError(f"TLC обязателен в этом окружении, но недоступен: {PROBLEM}")
pytestmark = pytest.mark.skipif(PROBLEM is not None, reason=f"TLC недоступен: {PROBLEM}")


def load(name):
    return BehavioralModel.model_validate_json((MODELS / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture
def settings(tmp_path):
    return replace(Settings(), artifacts_path=tmp_path / "artifacts", java_path=JAVA, tla_jar=JAR, check_cache_path=None)


@pytest.fixture
def checker(settings):
    return TLCChecker(settings, cache=False)


def running_java(marker):
    output = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
    return [line for line in output.splitlines() if "java" in line and marker in line]


CASES = [
    (model, prop, data)
    for model, entry in EXPECTED.items() if not model.startswith("_")
    for prop, data in entry["properties"].items()
]


@pytest.mark.parametrize("model_name, property_id, expected", CASES, ids=[f"{m}-{p}" for m, p, _ in CASES])
def test_reference_models(checker, model_name, property_id, expected):
    limits = CheckLimits(**expected.get("limits", {}))
    report = asyncio.run(check_behavior(load(model_name), checker, [property_id], limits))
    result = report.results[0]
    assert result.status == expected["status"], result.message
    assert report.engine is not None and report.engine.name == "TLC" and report.executed
    transitions = [step.transition_id for step in result.trace[1:]]
    if "trace" in expected:
        assert (transitions if result.trace else None) == expected["trace"]
    if "trace_length" in expected:
        assert len(transitions) == expected["trace_length"]
    if "related_requirements" in expected:
        assert result.related_requirements == expected["related_requirements"]
    assert result.statistics.elapsed_seconds is not None
    if result.conclusive and len(result.trace) != 1:
        # При нарушении в начальном состоянии TLC статистику не печатает, и мы её не выдумываем.
        assert result.statistics.distinct_states is not None


def test_acceptance_bug_and_fix(checker):
    bug = asyncio.run(check_behavior(load("order_bug"), checker, ["NoCancelledExecution"])).results[0]
    fixed = asyncio.run(check_behavior(load("order_fixed"), checker, ["NoCancelledExecution"])).results[0]
    assert bug.status == "PROPERTY_VIOLATED"
    assert [s.state["status"] for s in bug.trace] == ["Created", "Approved", "Cancelled", "Executed"]
    assert bug.trace[-1].state["cancelled"] is True
    assert fixed.status == "PROPERTY_HOLDS" and fixed.conclusive and not fixed.trace


def test_every_property_gets_its_own_run(checker):
    model = load("tickets")
    run = asyncio.run(checker.run(make_request(model)))
    statuses = {r.property_id: r.status for r in run.report.results}
    assert statuses == {p: d["status"] for p, d in EXPECTED["tickets"]["properties"].items()}
    manifest = json.loads((run.directory / "manifest.json").read_text())
    assert sorted(s["name"] for s in manifest["steps"]) == sorted(["sany"] + [f"tlc:{p.id}" for p in model.properties])


def test_static_model_error_never_starts_java(checker, settings):
    data = json.loads((MODELS / "stock.json").read_text(encoding="utf-8"))
    data["variables"][0]["domain"]["maximum"] = 2**30
    data["transitions"][1]["effects"][0]["value"] = {"kind": "binary", "op": "mul", "left": {"kind": "variable", "name": "free"}, "right": {"kind": "literal", "value": 4}}
    report = asyncio.run(check_behavior(BehavioralModel.model_validate(data), checker))
    result = report.results[0]
    assert result.status == "MODEL_INVALID" and not result.executed and result.engine is None
    assert "transitions.Return.effects[0].value" in result.message
    assert not (settings.artifacts_path / "checks").exists()


def test_depth_limit(checker):
    result = asyncio.run(check_behavior(load("grid"), checker, limits=CheckLimits(max_depth=5))).results[0]
    assert result.status == "STATE_LIMIT_REACHED" and "max_depth=5" in result.message and not result.conclusive


def test_depth_limit_does_not_hide_shallow_violation(checker):
    result = asyncio.run(check_behavior(load("order_bug"), checker, ["NoCancelledExecution"], CheckLimits(max_depth=3))).results[0]
    assert result.status == "PROPERTY_VIOLATED"
    result = asyncio.run(check_behavior(load("order_bug"), checker, ["NoCancelledExecution"], CheckLimits(max_depth=2))).results[0]
    assert result.status == "STATE_LIMIT_REACHED"


def test_largest_accepted_limits_run_in_tlc(checker):
    # Раньше max_states=2^31 и max_depth=2^31-1 проходили валидацию и давали ENGINE_ERROR в TLC.
    limits = CheckLimits(max_states=2_147_483_647, max_depth=2_147_483_646)
    result = asyncio.run(check_behavior(load("order_bug"), checker, ["NoCancelledExecution"], limits)).results[0]
    assert result.status == "PROPERTY_VIOLATED" and result.engine.name == "TLC"


def test_timeout_stops_engine(checker):
    started = time.monotonic()
    run = asyncio.run(checker.run(make_request(load("grid"), limits=CheckLimits(timeout_seconds=3.0, max_states=100_000_000))))
    assert run.report.results[0].status == "TIMEOUT"
    assert time.monotonic() - started < 6
    assert not running_java(run.run_id)


def test_timeout_through_public_call(checker):
    report = asyncio.run(check_behavior(load("grid"), checker, limits=CheckLimits(timeout_seconds=2.0, max_states=100_000_000)))
    assert report.results[0].status == "TIMEOUT" and not report.results[0].conclusive


def test_cancel_by_run_id(checker, settings):
    async def scenario():
        request = make_request(load("grid"), limits=CheckLimits(timeout_seconds=60.0, max_states=100_000_000))
        task = asyncio.create_task(checker.run(request, run_id="chk_cancelme"))
        cfg = settings.artifacts_path / "checks/chk_cancelme/properties/SumNonNegative/tlc.tmp"
        for _ in range(200):
            if cfg.exists():
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.3)
        assert checker.cancel("chk_cancelme")
        return await task
    run = asyncio.run(scenario())
    result = run.report.results[0]
    assert result.status == "ENGINE_ERROR" and result.message.startswith("CANCELLED")
    assert not running_java("chk_cancelme")
    assert not checker.cancel("chk_cancelme")


def test_external_cancellation_kills_processes(checker, settings):
    async def scenario():
        request = make_request(load("grid"), limits=CheckLimits(timeout_seconds=60.0, max_states=100_000_000))
        task = asyncio.create_task(checker.run(request, run_id="chk_external"))
        await asyncio.sleep(1.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(scenario())
    assert not running_java("chk_external")
    manifest = json.loads((settings.artifacts_path / "checks/chk_external/manifest.json").read_text())
    assert manifest["interrupted"] is True


def test_engine_crash_is_engine_error(settings):
    broken = TLCChecker(replace(settings, tlc_heap_mb=1), cache=False)
    result = asyncio.run(check_behavior(load("stock"), broken)).results[0]
    assert result.status == "ENGINE_ERROR" and result.executed and "SANY завершился с кодом" in result.message


def test_missing_engine_is_reported_not_passed(settings, tmp_path):
    missing = TLCChecker(replace(settings, tla_jar=tmp_path / "absent.jar"), cache=False)
    result = asyncio.run(check_behavior(load("stock"), missing)).results[0]
    assert result.status == "ENGINE_ERROR" and "ENGINE_UNAVAILABLE" in result.message and not result.executed


def test_parallel_runs_are_isolated(checker, settings):
    async def scenario():
        requests = [make_request(load(name)) for name in ("order_bug", "order_fixed", "tickets", "order_bug")]
        return await asyncio.gather(*(checker.run(request) for request in requests))
    runs = asyncio.run(scenario())
    assert len({run.directory for run in runs}) == 4
    assert runs[0].report.results[0].status == runs[3].report.results[0].status == "PROPERTY_VIOLATED"
    assert runs[1].report.results[0].status == "PROPERTY_HOLDS"
    for run in runs:
        assert not any(path.name.endswith(".tmp") or path.name == "states" for path in run.directory.rglob("*"))
        assert not running_java(run.run_id)


def test_bundle_is_complete_and_replayable(checker, capsys, monkeypatch, settings):
    run = asyncio.run(checker.run(make_request(load("order_bug"), ["NoCancelledExecution"])))
    names = {item["name"] for item in run.files()}
    assert {"request.json", "report.json", "Spec.tla", "sany.stdout.log",
            "properties/NoCancelledExecution/Spec.cfg", "properties/NoCancelledExecution/tlc.stdout.log",
            "properties/NoCancelledExecution/trace.json", "properties/NoCancelledExecution/changes.json"} <= names
    manifest = json.loads((run.directory / "manifest.json").read_text())
    assert manifest["engine"]["jar_sha256"] and manifest["limits"]["max_states"] == 100_000
    assert all(not part.startswith("/Users") for step in manifest["steps"] for part in step["command"][1:])
    monkeypatch.setenv("PROVERYALKA_ARTIFACTS_PATH", str(settings.artifacts_path))
    monkeypatch.setenv("PROVERYALKA_TLA_JAR", str(JAR))
    assert cli(["replay", str(run.directory)]) == 0
    assert "совпадает" in capsys.readouterr().out


def test_cache_marks_reused_results(settings):
    cached = TLCChecker(replace(settings, check_cache_path=settings.artifacts_path / "cache"))
    request = make_request(load("order_bug"))
    first = asyncio.run(cached.run(request))
    second = asyncio.run(cached.run(request))
    assert not first.cached and sorted(second.cached) == sorted(p.id for p in request.model.properties)
    assert all(r.message.startswith("[из кэша]") for r in second.report.results)
    assert [r.status for r in first.report.results] == [r.status for r in second.report.results]
    manifest = json.loads((second.directory / "manifest.json").read_text())
    assert manifest["steps"] == [] and manifest["cached_properties"]
    tighter = asyncio.run(cached.run(make_request(load("order_bug"), limits=CheckLimits(max_states=2))))
    assert not tighter.cached and tighter.report.results[0].status == "STATE_LIMIT_REACHED"


def test_command_checker_protocol(monkeypatch, settings):
    monkeypatch.setenv("PROVERYALKA_ARTIFACTS_PATH", str(settings.artifacts_path))
    monkeypatch.setenv("PROVERYALKA_TLA_JAR", str(JAR))
    monkeypatch.setenv("PROVERYALKA_CHECK_CACHE", "")
    command = CommandChecker([sys.executable, "-m", "proveryalka.checker"])
    report = asyncio.run(check_behavior(load("order_bug"), command, ["NoCancelledExecution"], version_id="v1"))
    assert report.results[0].status == "PROPERTY_VIOLATED" and report.version_id == "v1"


def test_agent_path_carries_statuses_requirements_and_steps(checker):
    from proveryalka.agent.verification import VerificationContext, VerificationOutcome, perform_check, render_verification

    async def scenario(name):
        events = []

        async def on_event(event):
            events.append(event)

        context = VerificationContext(request=make_request(load(name), ["NoCancelledExecution"], version_id=f"{name}-1"), checker=checker, on_event=on_event)
        await perform_check(context)
        outcome = VerificationOutcome(request=context.request, report=context.report, explanation=None, check_id=context.check_id)
        return outcome, [event.event for event in events], events[-1].report

    bug, bug_events, bug_report = asyncio.run(scenario("order_bug"))
    fixed, _, _ = asyncio.run(scenario("order_fixed"))
    assert bug_events == ["tool_started", "tool_finished"] and bug_report == bug.report
    text = render_verification(bug)
    assert "Движок: TLC" in text and "Тестовый адаптер" not in text
    for step in ("Шаг 1, Согласовать", "Шаг 2, Отменить", "Шаг 3, Исполнить", "Требование R3:"):
        assert step in text
    assert bug.report.results[0].related_requirements == ["R2", "R3", "R4", "R5"]
    assert fixed.report.results[0].status == "PROPERTY_HOLDS" and "Шаг 1" not in render_verification(fixed)
