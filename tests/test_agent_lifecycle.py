import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import httpx2
import pytest
from agents import ModelResponse, RunContextWrapper
from agents.tool_context import ToolContext
from agents.usage import Usage
from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

from proveryalka.agent import dialogue, errors, revision, verification
from proveryalka.agent.clarification import DialogueDraft, build_state
from proveryalka.behavior import BehavioralModel, initial_state, step
from proveryalka.contracts import Source
from proveryalka.storage.session import StoredSession
from proveryalka.storage.sqlite import SQLiteStore
from proveryalka.verification.checker import make_request
from proveryalka.verification.contracts import VerificationReport
from test_verification import FixtureChecker, ScriptedModel, configure_sdk


ROOT = Path(__file__).resolve().parents[1]


def session_for(tmp_path):
    store = SQLiteStore(tmp_path / 'history.sqlite3')
    store.initialize()
    identifier = store.create_session({'title': 'Сценарий'}, 'session')['id']
    return StoredSession(store, identifier)


def case_for(session):
    case = json.loads((ROOT / 'tests/fixtures/formal_cases.json').read_text(encoding='utf-8'))[0]
    source = Source.model_validate({**case['source'], 'session_id': session.session_id})
    return case, source


@pytest.mark.parametrize('failure,code', [
    ('timeout', 'PROVIDER_TIMEOUT'), ('rate', 'PROVIDER_RATE_LIMIT'),
    ('connection', 'PROVIDER_UNAVAILABLE'), ('server', 'PROVIDER_UNAVAILABLE'),
    ('auth', 'PROVIDER_AUTH'), ('missing', 'PROVIDER_NOT_FOUND'),
])
def test_provider_errors_are_identified_without_retries_or_leaking_response(monkeypatch, failure, code):
    request = httpx2.Request('POST', 'https://example.invalid')
    status = {'rate': 429, 'auth': 401, 'missing': 404}.get(failure, 503)
    response = httpx2.Response(status, request=request)
    failures = {
        'timeout': APITimeoutError(request),
        'rate': RateLimitError('private provider detail', response=response, body=None),
        'connection': APIConnectionError(request=request),
        'server': APIStatusError('private provider detail', response=response, body=None),
        'auth': APIStatusError('private provider detail', response=response, body=None),
        'missing': APIStatusError('private provider detail', response=response, body=None),
    }
    calls = []

    async def run(*args, **kwargs):
        calls.append(1)
        raise failures[failure]

    monkeypatch.setattr(errors.Runner, 'run', run)
    with pytest.raises(errors.AgentError) as error:
        asyncio.run(errors.run_agent(object(), input='Текст'))
    assert error.value.code == code and len(calls) == 1
    assert 'private provider detail' not in str(error.value)


def test_context_limit_stops_before_llm(monkeypatch):
    async def run(*args, **kwargs):
        pytest.fail('Провайдер не должен получать слишком большой контекст')

    monkeypatch.setattr(errors.Runner, 'run', run)
    with pytest.raises(errors.AgentError) as error:
        asyncio.run(errors.run_agent(object(), input='x' * (errors.MAX_CONTEXT_CHARS + 1)))
    assert error.value.code == 'CONTEXT_LIMIT'
    with pytest.raises(errors.AgentError):
        errors.check_context('ab', used_chars=errors.MAX_CONTEXT_CHARS - 1)


def test_run_deadline_cancels_the_runner(monkeypatch):
    cancelled = []

    async def run(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    monkeypatch.setattr(errors.Runner, 'run', run)
    monkeypatch.setattr(errors, 'MAX_RUN_SECONDS', 0.01)
    with pytest.raises(errors.AgentError) as error:
        asyncio.run(errors.run_agent(object(), input='Текст'))
    assert error.value.code == 'RUN_TIMEOUT' and cancelled == [True]


def test_large_tool_result_keeps_the_actual_report():
    model = BehavioralModel.model_validate_json((ROOT / 'tests/fixtures/models/order.json').read_text(encoding='utf-8'))
    checker = FixtureChecker()
    context = verification.VerificationContext(request=make_request(model), checker=checker, input_chars=errors.MAX_CONTEXT_CHARS)

    async def scenario():
        wrapper = RunContextWrapper(context=context)
        tool_context = ToolContext.from_agent_context(wrapper, tool_call_id='check1', tool_name='check_behavior', tool_arguments='{}')
        with pytest.raises(errors.AgentError) as error:
            await verification.check_behavior_tool.on_invoke_tool(tool_context, '{}')
        assert error.value.code == 'CONTEXT_LIMIT'
        assert context.report.results[0].status == 'PROPERTY_VIOLATED' and len(checker.calls) == 1

    asyncio.run(scenario())


def test_large_tool_result_is_saved_when_sdk_stops_explanation(tmp_path, monkeypatch):
    session = session_for(tmp_path)
    data = json.loads((ROOT / 'tests/fixtures/models/order.json').read_text(encoding='utf-8'))
    for source in data['sources']:
        source['session_id'] = session.session_id
    model = BehavioralModel.model_validate(data)
    configure_sdk(monkeypatch, ScriptedModel())
    monkeypatch.setattr(errors, 'MAX_CONTEXT_CHARS', 10_000)

    def enlarge(data, request):
        data['results'][0]['message'] = 'x' * 15_000

    async def scenario():
        with pytest.raises(errors.AgentError) as error:
            await verification.verify_and_explain(model, FixtureChecker(mutate=enlarge), session=session)
        assert error.value.code == 'CONTEXT_LIMIT'
        saved = await verification.load_verification(session)
        assert saved.report.results[0].status == 'PROPERTY_VIOLATED' and saved.explanation is None

    asyncio.run(scenario())


def test_invalid_checker_trace_is_reported_without_a_false_verdict(monkeypatch):
    model = BehavioralModel.model_validate_json((ROOT / 'tests/fixtures/models/order.json').read_text(encoding='utf-8'))
    configure_sdk(monkeypatch, ScriptedModel())
    events = []

    def corrupt(data, request):
        data['results'][0]['trace'][0]['state']['approved'] = True

    async def emit(event):
        events.append(event)

    with pytest.raises(errors.AgentError) as error:
        asyncio.run(verification.verify_and_explain(model, FixtureChecker(mutate=corrupt), on_event=emit))
    assert error.value.code == 'INVALID_CHECKER_RESULT'
    assert [event.event for event in events] == ['tool_started', 'tool_failed']
    assert events[-1].report is None


def test_invalid_explanation_is_corrected_without_rechecking(monkeypatch):
    model = BehavioralModel.model_validate_json((ROOT / 'tests/fixtures/models/order.json').read_text(encoding='utf-8'))
    checker = FixtureChecker()

    class DuplicateOnce(ScriptedModel):
        async def get_response(self, system_instructions, input, *args, **kwargs):
            if len(self.calls) < 2:
                response = await super().get_response(system_instructions, input, *args, **kwargs)
                if len(self.calls) == 2:
                    content = response.output[0].content[0]
                    data = json.loads(content.text)
                    data['properties'].append(copy.deepcopy(data['properties'][0]))
                    content.text = json.dumps(data, ensure_ascii=False)
                return response
            self.calls.append(copy.deepcopy(input))
            payload = json.loads(input[0]['content']) if isinstance(input, list) else json.loads(input)
            assert 'Объяснение относится к другим свойствам' in payload['validation_feedback']['error']
            report = VerificationReport.model_validate(payload['verification_result']['report'])
            narrative = verification.VerificationNarrative(summary='Тестовый результат', properties=[{
                'property_id': item.property_id, 'explanation': 'Тестовая трасса',
                'steps': [{'number': step.number, 'explanation': 'Шаг'} for step in item.trace],
            } for item in report.results])
            return ModelResponse(output=[ResponseOutputMessage(
                id='repair', type='message', role='assistant', status='completed',
                content=[ResponseOutputText(type='output_text', text=narrative.model_dump_json(), annotations=[])],
            )], usage=Usage(), response_id='repair')

    scripted = DuplicateOnce()
    configure_sdk(monkeypatch, scripted)
    outcome = asyncio.run(verification.verify_and_explain(model, checker))
    assert len(checker.calls) == 1 and len(scripted.calls) == 3
    assert len(outcome.explanation.properties) == 1


def test_interrupted_turn_can_be_resumed_without_repeating_user_message(tmp_path, monkeypatch):
    session = session_for(tmp_path)
    case, source = case_for(session)
    attempts = []

    async def generate(payload, sources, previous, question_id, max_rounds):
        attempts.append(payload)
        if len(attempts) == 1:
            raise errors.AgentError('PROVIDER_TIMEOUT', 'Время истекло')
        draft = DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[])
        return build_state(sources, draft, previous, question_id, max_rounds)

    monkeypatch.setattr(dialogue, 'generate_state', generate)

    async def scenario():
        with pytest.raises(errors.AgentError):
            await dialogue.start_dialogue(source, session)
        assert (await dialogue.load_pending(session)).source == source
        assert await dialogue.load_dialogue(session) is None
        state = await dialogue.resume_pending(StoredSession(SQLiteStore(session.store.path), session.session_id))
        assert state.status == 'ready' and await dialogue.load_pending(session) is None
        messages = await session.get_items()
        assert sum(item['role'] == 'user' and item['content'] == source.text for item in messages) == 1
        assert len(attempts) == 2

    asyncio.run(scenario())


@pytest.mark.parametrize('cancel_task', [False, True])
def test_cancellation_preserves_pending_turn(tmp_path, monkeypatch, cancel_task):
    session = session_for(tmp_path)
    case, source = case_for(session)
    started = asyncio.Event()
    finish = asyncio.Event()

    async def generate(payload, sources, previous, question_id, max_rounds):
        started.set()
        await finish.wait()
        draft = DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[])
        return build_state(sources, draft, previous, question_id, max_rounds)

    monkeypatch.setattr(dialogue, 'generate_state', generate)

    async def scenario():
        task = asyncio.create_task(dialogue.start_dialogue(source, session))
        await started.wait()
        if cancel_task:
            task.cancel()
        else:
            await dialogue.cancel_pending(session)
            finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        if cancel_task:
            assert (await dialogue.load_pending(session)).source == source
            await dialogue.cancel_pending(session)
        assert await dialogue.load_pending(session) is None
        assert await dialogue.load_dialogue(session) is None

    asyncio.run(scenario())


@pytest.mark.parametrize('explanation_fails', [False, True])
def test_explicit_correction_keeps_both_reports_and_links_recheck(tmp_path, monkeypatch, explanation_fails):
    session = session_for(tmp_path)
    case, source = case_for(session)
    old_rule = 'Approve доступен в любом состоянии и устанавливает status=Approved, approved=true.'
    guarded_rule = 'Approve доступен только при cancelled=false и устанавливает status=Approved, approved=true.'
    case['source']['text'] = case['source']['text'].replace(old_rule, guarded_rule)
    source = source.model_copy(update={'text': case['source']['text']})
    for requirement in case['draft']['requirements']:
        requirement['text'] = requirement['text'].replace(old_rule, guarded_rule)
        requirement['quote'] = requirement['quote'].replace(old_rule, guarded_rule)
    case['draft']['events'][0]['quote'] = guarded_rule
    case['draft']['events'][0]['guard'] = {
        'kind': 'binary', 'op': 'eq',
        'left': {'kind': 'variable', 'name': 'cancelled'},
        'right': {'kind': 'literal', 'value': False},
    }
    initial = build_state([source], DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[]), None, None, 5)
    configure_sdk(monkeypatch, ScriptedModel())
    message = 'Cancel доступен в любом состоянии и устанавливает status=Cancelled, cancelled=true, approved=false.'

    async def generate(payload, sources, previous, question_id, max_rounds):
        assert payload['verification_context']['question'] == 'Как нужно уточнить правило?'
        assert payload['verification_context']['report']['results'][0]['status'] == 'PROPERTY_VIOLATED'
        data = copy.deepcopy(case['draft'])
        for fact, old in zip(data['requirements'], previous.analysis.requirements):
            fact['previous_id'] = old.id
        data['requirements'][2].update(text=message, quote=message, source_id=sources[-1].id)
        data['events'][1]['quote'] = message
        data['events'][1]['effects'].append({'variable': 'approved', 'value': {'kind': 'literal', 'value': False}})
        draft = DialogueDraft(analysis=data, questions=[], resolutions=[], corrections=[{
            'requirement_id': previous.analysis.requirements[2].id, 'reason': 'Явное изменение правила', 'quote': message,
        }])
        return build_state(sources, draft, previous, question_id, max_rounds)

    monkeypatch.setattr(dialogue, 'generate_state', generate)

    async def scenario():
        await session.add_items([{'role': 'assistant', 'content': json.dumps({'analyst_dialogue': initial.model_dump(mode='json')}, ensure_ascii=False)}])
        before = await verification.verify_dialogue(session, FixtureChecker(), version_id='v1')
        unchanged = before.request.model.model_dump_json()
        with pytest.raises(ValueError, match='явное уточнение'):
            await revision.verify_revision(session, FixtureChecker('PROPERTY_HOLDS'), version_id='v2')
        revised = await dialogue.reply_dialogue(session, message)
        assert revised.status == 'ready'
        configure_sdk(monkeypatch, ScriptedModel(fail_explanation=explanation_fails))
        checker = FixtureChecker('PROPERTY_HOLDS')
        if explanation_fails:
            with pytest.raises(RuntimeError, match='LLM explanation failed'):
                await revision.verify_revision(session, checker, version_id='v2')
            saved = await verification.load_verification(session)
            assert saved.explanation is None
            link = await revision.load_revision(session)

            async def explain(agent, input, **kwargs):
                payload = json.loads(input)['verification_result']
                assert payload['report']['results'][0]['status'] == 'PROPERTY_HOLDS'
                narrative = verification.VerificationNarrative(summary='Тестовый результат', properties=[{
                    'property_id': item.property_id, 'explanation': 'Проверенный ответ адаптера', 'steps': [],
                } for item in saved.report.results])
                return SimpleNamespace(final_output=narrative)

            monkeypatch.setattr(verification, 'run_agent', explain)
            recovered = await verification.resume_explanation(session)
            assert recovered.report == saved.report and recovered.explanation is not None
            assert recovered.check_id == saved.check_id
            assert len(checker.calls) == 1
            result = revision.RevisionOutcome(previous=before, current=recovered, link=link)
        else:
            result = await revision.verify_revision(session, checker, version_id='v2')
        assert result.previous.request.model.model_dump_json() == unchanged
        assert result.previous.report.results[0].status == 'PROPERTY_VIOLATED'
        assert result.current.report.results[0].status == 'PROPERTY_HOLDS'
        assert result.link.before_version_id == 'v1' and result.link.after_version_id == 'v2'
        assert result.link.before_hash != result.link.after_hash
        assert result.link.before_check_id == result.previous.check_id
        assert result.link.after_check_id == result.current.check_id
        assert result.link.before_check_id != result.link.after_check_id
        assert result.link.corrections[0].quote == message
        assert result.link.properties[0].same_property
        after_cancel = step(result.current.request.model, step(result.current.request.model, initial_state(result.current.request.model), 'Approve'), 'Cancel')
        with pytest.raises(ValueError, match='недоступен'):
            step(result.current.request.model, after_cancel, 'Approve')
        with pytest.raises(ValueError, match='недоступен'):
            step(result.current.request.model, after_cancel, 'Execute')
        assert await revision.load_revision(StoredSession(SQLiteStore(session.store.path), session.session_id)) == result.link
        restored = await revision.load_revision_outcome(StoredSession(SQLiteStore(session.store.path), session.session_id))
        assert restored == result
        assert 'Тестовый адаптер' in revision.render_revision(result)

    asyncio.run(scenario())


def test_verification_refuses_ready_state_while_turn_is_pending(tmp_path, monkeypatch):
    session = session_for(tmp_path)
    case, source = case_for(session)
    ready = build_state([source], DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[]), None, None, 5)

    async def fail(*args, **kwargs):
        raise errors.AgentError('PROVIDER_UNAVAILABLE', 'Не удалось подключиться')

    monkeypatch.setattr(dialogue, 'generate_state', fail)
    scripted = ScriptedModel()
    configure_sdk(monkeypatch, scripted)
    checker = FixtureChecker()

    async def scenario():
        await session.add_items([{'role': 'assistant', 'content': json.dumps({'analyst_dialogue': ready.model_dump(mode='json')}, ensure_ascii=False)}])
        with pytest.raises(errors.AgentError):
            await dialogue.reply_dialogue(session, 'Исправляю: при Cancel approved сбрасывается в false.')
        assert (await dialogue.load_dialogue(session)).status == 'ready'
        assert await dialogue.load_pending(session) is not None
        # Прежняя готовая модель не должна проверяться, пока уточнение не завершено или не отменено.
        with pytest.raises(ValueError, match='незавершённое'):
            await verification.verify_dialogue(session, checker)
        assert checker.calls == [] and scripted.calls == []
        assert await verification.load_verification(session) is None
        await dialogue.cancel_pending(session)
        outcome = await verification.verify_dialogue(session, checker)
        assert len(checker.calls) == 1 and outcome.report.results[0].status == 'PROPERTY_VIOLATED'

    asyncio.run(scenario())
