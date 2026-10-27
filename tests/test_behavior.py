import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from agents import AgentOutputSchema
from pydantic import ValidationError
from fastapi.testclient import TestClient

from proveryalka.agent import dialogue
from proveryalka.agent.analysis import ExtractionDraft, build_analysis
from proveryalka.agent.clarification import DialogueDraft, build_state
from proveryalka.behavior import BehavioralModel, evaluate, initial_state, step
from proveryalka.contracts import Source
from proveryalka.api.app import create_app
from proveryalka.services import UnavailableBackend
from proveryalka.storage.session import StoredSession
from proveryalka.storage.sqlite import SQLiteStore


CASES = json.loads((Path(__file__).parent / 'fixtures/formal_cases.json').read_text(encoding='utf-8'))


@pytest.fixture
def case():
    return copy.deepcopy(CASES[0])


def analyze(case):
    return build_analysis(Source.model_validate(case['source']), ExtractionDraft.model_validate(case['draft']))


def test_described_bad_process_is_preserved_and_evaluable(case):
    analysis = analyze(case)
    model = analysis.behavior
    assert model is not None and not analysis.model_issues
    state = initial_state(model)
    for action in ('Approve', 'Cancel', 'Execute'):
        state = step(model, state, action)
    assert state == {'status': 'Executed', 'approved': True, 'cancelled': True}
    assert evaluate(model.properties[0].predicate, state) is True
    assert model.transitions[1].requirement_ids == [analysis.requirements[2].id]
    assert BehavioralModel.model_validate_json(model.model_dump_json()) == model


@pytest.mark.parametrize('previous_links', [False, True])
def test_explicit_correction_updates_ast_and_preserves_other_requirements(case, previous_links):
    source = Source.model_validate(case['source'])
    first = build_state([source], DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[]), None, None, 5)
    message = 'Cancel доступен в любом состоянии и устанавливает status=Cancelled, cancelled=true, approved=false.'
    answer = Source(id='answer1', session_id=source.session_id, text=message)
    updated = copy.deepcopy(case['draft'])
    for item, previous in zip(updated['requirements'], first.analysis.requirements):
        item['previous_id'] = previous.id
    updated['requirements'][2].update(text=message, quote=message, source_id=answer.id)
    updated['events'][1]['quote'] = message
    updated['events'][1]['effects'].append({'variable': 'approved', 'value': {'kind': 'literal', 'value': False}})
    if previous_links:
        for section in ('variables', 'events', 'properties'):
            for item in updated[section]:
                item['requirement_ids'] = [first.analysis.requirements[int(ref[1:]) - 1].id for ref in item['requirement_ids']]
    second = build_state([source, answer], DialogueDraft(
        analysis=updated, questions=[], resolutions=[], corrections=[{
            'requirement_id': first.analysis.requirements[2].id,
            'reason': 'Пользователь изменил эффект отмены', 'quote': message,
        }],
    ), first, None, 5)
    assert second.status == 'ready'
    assert first.analysis.behavior.transitions[1].effects != second.analysis.behavior.transitions[1].effects
    assert second.analysis.behavior.transitions[1].requirement_ids == [second.analysis.requirements[2].id]
    assert second.analysis.requirements[0] == first.analysis.requirements[0]
    model = second.analysis.behavior
    state = step(model, step(model, initial_state(model), 'Approve'), 'Cancel')
    assert state['approved'] is False
    with pytest.raises(ValueError, match='недоступен'):
        step(model, state, 'Execute')


def test_counter_guards_and_bounds():
    model = analyze(copy.deepcopy(CASES[1])).behavior
    assert step(model, initial_state(model), 'Take') == {'free': 4}
    with pytest.raises(ValueError, match='недоступен'):
        step(model, {'free': 0}, 'Take')
    with pytest.raises(ValueError, match='недоступен'):
        step(model, {'free': 5}, 'Return')
    broken = model.model_dump()
    broken['transitions'][1]['guard'] = {'kind': 'literal', 'value': True}
    with pytest.raises(ValueError, match='вне области'):
        step(BehavioralModel.model_validate(broken), {'free': 5}, 'Return')


def test_assignments_are_simultaneous(case):
    model = analyze(case).behavior.model_dump()
    model['transitions'][0]['effects'] = [
        {'variable': 'approved', 'value': {'kind': 'variable', 'name': 'cancelled'}},
        {'variable': 'cancelled', 'value': {'kind': 'variable', 'name': 'approved'}},
    ]
    state = {'status': 'Created', 'approved': True, 'cancelled': False}
    result = step(BehavioralModel.model_validate(model), state, 'Approve')
    assert result == {'status': 'Created', 'approved': False, 'cancelled': True}
    assert state['approved'] is True


@pytest.mark.parametrize('change', ['unknown_variable', 'bad_guard', 'bad_assignment', 'duplicate_assignment', 'bad_enum', 'bad_initial', 'unknown_requirement', 'duplicate_variable', 'bad_source_range', 'float_literal', 'raw_code', 'unknown_operator'])
def test_invalid_models_are_rejected(case, change):
    model = analyze(case).behavior.model_dump()
    transition = model['transitions'][0]
    if change == 'unknown_variable':
        transition['guard'] = {'kind': 'variable', 'name': 'not_declared'}
    elif change == 'bad_guard':
        transition['guard'] = {'kind': 'literal', 'value': 1}
    elif change == 'bad_assignment':
        transition['effects'][1]['value'] = {'kind': 'literal', 'value': 1}
    elif change == 'duplicate_assignment':
        transition['effects'].append(copy.deepcopy(transition['effects'][0]))
    elif change == 'bad_enum':
        transition['effects'][0]['value'] = {'kind': 'literal', 'value': 'UnknownStatus'}
    elif change == 'bad_initial':
        model['variables'][1]['initial_value'] = 0
    elif change == 'unknown_requirement':
        transition['requirement_ids'] = ['missing']
    elif change == 'duplicate_variable':
        model['variables'].append(copy.deepcopy(model['variables'][0]))
    elif change == 'bad_source_range':
        model['requirements'][-1]['source_refs'][0]['end'] += 100
    elif change == 'float_literal':
        transition['effects'][1]['value'] = {'kind': 'literal', 'value': 0.5}
    elif change == 'raw_code':
        transition['guard'] = '__import__("os").system("invalid")'
    else:
        transition['guard'] = {'kind': 'binary', 'op': 'eval', 'left': {'kind': 'literal', 'value': True}, 'right': {'kind': 'literal', 'value': True}}
    with pytest.raises(ValidationError):
        BehavioralModel.model_validate(model)


def test_unknown_information_never_becomes_a_default_domain_or_true_guard(case):
    case['draft']['variables'][0]['domain'] = None
    case['draft']['events'][0]['guard'] = None
    analysis = analyze(case)
    assert analysis.behavior is None
    assert {issue.path for issue in analysis.model_issues} == {'variables.status.domain', 'events.Approve.guard'}
    result = build_state([Source.model_validate(case['source'])], DialogueDraft(
        analysis=case['draft'], questions=[], resolutions=[], corrections=[],
    ), None, None, 5)
    assert result.status == 'model_incomplete'


def test_open_questions_block_publication_of_an_otherwise_complete_model(case):
    result = build_state([Source.model_validate(case['source'])], DialogueDraft(
        analysis=case['draft'], questions=[{
            'text': 'Нужно ли изменять правило?', 'reason': 'Пользователь ещё уточняет правило',
            'kind': 'missing', 'assumption': None,
        }], resolutions=[], corrections=[],
    ), None, None, 5)
    assert result.analysis.behavior is None and result.status == 'needs_clarification'
    assert result.analysis.missing_information == ['Нужно ли изменять правило?']


def test_one_llm_call_returns_analysis_and_strict_model(case, monkeypatch, tmp_path):
    calls = []

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    async def run(agent, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(final_output=DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[]))

    monkeypatch.setattr(dialogue, 'create_client', Client)
    monkeypatch.setattr(dialogue, 'create_agent', lambda client: SimpleNamespace(clone=lambda **kwargs: object()))
    monkeypatch.setattr(dialogue.Runner, 'run', run)
    store = SQLiteStore(tmp_path / 'dialogue.sqlite3')
    store.initialize()
    session_id = store.create_session({'title': 'Один вызов'}, 'session')['id']
    source = Source.model_validate({**case['source'], 'session_id': session_id})

    async def scenario():
        session = StoredSession(store, session_id)
        state = await dialogue.start_dialogue(source, session)
        assert state.status == 'ready' and state.analysis.behavior is not None
        assert len(calls) == 1 and calls[0]['max_turns'] == 1
        assert await dialogue.load_dialogue(StoredSession(SQLiteStore(store.path), session_id)) == state
        assert len(await session.get_items()) == 2

    asyncio.run(scenario())


def test_recursive_schema_is_strict_and_has_no_free_text_guards():
    schema = AgentOutputSchema(DialogueDraft)
    assert schema.is_strict_json_schema()
    defs = schema.json_schema()['$defs']
    assert 'missing_information' not in defs['ExtractionDraft']['properties']
    guard = defs['Event']['properties']['guard']
    assert {'type': 'string'} not in guard['anyOf']
    assert {item['$ref'] for item in guard['anyOf'] if '$ref' in item} == {
        '#/$defs/LiteralExpression', '#/$defs/VariableExpression',
        '#/$defs/UnaryExpression', '#/$defs/BinaryExpression',
    }


def test_http_api_uses_the_same_contract_before_backend_dispatch(case):
    client = TestClient(create_app(backend=UnavailableBackend()))
    model = analyze(case).behavior.model_dump(mode='json')
    headers = {'Idempotency-Key': 'model1'}
    response = client.post('/api/models/model1/versions', json={'spec': model}, headers=headers)
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'COMPONENT_UNAVAILABLE'
    model['transitions'][0]['guard'] = {'kind': 'literal', 'value': 1}
    response = client.post('/api/models/model1/versions', json={'spec': model}, headers=headers)
    assert response.status_code == 422
    schema = client.get('/openapi.json').json()
    schemas = schema['components']['schemas']
    ref = schemas['VersionCreate']['properties']['spec']['$ref'].rsplit('/', 1)[-1]
    assert schemas[ref]['title'] == 'BehavioralModel'


@pytest.mark.parametrize('domain', [
    {'kind': 'integer', 'minimum': 5, 'maximum': 0},
    {'kind': 'integer', 'minimum': False, 'maximum': 5},
    {'kind': 'enum', 'values': ['same', 'same']},
    {'kind': 'enum', 'values': []},
])
def test_domains_are_finite_and_strict(case, domain):
    model = analyze(case).behavior.model_dump()
    model['variables'][0]['domain'] = domain
    with pytest.raises(ValidationError):
        BehavioralModel.model_validate(model)


def test_excessive_ast_depth_is_rejected(case):
    model = analyze(case).behavior.model_dump()
    expression = {'kind': 'literal', 'value': True}
    for _ in range(34):
        expression = {'kind': 'unary', 'op': 'not', 'operand': expression}
    model['transitions'][0]['guard'] = expression
    with pytest.raises(ValidationError, match='Глубина'):
        BehavioralModel.model_validate(model)


def test_legacy_history_is_not_silently_converted_or_deleted():
    class LegacySession:
        async def get_items(self):
            return [{'role': 'assistant', 'content': '{"analyst_dialogue": {"analysis": {}}}'}]

    with pytest.raises(ValueError, match='прежний текстовый формат'):
        asyncio.run(dialogue.load_dialogue(LegacySession()))


@pytest.mark.parametrize('change', ['guard', 'remove_transition'])
def test_model_cannot_be_silently_repaired_or_truncated_between_turns(case, change):
    source = Source.model_validate(case['source'])
    first = build_state([source], DialogueDraft(analysis=case['draft'], questions=[], resolutions=[], corrections=[]), None, None, 5)
    updated = copy.deepcopy(case['draft'])
    for requirement, old in zip(updated['requirements'], first.analysis.requirements):
        requirement['previous_id'] = old.id
    if change == 'guard':
        updated['events'][2]['guard'] = {
            'kind': 'binary', 'op': 'and', 'left': updated['events'][2]['guard'],
            'right': {'kind': 'unary', 'op': 'not', 'operand': {'kind': 'variable', 'name': 'cancelled'}},
        }
    else:
        updated['events'].pop(0)
    answer = Source(id='answer1', session_id=source.session_id, text='Других изменений нет.')
    with pytest.raises(ValueError, match='без изменения требования'):
        build_state([source, answer], DialogueDraft(analysis=updated, questions=[], resolutions=[], corrections=[]), first, None, 5)
