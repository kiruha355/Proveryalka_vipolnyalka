import hmac
from anyio import CancelScope
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import JSONResponse
from ..services import ServiceError
from .access import principal, require_owner, RESOURCES
from .router import COOKIE
from .service import csrf_token, digest

class OwnershipMiddleware:
    def __init__(self, app, auth):
        self.app, self.auth = app, auth

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path = scope['path']
        if not (path.startswith('/api/') or path.rstrip('/') == '/mcp') or path.startswith('/api/auth/'):
            return await self.app(scope, receive, send)
        request = Request(scope)
        context = None
        try:
            is_mcp = path.rstrip('/') == '/mcp'
            if is_mcp:
                scheme, _, token = request.headers.get('authorization','').partition(' ')
                if scheme.lower() != 'bearer':
                    raise ServiceError(401,'AUTH_REQUIRED','MCP bearer token required')
            else:
                token = request.cookies.get(COOKIE,'')
            user = self.auth.authenticate(token)
            if user['kind'] != ('mcp' if is_mcp else 'cookie'):
                raise ServiceError(401,'AUTH_REQUIRED','Wrong credential type')
            if not is_mcp and scope['method'] not in ('GET','HEAD','OPTIONS'):
                if request.headers.get('origin') != self.auth.settings.origin or not hmac.compare_digest(request.headers.get('x-csrf-token',''),csrf_token(token)):
                    raise ServiceError(403,'CSRF_INVALID','Invalid Origin or CSRF token')
            if is_mcp and request.headers.get('origin') not in (None,self.auth.settings.origin):
                raise ServiceError(403,'CSRF_INVALID','Invalid Origin')
            user['token_hash'] = digest(token)
            context = principal.set(user)
        except ServiceError as error:
            if context is not None:
                principal.reset(context)
            return await JSONResponse({'error':{'code':error.code,'message':error.message,'details':[]}}, status_code=error.status)(scope,receive,send)
        try:
            streaming = False
            with CancelScope() as connection:
                async def guarded_send(message):
                    nonlocal streaming
                    if message['type'] == 'http.response.start':
                        headers = MutableHeaders(scope=message)
                        headers['Cache-Control'] = 'no-store'
                        streaming = headers.get('content-type', '').startswith('text/event-stream')
                    if message['type'] == 'http.response.body' and streaming and message.get('body'):
                        try:
                            self.auth.authenticate(token)
                        except ServiceError:
                            await send({'type': 'http.response.body', 'body': b'', 'more_body': False})
                            connection.cancel()
                            return
                    await send(message)
                await self.app(scope,receive,guarded_send)
        finally:
            principal.reset(context)


async def authorize_resource(request: Request):
    if not request.url.path.startswith('/api/') or request.url.path.startswith('/api/auth/'):
        return
    auth=request.app.state.auth
    checked=False
    for kind,value in request.path_params.items():
        if kind in RESOURCES:
            require_owner(auth.store,'image_id' if kind == 'source_id' and '/images/' in request.url.path else kind,value)
            checked=True
    if not checked and request.url.path not in ('/api/sessions','/api/codegen/status') and not request.url.path.startswith('/api/connections'):
        raise ServiceError(404,'NOT_FOUND','Resource not found')
