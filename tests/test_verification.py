import asyncio
import copy
import json
from pathlib import Path

import pytest
from agents import Agent, Model, ModelResponse, RunContextWrapper
from agents.usage import Usage
from agents.tool_context import ToolContext
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText
from pydantic import ValidationError

from proveryalka.agent import verification
from proveryalka.behavior import BehavioralModel, initial_state, step
from proveryalka.verification import CheckLimits, CheckerError, VerificationRequest, check_behavior
from proveryalka.verification.checker import spec_hash
from proveryalka.verification.contracts import EngineInfo, TraceStep, VerificationReport, VerificationResult
from proveryalka.storage.session import StoredSession
from proveryalka.storage.sqlite import SQLiteStore


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def model():
    return BehavioralModel.model_validate_json((ROOT / 'docs/examples/order.json').read_text(encoding='utf-8'))


def fixture_report(request, status='PROPERTY_VIOLATED'):
    trace = []
    if status == 'PROPERTY_VIOLATED':
        state = initial_state(request.model)
        trace.append(TraceStep(number=0, transition_id=None, state=state))
        for index, action in enumerate(('Approve', 'Cancel', 'Execute'), 1):
            state = step(request.model, state, action)
            trace.append(TraceStep(number=index, transition_id=action, state=state))
    return VerificationReport(
        results=[VerificationResult(
            spec_hash=spec_hash(request.model), version_id=request.version_id, mode='test', executed=True,
            engine=EngineInfo(name='test-fixture', version='1'), limits=request.limits,
            property_id=identifier, status=status,
            conclusive=status in {'PROPERTY_HOLDS', 'PROPERTY_VIOLATED'},
            message='Явно заданный тестовый ответ адаптера', trace=trace,
        ) for identifier in request.property_ids],
    )


class FixtureChecker:
    def __init__(self, status='PROPERTY_VIOLATED', mutate=None):
        self.status = status
        self.mutate = mutate
        self.calls = []

    async def check(self, request):
        self.calls.append(request)
        result = fixture_report(request, self.status)
        data = result.model_dump(mode='json')
        if self.mutate:
            self.mutate(data, request)
        return VerificationReport.model_validate(data)


@pytest.mark.parametrize('status', ['PROPERTY_HOLDS', 'PROPERTY_VIOLATED', 'MODEL_INVALID', 'TIMEOUT', 'STATE_LIMIT_REACHED', 'ENGINE_ERROR'])
def test_six_statuses_and_provenance(model, status):
    if status == 'PROPERTY_HOLDS':
        model = BehavioralModel.model_validate_json((ROOT / 'docs/examples/stock.json').read_text(encoding='utf-8'))
    checker = FixtureChecker(status)
    report = asyncio.run(check_behavior(model, checker))
    assert len(checker.calls) == 1 and report.mode == 'test'
    result = report.results[0]
    assert result.status == status
    assert result.conclusive == (status in {'PROPERTY_HOLDS', 'PROPERTY_VIOLATED'})
    assert result.related_requirements


def test_unavailable_engine_never_calls_llm(model, monkeypatch):
    def forbidden():
        pytest.fail('LLM не нужна для сообщения об отсутствующем ядре')

    monkeypatch.setattr(verification, 'create_client', forbidden)
    outcome = asyncio.run(verification.verify_and_explain(model))
    assert outcome.report.executed is False and outcome.explanation is None
    assert outcome.report.engine is None
    assert outcome.report.results[0].status == 'ENGINE_ERROR'
    assert 'CHECKER_UNAVAILABLE' in outcome.report.results[0].message
    assert 'не запускалось' in verification.render_verification(outcome)


@pytest.mark.parametrize('mutation', ['hash', 'property', 'limits', 'state', 'number', 'transition', 'missing_trace', 'success_from_timeout', 'request_mutated'])
def test_forged_or_inconsistent_results_are_rejected(model, mutation):
    def mutate(data, request):
        result = data['results'][0]
        if mutation == 'hash':
            result['spec_hash'] = '0' * 64
        elif mutation == 'property':
            result['property_id'] = 'unknown_property'
        elif mutation == 'limits':
            result['limits']['max_states'] += 1
        elif mutation == 'state':
            result['trace'][2]['state']['approved'] = False
        elif mutation == 'number':
            result['trace'][1]['number'] = 7
        elif mutation == 'transition':
            result['trace'][1]['transition_id'] = 'Unknown'
        elif mutation == 'missing_trace':
            result['trace'] = []
        elif mutation == 'success_from_timeout':
            result.update(status='TIMEOUT', conclusive=True, trace=[])
        else:
            request.property_ids.clear()

    with pytest.raises((ValueError, ValidationError)):
        asyncio.run(check_behavior(model, FixtureChecker(mutate=mutate)))


def test_false_verdict_contradicting_initial_state_is_rejected(model):
    value = model.model_dump()
    value['properties'][0]['predicate'] = {'kind': 'literal', 'value': True}
    altered = BehavioralModel.model_validate(value)
    with pytest.raises(ValueError, match='начальному состоянию'):
        asyncio.run(check_behavior(altered, FixtureChecker('PROPERTY_HOLDS')))


def test_reachable_success_has_a_witness_instead_of_counterexample(model):
    data = model.model_dump()
    data['properties'][0].update(kind='reachable', predicate={'kind': 'literal', 'value': True})
    reachable = BehavioralModel.model_validate(data)

    def add_witness(data, request):
        data['results'][0]['trace'] = [{'number': 0, 'transition_id': None, 'state': initial_state(request.model)}]

    report = asyncio.run(check_behavior(reachable, FixtureChecker('PROPERTY_HOLDS', add_witness)))
    assert report.results[0].status == 'PROPERTY_HOLDS' and len(report.results[0].trace) == 1


def test_timeout_cancels_the_adapter_and_is_not_success(model):
    class SlowChecker:
        cancelled = False

        async def check(self, request):
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled = True

    checker = SlowChecker()
    report = asyncio.run(check_behavior(model, checker, limits=CheckLimits(timeout_seconds=0.01)))
    assert checker.cancelled
    assert report.results[0].status == 'TIMEOUT' and not report.results[0].conclusive


def test_adapter_cannot_mutate_caller_limits(model):
    limits = CheckLimits(max_states=25)

    def mutate(data, request):
        request.limits.max_states = 999

    with pytest.raises(ValueError, match='изменил'):
        asyncio.run(check_behavior(model, FixtureChecker(mutate=mutate), limits=limits))
    assert limits.max_states == 25


def test_known_checker_error_is_structured_but_programming_errors_propagate(model):
    class BrokenChecker:
        async def check(self, request):
            raise CheckerError('Движок не удалось запустить')

    assert asyncio.run(check_behavior(model, BrokenChecker())).results[0].status == 'ENGINE_ERROR'

    class BuggyChecker:
        async def check(self, request):
            raise RuntimeError('programming error')

    with pytest.raises(RuntimeError, match='programming error'):
        asyncio.run(check_behavior(model, BuggyChecker()))


class ScriptedModel(Model):
    def __init__(self, fail_explanation=False):
        self.calls = []
        self.fail_explanation = fail_explanation

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs):
        self.calls.append(copy.deepcopy(input))
        if len(self.calls) == 1:
            output = [ResponseFunctionToolCall(type='function_call', name='check_behavior', arguments='{}', call_id='check1')]
        else:
            if self.fail_explanation:
                raise RuntimeError('LLM explanation failed')
            tool_output = next(item for item in input if isinstance(item, dict) and item.get('type') == 'function_call_output')
            report = VerificationReport.model_validate_json(tool_output['output'])
            narrative = verification.VerificationNarrative(
                summary='Тестовый результат для проверки интеграции',
                question='Как нужно уточнить правило?' if any(result.status == 'PROPERTY_VIOLATED' for result in report.results) else None,
                properties=[verification.PropertyExplanation(
                    property_id=result.property_id, explanation='Объяснение фактического тестового результата',
                    steps=[verification.TraceComment(number=s.number, explanation='Фактический шаг тестовой трассы') for s in result.trace],
                ) for result in report.results],
            )
            output = [ResponseOutputMessage(
                id='message1', type='message', role='assistant', status='completed',
                content=[ResponseOutputText(type='output_text', text=narrative.model_dump_json(), annotations=[])],
            )]
        return ModelResponse(output=output, usage=Usage(), response_id=f'response{len(self.calls)}')

    async def stream_response(self, *args, **kwargs):
        raise AssertionError('Streaming is not used')
        yield


def configure_sdk(monkeypatch, scripted):
    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr(verification, 'create_client', Client)
    monkeypatch.setattr(verification, 'create_agent', lambda client: Agent(name='verification-test', model=scripted))


def test_real_sdk_loop_calls_tool_once_and_preserves_test_label(model, monkeypatch):
    scripted = ScriptedModel()
    configure_sdk(monkeypatch, scripted)
    checker = FixtureChecker()
    outcome = asyncio.run(verification.verify_and_explain(model, checker))
    assert len(scripted.calls) == 2 and len(checker.calls) == 1
    assert outcome.explanation is not None
    assert outcome.report.results[0].status == 'PROPERTY_VIOLATED'
    assert 'не результат TLC' in verification.render_verification(outcome)
    assert verification.check_behavior_tool.params_json_schema['properties'] == {}


def test_engine_result_survives_an_explanation_failure(model, monkeypatch, tmp_path):
    scripted = ScriptedModel(fail_explanation=True)
    configure_sdk(monkeypatch, scripted)
    store = SQLiteStore(tmp_path / 'verification.sqlite3')
    store.initialize()
    session_id = store.create_session({'title': 'Проверка'}, 'session')['id']
    session = StoredSession(store, session_id)
    data = model.model_dump()
    for source in data['sources']:
        source['session_id'] = session_id
    model = BehavioralModel.model_validate(data)

    async def scenario():
        with pytest.raises(RuntimeError, match='LLM explanation failed'):
            await verification.verify_and_explain(model, FixtureChecker(), session=session)
        restored = await verification.load_verification(StoredSession(SQLiteStore(store.path), session_id))
        assert restored.report.results[0].status == 'PROPERTY_VIOLATED'
        assert restored.explanation is None
        assert len(await session.get_items()) == 2

    asyncio.run(scenario())


def test_cross_session_model_is_rejected_before_any_request(model, tmp_path):
    store = SQLiteStore(tmp_path / 'session.sqlite3')
    store.initialize()
    session_id = store.create_session({'title': 'Другая сессия'}, 'other')['id']
    session = StoredSession(store, session_id)
    with pytest.raises(ValueError, match='другой сессии'):
        asyncio.run(verification.verify_and_explain(model, session=session))


@pytest.mark.parametrize('bad', ['property', 'step'])
def test_explanation_cannot_invent_properties_or_steps(model, bad):
    report = asyncio.run(check_behavior(model, FixtureChecker()))
    result = report.results[0]
    narrative = verification.VerificationNarrative(summary='Тест', properties=[{
        'property_id': 'invented' if bad == 'property' else result.property_id,
        'explanation': 'Тестовое объяснение',
        'steps': [{'number': 99 if bad == 'step' else s.number, 'explanation': 'Шаг'} for s in result.trace],
    }])
    with pytest.raises(ValueError):
        verification.validate_explanation(report, narrative)


def test_duplicate_tool_calls_cannot_start_two_checks(model):
    checker = FixtureChecker()
    context = verification.VerificationContext(
        request=VerificationRequest(model=model, property_ids=[model.properties[0].id]), checker=checker,
    )

    async def scenario():
        wrapper = RunContextWrapper(context=context)
        result = await asyncio.gather(*[
            verification.check_behavior_tool.on_invoke_tool(ToolContext.from_agent_context(
                wrapper, tool_call_id=f'call{index}', tool_name='check_behavior', tool_arguments='{}',
            ), '{}') for index in range(2)
        ], return_exceptions=True)
        assert sum(isinstance(item, ValueError) for item in result) == 1
        assert len(checker.calls) == 1

    asyncio.run(scenario())


@pytest.mark.parametrize('terminal', [False, True])
def test_deadlock_trace_respects_allowed_terminal_states(model, terminal):
    data = model.model_dump()
    data['transitions'] = []
    data['properties'][0].update(kind='deadlock_free', predicate={'kind': 'literal', 'value': terminal})
    static = BehavioralModel.model_validate(data)

    def terminal_trace(data, request):
        data['results'][0].update(status='PROPERTY_VIOLATED', conclusive=True,
            trace=[{'number':0, 'transition_id':None, 'state':initial_state(request.model)}])

    checker = FixtureChecker('ENGINE_ERROR', terminal_trace)
    if terminal:
        with pytest.raises(ValueError, match='тупиком'):
            asyncio.run(check_behavior(static, checker))
    else:
        assert asyncio.run(check_behavior(static, checker)).results[0].status == 'PROPERTY_VIOLATED'
