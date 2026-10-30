import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from proveryalka.behavior import BehavioralModel
from proveryalka.behavior.expressions import Expression, LiteralExpression, UnaryExpression
from proveryalka.checker import ArtifactError, ArtifactStore, ResultCache, describe_validation_error, preflight
from proveryalka.checker.cache import CACHE_MARK, cache_key
from proveryalka.checker.parser import interpret, messages, statistics, trace_changes
from proveryalka.checker.runner import ProcessResult
from proveryalka.checker.spec import generate
from proveryalka.checker.tla import UnsupportedConstruct, compile_expression, literal
from proveryalka.verification.checker import make_request, spec_hash
from proveryalka.verification.contracts import CheckLimits, CheckStatistics, EngineInfo, VerificationResult


FIXTURES = Path(__file__).parent / "fixtures"
MODELS = FIXTURES / "models"
TLC = FIXTURES / "tlc"


def load(name):
    return BehavioralModel.model_validate_json((MODELS / f"{name}.json").read_text(encoding="utf-8"))


def compile_data(data):
    return compile_expression(TypeAdapter(Expression).validate_python(data))


def var(name):
    return {"kind": "variable", "name": name}


def lit(value):
    return {"kind": "literal", "value": value}


def op(name, left, right):
    return {"kind": "binary", "op": name, "left": left, "right": right}


# --- #4 компиляция выражений -------------------------------------------------

def test_nested_expressions_keep_grouping():
    data = op("implies", op("and", var("a"), op("or", var("b"), {"kind": "unary", "op": "not", "operand": var("c")})),
              op("eq", op("sub", var("n"), op("mul", lit(2), {"kind": "unary", "op": "neg", "operand": var("m")})), lit(-3)))
    assert compile_data(data) == "((v_a /\\ (v_b \\/ (~v_c))) => ((v_n - (2 * (-v_m))) = (-3)))"


@pytest.mark.parametrize("name, symbol", [
    ("and", "/\\"), ("or", "\\/"), ("implies", "=>"), ("eq", "="), ("ne", "#"), ("lt", "<"),
    ("le", "<="), ("gt", ">"), ("ge", ">="), ("add", "+"), ("sub", "-"), ("mul", "*"),
])
def test_every_binary_operation(name, symbol):
    assert compile_data(op(name, var("x"), var("y"))) == f"(v_x {symbol} v_y)"


def test_literals_and_extreme_integers():
    assert literal(True) == "TRUE" and literal(False) == "FALSE"
    assert literal(2**31 - 1) == "2147483647"
    assert literal(-(2**31 - 1)) == "(-2147483647)"
    for value in (2**31, -(2**31)):
        with pytest.raises(UnsupportedConstruct, match="32-битное"):
            literal(value)


def test_strings_are_escaped_not_interpolated():
    assert literal('a"b\\c') == '"a\\"b\\\\c"'
    assert literal("Создана\nвчера\t!") == '"Создана\\nвчера\\t!"'
    assert literal('" /\\ TRUE \\* ') == '"\\" /\\\\ TRUE \\\\* "'
    with pytest.raises(UnsupportedConstruct, match="управляющие"):
        literal("bell\x07")


def test_identifiers_are_prefixed_against_keyword_collisions():
    assert compile_data(op("eq", var("ENABLED"), var("Next"))) == "(v_ENABLED = v_Next)"


def test_depth_limit_reports_path():
    # Контракт не пропустит такое выражение; проверяем, что компилятор не полагается только на него.
    built = LiteralExpression(kind="literal", value=True)
    for _ in range(34):
        built = UnaryExpression.model_construct(kind="unary", op="not", operand=built)
    with pytest.raises(UnsupportedConstruct, match="properties.P.predicate.operand.*глубина"):
        compile_expression(built, "properties.P.predicate")


def test_unknown_construct_is_rejected():
    with pytest.raises(UnsupportedConstruct, match="неподдерживаемая конструкция"):
        compile_expression(object())


# --- #2 валидация и пути к полям ---------------------------------------------

@pytest.mark.parametrize("case", json.loads((MODELS / "invalid_models.json").read_text(encoding="utf-8")), ids=lambda case: case["name"])
def test_invalid_models_report_field_paths(case):
    with pytest.raises(ValidationError) as error:
        BehavioralModel.model_validate(case["model"])
    issues = describe_validation_error(error.value)
    assert any(issue.path == case["path"] and case["message"] in issue.message for issue in issues), issues


@pytest.mark.parametrize("field, value", [("initial_value", True), ("initial_value", "1"), ("initial_value", 1.0)])
def test_integer_is_strict(field, value):
    data = json.loads((MODELS / "stock.json").read_text(encoding="utf-8"))
    data["variables"][0][field] = value
    with pytest.raises(ValidationError):
        BehavioralModel.model_validate(data)


def test_boolean_is_strict():
    data = json.loads((MODELS / "order_bug.json").read_text(encoding="utf-8"))
    data["variables"][1]["initial_value"] = 0
    with pytest.raises(ValidationError):
        BehavioralModel.model_validate(data)


def test_reference_models_serialize_round_trip():
    for path in MODELS.glob("*.json"):
        if path.name in {"expected.json", "invalid_models.json"}:
            continue
        model = BehavioralModel.model_validate_json(path.read_text(encoding="utf-8"))
        assert BehavioralModel.model_validate_json(model.model_dump_json()) == model


def test_preflight_detects_possible_integer_overflow():
    data = json.loads((MODELS / "stock.json").read_text(encoding="utf-8"))
    data["variables"][0]["domain"] = {"kind": "integer", "minimum": 0, "maximum": 2**30}
    data["variables"][0]["initial_value"] = 0
    data["transitions"][1]["effects"][0]["value"] = op("mul", var("free"), lit(4))
    issues = preflight(BehavioralModel.model_validate(data))
    assert [issue.path for issue in issues] == ["transitions.Return.effects[0].value"]
    assert "32-битное" in issues[0].message


def test_preflight_accepts_reference_models():
    for name in ("order_bug", "order_fixed", "tickets", "counter_overflow", "grid", "stock", "order"):
        assert preflight(load(name)) == []


# --- #5/#6 генерация спецификации --------------------------------------------

def test_specification_snapshot():
    model = load("order_bug")
    spec = generate(model, CheckLimits(max_states=500, max_depth=7))
    assert spec.text == (FIXTURES / "tla" / "order_bug.tla").read_text(encoding="utf-8")
    assert spec.config("CanExecute") == (
        "SPECIFICATION Spec\nINVARIANT TypeOK\nINVARIANT LimitStates\nINVARIANT LimitDepth\nINVARIANT p_CanExecute\n"
    )
    assert spec.transitions == {"t_Approve": "Approve", "t_Cancel": "Cancel", "t_Execute": "Execute"}
    assert spec.variables == {"v_status": "status", "v_approved": "approved", "v_cancelled": "cancelled"}


def test_unassigned_variables_are_unchanged_and_effects_read_old_state():
    text = generate(load("tickets"), CheckLimits()).text
    assert "v_sold' = (v_sold + 2)" in text and "v_vip' = TRUE" in text
    assert "UNCHANGED <<v_phase>>" in text
    assert "UNCHANGED <<v_sold, v_vip>>" in text
    assert "LimitDepth" not in text


def test_property_encodings():
    text = generate(load("tickets"), CheckLimits()).text
    assert "p_Capacity == (v_sold <= 3)" in text
    assert "p_VipWithoutSales == ~(v_vip /\\ (v_sold = 0))" in text
    # deadlock_free: допустимое завершение или хотя бы один разрешённый переход
    assert "p_NeverStops == FALSE \\/ ((v_phase = \"Open\") /\\ (v_sold < 3))" in text


def test_names_cannot_break_out_of_comments():
    data = json.loads((MODELS / "stock.json").read_text(encoding="utf-8"))
    data["transitions"][0]["name"] = "Выдать\n====\nNext == FALSE"
    text = generate(BehavioralModel.model_validate(data), CheckLimits()).text
    assert "\\* Выдать ==== Next == FALSE" in text
    assert text.count("====") == 2


# --- #8 разбор результата TLC ------------------------------------------------

def outcome(label, model_name, property_id, returncode, stopped=None, stdout=None, trace=None):
    model = load(model_name)
    prop = next(p for p in model.properties if p.id == property_id)
    limits = CheckLimits()
    result = ProcessResult(
        command=[], returncode=returncode, stdout=stdout if stdout is not None else (TLC / f"{label}.out").read_text(encoding="utf-8"),
        stderr="", elapsed_seconds=0.5, stopped=stopped,
    )
    return interpret(result, prop, model, generate(model, limits), trace or TLC / f"{label}.trace.json", limits)


def test_real_violation_trace_has_types_and_exact_transitions():
    result = outcome("violation", "order_bug", "NoCancelledExecution", 12)
    assert result.status == "PROPERTY_VIOLATED"
    assert [step.transition_id for step in result.trace] == [None, "Approve", "Cancel", "Execute"]
    assert result.trace[-1].state == {"status": "Executed", "approved": True, "cancelled": True}
    assert type(result.trace[0].state["approved"]) is bool
    assert result.statistics.distinct_states == 6 and result.statistics.states_generated >= 6
    assert trace_changes(result.trace)[1] == {"number": 2, "transition_id": "Cancel", "changed": {"status": ["Approved", "Cancelled"], "cancelled": [False, True]}}


def test_real_success_is_holds_with_statistics():
    result = outcome("success", "order_fixed", "NoCancelledExecution", 0)
    assert result.status == "PROPERTY_HOLDS" and not result.trace
    assert result.statistics.distinct_states == 4 and result.statistics.depth is not None


def test_violation_in_initial_state():
    result = outcome("initial", "tickets", "SomethingSold", 12)
    assert result.status == "PROPERTY_VIOLATED"
    assert [step.number for step in result.trace] == [0]


def test_domain_violation_is_model_error():
    result = outcome("domain", "counter_overflow", "NonNegative", 12)
    assert result.status == "MODEL_INVALID" and "n=3" in result.message and not result.trace


@pytest.mark.parametrize("damage", [
    lambda text: text.replace("Model checking completed. No error has been found.", "Model checking completed."),
    lambda text: text[: len(text) // 2],
    lambda text: "",
    lambda text: text.replace("@!@!@STARTMSG 2193", "@!@!@STARTMSG 9999").replace("@!@!@ENDMSG 2193", "@!@!@ENDMSG 9999"),
])
def test_damaged_success_output_is_never_holds(damage):
    text = damage((TLC / "success.out").read_text(encoding="utf-8"))
    result = outcome("success", "order_fixed", "NoCancelledExecution", 0, stdout=text)
    assert result.status == "ENGINE_ERROR"


def test_success_message_with_failing_exit_code_is_engine_error():
    assert outcome("success", "order_fixed", "NoCancelledExecution", 1).status == "ENGINE_ERROR"


def test_unreadable_or_foreign_trace_is_engine_error(tmp_path):
    broken = tmp_path / "trace.json"
    broken.write_text('{"counterexample": {"state": [[1, {"v_status": "Created"}]]}}')
    assert outcome("violation", "order_bug", "NoCancelledExecution", 12, trace=broken).status == "ENGINE_ERROR"
    assert outcome("violation", "order_bug", "NoCancelledExecution", 12, trace=tmp_path / "missing.json").status == "ENGINE_ERROR"
    data = json.loads((TLC / "violation.trace.json").read_text(encoding="utf-8"))
    data["counterexample"]["action"][1][1]["name"] = "t_Execute"
    broken.write_text(json.dumps(data))
    result = outcome("violation", "order_bug", "NoCancelledExecution", 12, trace=broken)
    assert result.status == "ENGINE_ERROR" and "не совпадает" in result.message


def test_violation_with_unexpected_exit_code_is_engine_error():
    assert outcome("violation", "order_bug", "NoCancelledExecution", 0).status == "ENGINE_ERROR"


def test_unknown_error_messages_are_engine_error():
    text = "@!@!@STARTMSG 1000:1 @!@!@\nTLC threw an unexpected exception.\n@!@!@ENDMSG 1000 @!@!@\n"
    result = outcome("success", "order_fixed", "NoCancelledExecution", 255, stdout=text)
    assert result.status == "ENGINE_ERROR" and "unexpected exception" in result.message


def test_stopped_processes_are_inconclusive():
    assert outcome("success", "order_fixed", "NoCancelledExecution", -15, stopped="timeout").status == "TIMEOUT"
    cancelled = outcome("success", "order_fixed", "NoCancelledExecution", -15, stopped="cancelled")
    assert cancelled.status == "ENGINE_ERROR" and cancelled.message.startswith("CANCELLED")


def test_statistics_are_not_invented():
    assert statistics(messages("")) == CheckStatistics()
    progress = "@!@!@STARTMSG 2200:0 @!@!@\nProgress(12) at 2026-10-29: 1,234 states generated (5 s/min), 1,000 distinct states found (4 ds/min), 7 states left on queue.\n@!@!@ENDMSG 2200 @!@!@\n"
    assert statistics(messages(progress)) == CheckStatistics(states_generated=1234, distinct_states=1000, depth=11)


# --- #10 комплект материалов -------------------------------------------------

def test_bundle_lists_only_manifest_files(tmp_path):
    store = ArtifactStore(tmp_path)
    bundle = store.create()
    bundle.write("Spec.tla", "---- MODULE Spec ----\n====\n")
    bundle.finish({"steps": []})
    (tmp_path / "secret.txt").write_text("x")
    assert bundle.files() == ["Spec.tla"]
    assert bundle.open("Spec.tla").read_text().startswith("----")
    for name in ("../secret.txt", "/etc/passwd", "manifest.json", "missing.log"):
        with pytest.raises(ArtifactError):
            bundle.open(name)
    with pytest.raises(ArtifactError):
        store.bundle("../../etc")


def test_bundle_detects_tampering(tmp_path):
    model = load("stock")
    request = make_request(model)
    bundle = ArtifactStore(tmp_path).create()
    bundle.write("request.json", request.model_dump_json())
    bundle.write("report.json", "{}")
    bundle.finish({})
    bundle.file("request.json").write_text(request.model_dump_json() + " ")
    with pytest.raises(ArtifactError, match="изменён"):
        bundle.verify()


# --- #43 кэш -----------------------------------------------------------------

def cached_result(model, limits, status="PROPERTY_HOLDS", distinct=6, depth=5, engine="v1"):
    return VerificationResult(
        spec_hash=spec_hash(model), mode="engine", executed=True, engine=EngineInfo(name="TLC", version=engine),
        limits=limits, property_id=model.properties[0].id, status=status,
        conclusive=status in {"PROPERTY_HOLDS", "PROPERTY_VIOLATED"}, message="Свойство выполняется",
        statistics=CheckStatistics(states_generated=distinct, distinct_states=distinct, depth=depth),
    )


def test_cache_reuses_only_sufficient_conclusive_results(tmp_path):
    model = load("stock")
    cache = ResultCache(tmp_path)
    cache.put(cached_result(model, CheckLimits()))
    request = make_request(model, limits=CheckLimits(timeout_seconds=5.0, max_states=6), version_id="v2")
    hit = cache.get(request, "Nonnegative", "v1", spec_hash(model))
    assert hit is not None and hit.message.startswith(CACHE_MARK)
    assert hit.limits == request.limits and hit.version_id == "v2"
    assert cache.get(make_request(model, limits=CheckLimits(max_states=5)), "Nonnegative", "v1", spec_hash(model)) is None
    assert cache.get(make_request(model, limits=CheckLimits(max_depth=4)), "Nonnegative", "v1", spec_hash(model)) is None
    assert cache.get(make_request(model, limits=CheckLimits(max_depth=5)), "Nonnegative", "v1", spec_hash(model)) is not None


def test_cache_separates_engine_property_model_and_compiler(tmp_path, monkeypatch):
    model = load("stock")
    cache = ResultCache(tmp_path)
    cache.put(cached_result(model, CheckLimits()))
    request = make_request(model)
    assert cache.get(request, "Nonnegative", "v2", spec_hash(model)) is None
    assert cache.get(request, "Other", "v1", spec_hash(model)) is None
    assert cache.get(request, "Nonnegative", "v1", "0" * 64) is None
    key = cache_key(spec_hash(model), "Nonnegative", "v1")
    monkeypatch.setattr("proveryalka.checker.cache.COMPILER_VERSION", "2")
    assert cache_key(spec_hash(model), "Nonnegative", "v1") != key
    assert cache.get(request, "Nonnegative", "v1", spec_hash(model)) is None


def test_cache_ignores_inconclusive_results(tmp_path):
    model = load("stock")
    cache = ResultCache(tmp_path)
    for status in ("TIMEOUT", "STATE_LIMIT_REACHED", "ENGINE_ERROR", "MODEL_INVALID"):
        cache.put(cached_result(model, CheckLimits(), status=status))
    assert not list(tmp_path.rglob("*.json"))
