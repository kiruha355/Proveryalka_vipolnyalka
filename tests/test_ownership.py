import json
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.auth.config import AuthSettings
from proveryalka.auth.access import principal, assign_legacy
from proveryalka.mcp.policy import LocalAccessPolicy
from test_auth import register, login
from test_codegen_api import add_version, FakeSandbox
from test_check_api import FakeChecker

@pytest.fixture
def users(tmp_path):
    app=create_app(Settings(database_path=tmp_path/'db',artifacts_path=tmp_path/'artifacts'),
                   auth_settings=AuthSettings(enabled=True,origin='http://localhost'),
                   checker=FakeChecker(),codegen_sandbox=FakeSandbox(),
                   mcp_policy=LocalAccessPolicy())
    with TestClient(app,base_url='http://localhost',client=('127.0.0.1',1234)) as c:
        identities={}
        for name in ('alice','bob'):
            c.headers['Origin']='http://localhost'
            result=register(c,name+'@example.com');assert result.status_code==201,result.text
            uid=result.json()['user']['id']
            result=login(c,name+'@example.com');assert result.status_code==200,result.text
            identities[name]={'id':uid,'cookie':c.cookies.get('pv_session'),'csrf':result.json()['csrf_token']}
        def switch(name):
            c.cookies.clear();c.cookies.set('pv_session',identities[name]['cookie'])
            c.headers['X-CSRF-Token']=identities[name]['csrf']
            return identities[name]
        c.switch=switch
        yield c


def test_two_users_all_resource_surfaces(users):
    c=users;alice=c.switch('alice');store=c.app.state.auth.store
    ctx=principal.set(alice)
    try:
        session,model,version=add_version(store)
        generation=c.app.state.codegen.generate(model['id'],1,{'allow_unverified':True},'generation')
        run=store.create_check(model['id'],1,{'property_ids':None,'limits':None},'check')
        # Persist a queued test run via the regular service; fake executor handles it.
    finally:principal.reset(ctx)
    sid,mid,gid,rid=session['id'],model['id'],generation['generation_id'],run['run_id']
    test=c.post(f'/api/generations/{gid}/test-runs',json={'timeout_seconds':5},headers={'Idempotency-Key':'test'})
    assert test.status_code==202,test.text
    tid=test.json()['test_run_id']
    assert c.get(f'/api/generations/{gid}/archive').status_code==200
    assert c.get('/api/sessions').json()[0]['id']==sid
    c.switch('bob')
    assert c.get('/api/sessions').json()==[]
    paths=[f'/api/sessions/{sid}',f'/api/sessions/{sid}/sources',f'/api/sessions/{sid}/repositories',
           f'/api/sessions/{sid}/images',f'/api/sessions/{sid}/dialogue',f'/api/sessions/{sid}/agent-runs',
           f'/api/models/{mid}/versions',f'/api/models/{mid}/versions/1',f'/api/runs/{rid}',f'/api/runs/{rid}/events',
           f'/api/checks/{rid}',f'/api/checks/{rid}/artifacts/spec.tla',f'/api/generations/{gid}',
           f'/api/generations/{gid}/files',f'/api/generations/{gid}/files/README.md',f'/api/generations/{gid}/archive',
           f'/api/test-runs/{tid}',f'/api/test-runs/{tid}/log']
    for path in paths:
        result=c.get(path)
        assert result.status_code in (404,405),(path,result.text)
        assert 'order_fixed' not in result.text
    for path in (f'/api/runs/{rid}/cancel',f'/api/test-runs/{tid}/cancel',f'/api/generations/{gid}/test-runs',
                 f'/api/sessions/{sid}/pending/retry',f'/api/sessions/{sid}/repositories',
                 f'/api/models/{mid}/versions/1/generations',f'/api/checks/{rid}/explanation'):
        assert c.post(path,json={},headers={'Idempotency-Key':'attack'}).status_code==404,path
    c.cookies.clear()
    assert c.get(f'/api/runs/{rid}/events').status_code==401


def test_idempotency_csrf_and_explicit_legacy_owner(users):
    c=users;store=c.app.state.auth.store
    legacy=store.create_session({'title':'legacy'},'legacy')
    first=[]
    for name in ('alice','bob'):
        c.switch(name)
        result=c.post('/api/sessions',json={'title':'mine'},headers={'Idempotency-Key':'same'})
        assert result.status_code==201,result.text
        first.append(result.json()['id'])
        assert len(c.get('/api/sessions').json())==1
        assert c.get('/api/sessions/'+legacy['id']).status_code==404
    assert first[0]!=first[1]
    c.headers.pop('X-CSRF-Token')
    assert c.post('/api/sessions',json={'title':'blocked'},headers={'Idempotency-Key':'missing-csrf'}).status_code==403
    assert assign_legacy(store,'alice@example.com')==1
    assert assign_legacy(store,'bob@example.com')==0
    c.switch('alice');assert c.get('/api/sessions/'+legacy['id']).status_code==200
    c.switch('bob');assert c.get('/api/sessions/'+legacy['id']).status_code==404


def decode(result):
    if result.headers.get('content-type','').startswith('text/event-stream'):
        return [json.loads(line[6:]) for line in result.text.splitlines() if line.startswith('data: ')][-1]
    return result.json()


def test_user_mcp_project_grants_and_revocation(users):
    c=users;alice=c.switch('alice');store=c.app.state.auth.store
    ctx=principal.set(alice)
    try:
        _,model,_=add_version(store)
        _,second,_=add_version(store,'order_bug')
    finally:principal.reset(ctx)
    result=c.post('/api/auth/mcp-tokens',json={'model_ids':[model['id']]})
    assert result.status_code==201,result.text
    credential=result.json()
    c.switch('bob')
    assert c.post('/api/auth/mcp-tokens',json={'model_ids':[model['id']]}).status_code==404
    headers={'Authorization':'Bearer '+credential['token'],'Accept':'application/json, text/event-stream',
             'MCP-Protocol-Version':'2025-11-25'}
    # MCP grants are independent of the current browser cookie and local model allowlist.
    def call(mid):
        c.headers.pop('Origin',None)
        result=c.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':1,'method':'tools/call',
             'params':{'name':'get_model','arguments':{'model':{'model_id':mid,'version_number':1}}}})
        assert result.status_code==200,result.text
        return decode(result)['result']['structuredContent']
    assert call(model['id'])['status']=='completed'
    denied=call(second['id']);assert denied['error']['code']=='ACCESS_DENIED'
    c.headers['Origin']='http://localhost';c.switch('alice')
    assert c.delete('/api/auth/mcp-tokens/'+credential['token_id']).status_code==204
    c.headers.pop('Origin',None)
    assert c.post('/mcp',json={},headers=headers).status_code==401
