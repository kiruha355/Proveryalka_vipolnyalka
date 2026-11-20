import json
import tarfile
import time
import pytest
from cryptography.fernet import Fernet
from proveryalka.auth.connections import ConnectionService
from proveryalka.sources.repositories.transport import SafeHTTPS
from test_ownership import users
from test_repositories import archive
from test_repositories_transport import https, Response

SECRET='fixture-only-private-access-token'
SHA='a'*40

@pytest.fixture
def private(users,monkeypatch):
    c=users
    c.app.state.connections.cipher=Fernet(Fernet.generate_key())
    calls=[]
    def get(self,url,deadline,max_bytes,authorization=None):
        calls.append((url,authorization))
        assert authorization=='Bearer '+SECRET
        if '/commits/' in url:return json.dumps({'sha':SHA,'id':SHA}).encode()
        return archive([('root/README.md',b'private project',tarfile.REGTYPE)]).data
    monkeypatch.setattr(SafeHTTPS,'get',get)
    return c,calls

@pytest.mark.parametrize('remote',['https://github.com/team/private','https://gitlab.com/group/subgroup/private'])
def test_private_import_revoke_history_and_two_users(private,remote):
    c,calls=private;c.switch('alice')
    result=c.post('/api/connections',json={'remote_url':remote,'token':SECRET,'expires_at':time.time()+3600})
    assert result.status_code==201,result.text
    connection=result.json();cid=connection['id'];assert SECRET not in result.text
    assert c.get('/api/connections').json()==[connection]
    assert c.post(f'/api/connections/{cid}/check').json()['accessible']
    session=c.post('/api/sessions',json={'title':'Private'},headers={'Idempotency-Key':'session'}).json()['id']
    url=f'/api/sessions/{session}/repositories'
    body={'remote_url':remote,'credential_ref':cid}
    result=c.post(url,json=body,headers={'Idempotency-Key':'import'})
    assert result.status_code==201,result.text
    snapshot=result.json();assert SECRET not in result.text
    if 'gitlab' in remote:
        assert any('/projects/group%2Fsubgroup%2Fprivate/repository/archive.tar.gz?sha='+SHA in u for u,_ in calls)
        assert '/-/blob/' in snapshot['files'][0]['provenance_url']
    with c.app.state.auth.store.transaction() as db:
        row=db.execute('SELECT secret FROM git_connections').fetchone()
        assert SECRET.encode() not in row[0]
    c.switch('bob')
    assert c.get('/api/connections').json()==[]
    assert c.post(f'/api/connections/{cid}/check').status_code==404
    assert c.delete(f'/api/connections/{cid}').status_code==404
    bob_session=c.post('/api/sessions',json={'title':'Bob'},headers={'Idempotency-Key':'session'}).json()['id']
    before=len(calls)
    assert c.post(f'/api/sessions/{bob_session}/repositories',json=body,headers={'Idempotency-Key':'attack'}).status_code==403
    assert len(calls)==before
    assert c.get(url+'/'+snapshot['id']).status_code==404
    assert c.post(url+'/'+snapshot['id']+'/analysis',json={}).status_code==404
    c.switch('alice')
    assert c.delete(f'/api/connections/{cid}').status_code==204
    assert c.get(url+'/'+snapshot['id']).json()==snapshot
    assert c.post(url,json=body,headers={'Idempotency-Key':'after-revoke'}).status_code==403
    assert len(calls)==before
    with c.app.state.auth.store.transaction() as db:
        assert db.execute('SELECT secret FROM git_connections').fetchone()[0] is None


def test_expiry_host_repo_scope_and_key_loss(private):
    c,calls=private;c.switch('alice')
    service=c.app.state.connections
    cid=c.post('/api/connections',json={'remote_url':'https://github.com/a/b','token':SECRET,'expires_at':time.time()+100}).json()['id']
    sid=c.post('/api/sessions',json={'title':'X'},headers={'Idempotency-Key':'session'}).json()['id']
    url=f'/api/sessions/{sid}/repositories'
    for remote in ('https://github.com/a/other','https://gitlab.com/a/b'):
        result=c.post(url,json={'remote_url':remote,'credential_ref':cid},headers={'Idempotency-Key':remote})
        assert result.status_code==403,result.text
    assert calls==[]
    service.clock=lambda:time.time()+200
    assert c.post(f'/api/connections/{cid}/check').json()['accessible'] is False
    assert c.get('/api/connections').json()[0]['state']=='expired'
    service.clock=time.time;service.cipher=Fernet(Fernet.generate_key())
    assert c.post(f'/api/connections/{cid}/check').json()['accessible'] is False
    service.cipher=None
    assert c.post('/api/connections',json={'remote_url':'https://github.com/a/b','token':SECRET,'expires_at':time.time()+100}).status_code==503
    assert calls==[]


def test_provider_revocation_and_redirect_redaction(private,monkeypatch):
    c,_=private;c.switch('alice')
    from proveryalka.services import ServiceError
    def denied(*args,**kwargs):raise ServiceError(403,'REPOSITORY_ACCESS_DENIED','Denied')
    monkeypatch.setattr(SafeHTTPS,'get',denied)
    cid=c.post('/api/connections',json={'remote_url':'https://github.com/a/b','token':SECRET,'expires_at':time.time()+100}).json()['id']
    result=c.post(f'/api/connections/{cid}/check')
    assert result.status_code==200 and not result.json()['accessible']
    assert SECRET not in result.text


def test_same_host_redirect_also_drops_token(https):
    http,calls,responses,_=https
    responses.extend([Response(302,{'Location':'https://api.github.com/unrelated'}),Response()])
    from proveryalka.sources.repositories.transport import Deadline
    http.get('https://api.github.com/repos/a/b',Deadline(1),100,'Bearer '+SECRET)
    assert 'Authorization' not in calls[1][3]
