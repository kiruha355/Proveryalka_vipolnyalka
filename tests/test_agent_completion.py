import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest
from agents import Agent, ModelResponse, Usage, UserError
from openai.types.responses import ResponseOutputMessage, ResponseOutputText
from pydantic import ValidationError

from proveryalka.agent import dialogue, verification
from proveryalka.agent.clarification import DialogueDraft, build_state
from proveryalka.behavior import BehavioralModel
from proveryalka.contracts import Source
from proveryalka.verification import CommandChecker, VerificationRequest, check_behavior
from test_verification import FixtureChecker, ScriptedModel, configure_sdk


ROOT = Path(__file__).resolve().parents[1]


def order_case():
    return json.loads((ROOT / 'tests/fixtures/formal_cases.json').read_text(encoding='utf-8'))[0]


@pytest.mark.parametrize('decision', ['confirmed', 'rejected'])
def test_property_proposal_requires_approval_and_keeps_its_origin(decision):
    case = order_case()
    source = Source.model_validate(case['source'])
    proposal = case['draft']['properties'][0]
    proposal.update(origin='proposal', assumption=proposal['name'])
    assumption = {'text': proposal['assumption'], 'quote': proposal['quote'], 'reason': 'Предложенный критерий проверки'}
    case['draft']['assumptions'] = [assumption]
    first = build_state([source], DialogueDraft(analysis=case['draft'], questions=[{
        'kind': 'assumption', 'assumption': assumption['text'],
        'text': 'Проверять предложенное ограничение?', 'reason': assumption['reason'],
    }], resolutions=[], corrections=[]), None, None, 5)
    assert first.analysis.behavior is None
    answer = Source(id='confirmation', session_id=source.session_id, text='Да, проверяй.' if decision == 'confirmed' else 'Нет, не проверяй.')
    updated = copy.deepcopy(case['draft'])
    updated['assumptions'] = []
    for item, old in zip(updated['requirements'], first.analysis.requirements):
        item['previous_id'] = old.id
    if decision == 'rejected':
        updated['properties'] = []
    next_draft = DialogueDraft(analysis=updated, questions=[], corrections=[], resolutions=[{
        'question_id': first.questions[0].id, 'decision': decision, 'quote': answer.text,
    }])
    second = build_state([source, answer], next_draft, first, first.questions[0].id, 5)
    assert second.status == 'ready'
    assert second.analysis.behavior.transitions == BehavioralModel.model_validate_json((ROOT / 'docs/examples/order.json').read_text(encoding='utf-8')).transitions
    if decision == 'confirmed':
        prop = second.analysis.behavior.properties[0]
        assert prop.origin == 'proposal' and prop.approved_by.source_id == answer.id
        assert second.property_approvals[prop.id].quote == answer.text
        broken = second.analysis.behavior.model_dump()
        broken['properties'][0]['approved_by'] = None
        with pytest.raises(ValidationError, match='подтверждения'):
            BehavioralModel.model_validate(broken)
        resumed = type(second).model_validate_json(second.model_dump_json())
        note = Source(id='next', session_id=source.session_id, text='Других изменений нет.')
        third = build_state([source, answer, note], DialogueDraft(
            analysis=updated, questions=[], resolutions=[], corrections=[],
        ), resumed, None, 5)
        assert third.property_approvals == second.property_approvals
    else:
        assert not second.analysis.behavior.properties
        assert second.questions[0].status == 'rejected'


class DraftModel(ScriptedModel):
    def __init__(self, outputs):
        super().__init__()
        self.outputs = iter(outputs)

    async def get_response(self, system_instructions, input, *args, **kwargs):
        self.calls.append(json.loads(input[0]['content']) if isinstance(input, list) else json.loads(input))
        text = next(self.outputs)
        return ModelResponse(output=[ResponseOutputMessage(
            id='draft', type='message', role='assistant', status='completed',
            content=[ResponseOutputText(type='output_text', text=text, annotations=[])],
        )], usage=Usage(), response_id='draft')


def test_sdk_validation_repair_is_bounded_and_never_returns_an_invalid_model(monkeypatch):
    case = order_case()
    source = Source.model_validate(case['source'])
    good = DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[])
    bad = good.model_dump()
    bad['analysis']['properties'][0]['predicate'] = {'kind': 'variable', 'name': 'missing'}
    invalid = json.dumps(bad, ensure_ascii=False)
    scripted = DraftModel([invalid, good.model_dump_json(), 'not JSON', 'not JSON'])

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr(dialogue, 'create_client', Client)
    monkeypatch.setattr(dialogue, 'create_agent', lambda client: Agent(name='analyst', model=scripted))

    async def scenario():
        state = await dialogue.generate_state({'sources': [source.model_dump()]}, [source], None, None, 5)
        assert state.status == 'ready'
        assert 'missing' in scripted.calls[1]['validation_feedback']['error']
        assert scripted.calls[1]['sources'] == scripted.calls[0]['sources']
        with pytest.raises(dialogue.GenerationError) as error:
            await dialogue.generate_state({'sources': [source.model_dump()]}, [source], None, None, 5)
        assert error.value.attempts == 2 and len(scripted.calls) == 4

    asyncio.run(scenario())


def test_version_events_and_explanation_are_bound_to_the_same_report(monkeypatch):
    model = BehavioralModel.model_validate_json((ROOT / 'docs/examples/order.json').read_text(encoding='utf-8'))
    configure_sdk(monkeypatch, ScriptedModel())
    events = []

    async def receive(event):
        events.append(event)

    outcome = asyncio.run(verification.verify_and_explain(model, FixtureChecker(), version_id='version-7', on_event=receive))
    assert [event.event for event in events] == ['tool_started', 'tool_finished']
    assert events[0].check_id == events[1].check_id
    assert all(event.version_id == 'version-7' for event in events)
    assert events[1].report == outcome.report
    assert outcome.report.version_id == outcome.request.version_id == 'version-7'
    rendered = verification.render_verification(outcome)
    assert 'Изменения:' in rendered and 'approved' in rendered and 'было' in rendered
    assert 'Требование ' in rendered and 'не гарантирует' in rendered
    forged = outcome.report.model_dump()
    forged['results'][0]['version_id'] = 'version-8'
    with pytest.raises(ValueError, match='другой модели'):
        verification.VerificationOutcome(request=outcome.request, report=forged, explanation=None)


def test_failed_adapter_emits_failure_without_an_explanation_or_retry(monkeypatch):
    model = BehavioralModel.model_validate_json((ROOT / 'docs/examples/order.json').read_text(encoding='utf-8'))
    configure_sdk(monkeypatch, ScriptedModel())
    events = []

    class Broken:
        async def check(self, request):
            raise RuntimeError('adapter bug')

    async def receive(event):
        events.append(event)

    with pytest.raises(UserError, match='adapter bug'):
        asyncio.run(verification.verify_and_explain(model, Broken(), on_event=receive))
    assert [event.event for event in events] == ['tool_started', 'tool_failed']
    assert events[-1].report is None and 'adapter bug' in events[-1].error


def test_command_adapter_uses_actual_process_input_and_preserves_test_provenance():
    model = BehavioralModel.model_validate_json((ROOT / 'docs/examples/order.json').read_text(encoding='utf-8'))
    request = VerificationRequest(model=model, property_ids=[p.id for p in model.properties], version_id='v-command')
    report = asyncio.run(FixtureChecker().check(request))
    script = 'import json,sys; request=json.load(sys.stdin); assert request["version_id"]=="v-command"; print(' + repr(report.model_dump_json()) + ')'
    result = asyncio.run(check_behavior(model, CommandChecker([sys.executable, '-c', script]), version_id=request.version_id))
    assert result.mode == 'test' and result.version_id == request.version_id
    missing = asyncio.run(check_behavior(model, CommandChecker(['nonexistent-proveryalka-checker'])))
    assert missing.results[0].status == 'ENGINE_ERROR' and not missing.results[0].conclusive
