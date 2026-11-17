"""User-owned, encrypted, read-only repository credentials."""
import json
import os
import time
from uuid import uuid4
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter
from pydantic import Field, SecretStr
from ..contracts import Contract
from ..services import ServiceError
from .access import principal
from ..sources.repositories.policy import RepositoryHost, remote_parts
from ..sources.repositories.transport import GitHubArchiveTransport, Deadline

class ConnectionCreate(Contract):
    remote_url: str = Field(min_length=1,max_length=500)
    token: SecretStr = Field(min_length=10,max_length=4096)
    expires_at: float = Field(gt=0,allow_inf_nan=False)


def hosting(remote):
    # Only built-in public hosts; no user-controlled API URL or custom port.
    from urllib.parse import urlsplit
    host=urlsplit(remote).hostname
    if host=='github.com':return RepositoryHost()
    if host=='gitlab.com':return RepositoryHost(remote_host='gitlab.com',api_host='gitlab.com',archive_hosts=(),provider='gitlab')
    raise ServiceError(422,'REPOSITORY_URL_DENIED','Supported hosts: github.com, gitlab.com')

class ConnectionService:
    def __init__(self,store,key=None,clock=time.time):
        self.store,self.clock=store,clock
        key=key if key is not None else os.getenv('PROVERYALKA_CONNECTION_KEY','')
        self.cipher=Fernet(key.encode()) if key else None

    def owner(self):
        user=principal.get()
        if user is None:raise ServiceError(401,'AUTH_REQUIRED','Authentication required')
        return user['id']

    def public(self,row):
        state='revoked' if row['revoked'] else 'expired' if row['expires_at']<=self.clock() else 'active'
        return {k:row[k] for k in ('id','remote_url','created_at','expires_at')} | {'state':state,'access':'read','last_checked_at':row['last_checked_at'],'last_error':row['last_error']}

    def get(self,reference):
        with self.store.transaction() as c:
            row=c.execute('SELECT * FROM git_connections WHERE id=? AND owner_id=?',(reference,self.owner())).fetchone()
        if row is None:raise ServiceError(404,'NOT_FOUND','Connection not found')
        return row

    def create(self,body):
        if self.cipher is None:raise ServiceError(503,'CONNECTION_KEY_REQUIRED','Repository credential encryption is not configured')
        policy=hosting(body.remote_url)
        canonical,_,_=remote_parts(body.remote_url,policy)
        token=body.token.get_secret_value()
        if any(ord(ch)<33 or ord(ch)>126 for ch in token):
            raise ServiceError(422,'INVALID_CREDENTIAL','Token must be printable ASCII without whitespace')
        if body.expires_at<=self.clock():raise ServiceError(422,'CREDENTIAL_EXPIRED','Choose a future expiry')
        uid=self.owner();identifier='conn_'+uuid4().hex
        # Bind ciphertext to owner, connection and canonical repository to detect substitution.
        encrypted=self.cipher.encrypt(json.dumps({'token':token,'id':identifier,'owner':uid,'remote':canonical}).encode())
        with self.store.transaction(write=True) as c:
            c.execute('INSERT INTO git_connections VALUES (?,?,?,?,?,?,?,?,?,?)',
                      (identifier,uid,canonical,encrypted,self.clock(),body.expires_at,0,None,None,'read'))
        return self.public(self.get(identifier))

    def list(self):
        with self.store.transaction() as c:
            return [self.public(row) for row in c.execute('SELECT * FROM git_connections WHERE owner_id=? ORDER BY created_at,id',(self.owner(),))]

    def revoke(self,reference):
        self.get(reference)
        with self.store.transaction(write=True) as c:
            c.execute('UPDATE git_connections SET revoked=1,secret=NULL WHERE id=? AND owner_id=?',(reference,self.owner()))

    def authorization(self,reference,remote_url):
        row=self.get(reference)
        if row['revoked'] or row['expires_at']<=self.clock():
            raise ServiceError(403,'CREDENTIAL_INACTIVE','Repository connection is revoked or expired')
        canonical,_,_=remote_parts(remote_url,hosting(remote_url))
        if row['remote_url']!=canonical:
            raise ServiceError(403,'CREDENTIAL_SCOPE_DENIED','Connection does not permit this repository')
        if self.cipher is None:raise ServiceError(503,'CONNECTION_KEY_REQUIRED','Repository credential encryption is not configured')
        try:
            data=json.loads(self.cipher.decrypt(row['secret']))
            if (data['id'],data['owner'],data['remote'])!=(reference,self.owner(),canonical):raise ValueError()
            return 'Bearer '+data['token']
        except (InvalidToken,ValueError,KeyError,TypeError):
            raise ServiceError(503,'CREDENTIAL_UNAVAILABLE','Credential cannot be decrypted') from None

    def check(self,reference):
        row=self.get(reference)
        transport=GitHubArchiveTransport(hosting(row['remote_url']),self)
        code=None
        try:
            transport.resolve_commit(row['remote_url'],'HEAD',reference,Deadline(15))
        except ServiceError as error:
            code=error.code
        with self.store.transaction(write=True) as c:
            c.execute('UPDATE git_connections SET last_checked_at=?,last_error=? WHERE id=? AND owner_id=?',(self.clock(),code,reference,self.owner()))
        return {'accessible':code is None,'connection':self.public(self.get(reference))}


def create_connections_router(service):
    router=APIRouter(prefix='/api/connections',tags=['repository connections'])
    @router.post('',status_code=201)
    def create(body:ConnectionCreate):return service.create(body)
    @router.get('')
    def listing():return service.list()
    @router.post('/{connection_id}/check')
    def check(connection_id:str):return service.check(connection_id)
    @router.delete('/{connection_id}',status_code=204)
    def revoke(connection_id:str):service.revoke(connection_id)
    return router
