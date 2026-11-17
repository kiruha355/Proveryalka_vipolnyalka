"""Explicit user/project-scoped MCP tokens. Raw token returned only at creation."""
import secrets
from fastapi import APIRouter, Request
from pydantic import Field
from ..contracts import Contract
from ..services import ServiceError
from .access import require_owner
from .router import COOKIE
from .service import digest, csrf_token
import hmac

class TokenCreate(Contract):
    model_ids: list[str] = Field(min_length=1,max_length=100)
    expires_in: int = Field(default=3600,ge=60,le=2592000)

def create_token_router(auth):
    router=APIRouter(prefix='/api/auth/mcp-tokens',tags=['authentication'])
    def user(request):
        token=request.cookies.get(COOKIE,'')
        result=auth.authenticate(token)
        if result['kind'] != 'cookie' or request.headers.get('origin') != auth.settings.origin or not hmac.compare_digest(request.headers.get('x-csrf-token',''),csrf_token(token)):
            raise ServiceError(403,'CSRF_INVALID','Invalid Origin or CSRF token')
        return result
    @router.post('',status_code=201)
    def create(body:TokenCreate,request:Request):
        owner=user(request)
        for model in body.model_ids:
            require_owner(auth.store,'model_id',model,owner)
        token=secrets.token_urlsafe(32); hashed=digest(token);expires=auth.clock()+body.expires_in
        with auth.store.transaction(write=True) as c:
            c.execute('INSERT INTO user_sessions VALUES (?,?,?,?,?)',(hashed,owner['id'],expires,auth.clock(),'mcp'))
            c.executemany('INSERT INTO mcp_grants VALUES (?,?)',[(hashed,m) for m in set(body.model_ids)])
        from fastapi.responses import JSONResponse
        return JSONResponse({'token':token,'token_id':hashed,'expires_at':expires,'model_ids':body.model_ids},status_code=201,headers={'Cache-Control':'no-store'})
    @router.delete('/{token_id}',status_code=204)
    def revoke(token_id:str,request:Request):
        owner=user(request)
        with auth.store.transaction(write=True) as c:
            c.execute("DELETE FROM user_sessions WHERE token_hash=? AND user_id=? AND kind='mcp'",(token_id,owner['id']))
    return router
