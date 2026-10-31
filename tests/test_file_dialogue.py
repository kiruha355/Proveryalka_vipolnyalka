import asyncio
import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from proveryalka.api import file_dialogue
from proveryalka.agent.errors import AgentError
from test_codegen_api import build, add_version, complete_check
from test_check_api import wait_run

@pytest.fixture
def world(tmp_path, monkeypatch):
    app, service=build(tmp_path)
    calls=[]
    async def explain(payload): calls.append(payload);return "В файле app/rules.py условие перехода проверяется до изменения состояния."
    monkeypatch.setattr(file_dialogue,"explain_file",explain)
    with TestClient(app) as client:
        store=app.state.backend.store
        session,model,version=add_version(store)
        complete_check(store,model['id'],1,{p['id']:'PROPERTY_HOLDS' for p in version['spec']['properties']})
        generation=service.generate(model['id'],1,{'target':'python-fastapi','allow_unverified':False},'generation')
        entry=next(f for f in generation['files'] if f['path']=='app/rules.py')
        ref={'generation_id':generation['generation_id'],'version_id':version['id'],'path':entry['path'],'sha256':entry['sha256']}
        yield client,store,session,model,version,generation,ref,calls

def send(client,sid,ref,key='question'):
    return client.post(f'/api/sessions/{sid}/messages',json={'text':'Объясни условие в этом файле. Ничего не меняй.','file_context':ref},headers={'Idempotency-Key':key})

def test_exact_old_file_context_is_saved_and_never_becomes_requirements(world):
    client,store,session,model,version,generation,ref,calls=world
    before=store.get_session(session['id']);store.create_version(model['id'],{'spec':version['spec']},'newer')
    response=send(client,session['id'],ref);assert response.status_code==202,response.text
    run=response.json();assert wait_run(client,run['run_id'])['state']=='completed'
    assert send(client,session['id'],ref).json()['run_id']==run['run_id'] and len(calls)==1
    payload=calls[0];assert payload['selected_file']['version_id']==version['id']
    assert payload['selected_file']['generation_id']==generation['generation_id']
    assert hashlib.sha256(payload['untrusted_file']['content'].encode()).hexdigest()==ref['sha256']
    assert payload['selected_verification']['state']=='holds' and 'latest' not in payload
    view=client.get(f"/api/sessions/{session['id']}/dialogue").json()
    assert view['status']=='not_started' and view['model'] is None and view['pending'] is None
    assert [e['kind'] for e in view['entries']]==['user','assistant']
    assert all(e['file_context']['version_id']==version['id'] for e in view['entries'])
    assert 'app/rules.py' in view['entries'][1]['text']
    assert store.get_session(session['id'])['sources']==before['sources']
    assert len(store.list_versions(model['id']))==2
    assert client.get(f"/api/sessions/{session['id']}/dialogue").json()==view

@pytest.mark.parametrize('field,value,code',[('path','../../etc/passwd','INVALID_FILE_PATH'),('path','missing.py','FILE_NOT_FOUND'),('version_id','wrong','FILE_VERSION_MISMATCH'),('sha256','0'*64,'FILE_HASH_MISMATCH')])
def test_invalid_context_is_rejected_before_provider(world,field,value,code):
    client,store,session,model,version,generation,ref,calls=world
    result=send(client,session['id'],{**ref,field:value});assert result.json()['error']['code']==code,result.text;assert calls==[]
    other=store.create_session({'title':'other'},'other')
    assert send(client,other['id'],ref,'other').status_code==404

def test_integrity_and_size_limits_are_server_side(world):
    client,store,session,model,version,generation,ref,calls=world
    with store.transaction(write=True) as c:c.execute('UPDATE codegen_files SET size=? WHERE generation_id=? AND path=?',(65537,ref['generation_id'],ref['path']))
    assert send(client,session['id'],ref).json()['error']['code']=='FILE_CONTEXT_TOO_LARGE'
    with store.transaction(write=True) as c:c.execute('UPDATE codegen_files SET size=1,content=? WHERE generation_id=? AND path=?',(b'x',ref['generation_id'],ref['path']))
    assert send(client,session['id'],ref).json()['error']['code']=='INTEGRITY_MISMATCH';assert calls==[]

def test_provider_failure_retry_and_discard_keep_single_pending_turn(world,monkeypatch):
    client,store,session,model,version,generation,ref,calls=world
    async def fail(payload):raise AgentError('PROVIDER_TIMEOUT','Timeout')
    monkeypatch.setattr(file_dialogue,'explain_file',fail)
    run=send(client,session['id'],ref).json();assert wait_run(client,run['run_id'])['state']=='failed'
    url=f"/api/sessions/{session['id']}"
    pending=client.get(url+'/dialogue').json();assert pending['pending']['file_context']['path']==ref['path']
    assert send(client,session['id'],ref,'blocked').json()['error']['code']=='PENDING_MESSAGE'
    async def ok(payload):return 'Пояснение сохранённого файла'
    monkeypatch.setattr(file_dialogue,'explain_file',ok)
    retry=client.post(url+'/pending/retry',headers={'Idempotency-Key':'retry'}).json();assert wait_run(client,retry['run_id'])['state']=='completed'
    view=client.get(url+'/dialogue').json();assert len(view['entries'])==2 and view['pending'] is None
    assert view['entries'][0]['id']==pending['entries'][0]['id']
    monkeypatch.setattr(file_dialogue,'explain_file',fail)
    run=send(client,session['id'],ref,'next').json();assert wait_run(client,run['run_id'])['state']=='failed'
    discarded=client.post(url+'/pending/discard').json();assert discarded['pending'] is None and discarded['entries'][-1]['status']=='discarded'

def test_cancel_file_question_releases_chat_and_preserves_discarded_entry(world,monkeypatch):
    import threading
    client,store,session,model,version,generation,ref,calls=world
    started=threading.Event()
    async def blocked(payload):
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(file_dialogue,'explain_file',blocked)
    first=send(client,session['id'],ref).json();assert started.wait(2)
    client.post(f"/api/runs/{first['run_id']}/cancel")
    assert wait_run(client,first['run_id'])['state']=='cancelled'
    url=f"/api/sessions/{session['id']}/dialogue"
    assert client.get(url).json()['pending'] is None
    started.clear();second=send(client,session['id'],ref,'second').json();assert started.wait(2)
    view=client.get(url).json();assert [e['status'] for e in view['entries']]==['discarded','pending']
    client.post(f"/api/runs/{second['run_id']}/cancel")
    assert wait_run(client,second['run_id'])['state']=='cancelled'
