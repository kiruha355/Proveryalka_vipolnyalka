from dataclasses import replace
from fastapi.testclient import TestClient
import pytest
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.auth.config import AuthSettings
from proveryalka.auth.service import AuthService,digest,password_matches
from proveryalka.storage.sqlite import SQLiteStore
from proveryalka.services import ServiceError

PASSWORD='Correct horse battery 123!'

@pytest.fixture
def client(tmp_path):
    cfg=Settings(database_path=tmp_path/'db',artifacts_path=tmp_path/'artifacts')
    deliveries=[]
    app=create_app(cfg,auth_settings=AuthSettings(enabled=True,origin='http://testserver'),auth_delivery=lambda email,token:deliveries.append((email,token)))
    with TestClient(app) as c:
        c.headers['Origin']='http://testserver'
        c.deliveries=deliveries
        yield c


def register(c,email='alice@example.com'):
    return c.post('/api/auth/register',json={'email':email,'password':PASSWORD})


def login(c,email='alice@example.com',password=PASSWORD):
    result=c.post('/api/auth/login',json={'email':email,'password':password})
    if result.status_code==200:c.headers['X-CSRF-Token']=result.json()['csrf_token']
    return result


def test_registration_login_expiry_logout(client):
    assert register(client).status_code==201
    assert register(client,'ALICE@example.com').status_code==409
    assert login(client,password='wrong password').status_code==401
    result=login(client)
    assert result.status_code==200
    assert 'httponly' in result.headers['set-cookie'].lower()
    assert 'samesite=strict' in result.headers['set-cookie'].lower()
    assert client.get('/api/auth/me').json()['user']['email']=='alice@example.com'
    assert client.post('/api/auth/logout').status_code==204
    assert client.get('/api/auth/me').status_code==401
    login(client)
    client.app.state.auth.clock=lambda:10**12
    assert client.get('/api/auth/me').status_code==401


def test_csrf_and_password_change(client):
    register(client);login(client)
    client.headers.pop('X-CSRF-Token')
    assert client.post('/api/auth/logout').status_code==403
    csrf=client.get('/api/auth/me').json()['csrf_token'];client.headers['X-CSRF-Token']=csrf
    client.headers['Origin']='https://evil.example'
    assert client.post('/api/auth/password',json={'current_password':PASSWORD,'new_password':PASSWORD+'new'}).status_code==403
    client.headers['Origin']='http://testserver'
    assert client.post('/api/auth/password',json={'current_password':PASSWORD,'new_password':PASSWORD+'new'}).status_code==204
    assert client.get('/api/auth/me').status_code==401
    assert login(client).status_code==401
    assert login(client,password=PASSWORD+'new').status_code==200
    assert client.delete('/api/auth/sessions').status_code==204


def test_reset_is_one_time_and_revokes_sessions(client):
    register(client);login(client)
    known=client.post('/api/auth/password/reset-request',json={'email':'alice@example.com'})
    unknown=client.post('/api/auth/password/reset-request',json={'email':'unknown@example.com'})
    assert known.status_code==unknown.status_code==202 and known.json()==unknown.json()
    token=client.deliveries[0][1]
    assert token not in known.text
    response=client.post('/api/auth/password/reset',json={'token':token,'password':PASSWORD+'new'})
    assert response.status_code==204
    assert client.get('/api/auth/me').status_code==401
    assert client.post('/api/auth/password/reset',json={'token':token,'password':PASSWORD}).status_code==400
    assert login(client,password=PASSWORD+'new').status_code==200


def test_expired_reset_and_safe_errors(client):
    register(client)
    client.post('/api/auth/password/reset-request',json={'email':'alice@example.com'})
    token=client.deliveries[0][1];client.app.state.auth.clock=lambda:10**12
    assert client.post('/api/auth/password/reset',json={'token':token,'password':PASSWORD}).status_code==400
    response=client.post('/api/auth/register',json={'email':'alice@example.com','password':'SECRET'})
    assert response.status_code==422 and 'SECRET' not in response.text


def test_rate_limit_and_storage_has_only_hashes(client):
    register(client);login(client)
    for _ in range(12):response=login(client,password='wrong password')
    assert response.status_code==429
    with client.app.state.auth.store.transaction() as c:
        row=c.execute('SELECT password_hash FROM users').fetchone()
        assert PASSWORD not in row[0] and password_matches(PASSWORD,row[0])
        token=client.cookies.get('pv_session')
        assert c.execute('SELECT token_hash FROM user_sessions').fetchone()[0]==digest(token)


def test_secure_cookie_for_https(tmp_path):
    app=create_app(Settings(database_path=tmp_path/'db'),auth_settings=AuthSettings(enabled=True,origin='https://example.com'),auth_delivery=lambda *a:None)
    with TestClient(app,base_url='https://example.com') as c:
        c.headers['Origin']='https://example.com'
        register(c)
        assert 'secure' in login(c).headers['set-cookie'].lower()
