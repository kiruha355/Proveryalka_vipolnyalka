import hmac
from fastapi import APIRouter, Request, Response
from pydantic import Field, SecretStr, field_validator
from ..contracts import Contract
from ..services import ServiceError
from .service import csrf_token

COOKIE='pv_session'


class Email(Contract):
    email: str = Field(min_length=3,max_length=254,pattern=r'^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$')

    @field_validator('email')
    @classmethod
    def normalized(cls,value):
        return value.casefold()


class Credentials(Email):
    password: SecretStr = Field(min_length=12,max_length=128)


class PasswordChange(Contract):
    current_password: SecretStr = Field(min_length=1,max_length=128)
    new_password: SecretStr = Field(min_length=12,max_length=128)


class Reset(Contract):
    token: str = Field(min_length=32,max_length=128)
    password: SecretStr = Field(min_length=12,max_length=128)


def create_auth_router(auth):
    router=APIRouter(prefix='/api/auth',tags=['authentication'])

    def origin(request):
        if request.headers.get('origin') != auth.settings.origin:
            raise ServiceError(403,'CSRF_INVALID','Expected trusted Origin')

    def limited(request,category):
        origin(request)
        auth.limit(category,request.client.host if request.client else 'unknown')

    def signed_in(request,write=False):
        token=request.cookies.get(COOKIE,'')
        user=auth.authenticate(token)
        if write:
            origin(request)
            if not hmac.compare_digest(request.headers.get('x-csrf-token',''),csrf_token(token)):
                raise ServiceError(403,'CSRF_INVALID','Invalid CSRF token')
        return token,user

    @router.post('/register',status_code=201)
    def register(body:Credentials,request:Request):
        limited(request,'register-ip')
        return {'user':auth.register(body.email,body.password.get_secret_value())}

    @router.post('/login')
    def login(body:Credentials,request:Request,response:Response):
        limited(request,'login-ip')
        token,result=auth.login(body.email,body.password.get_secret_value())
        response.set_cookie(COOKIE,token,max_age=auth.settings.session_seconds,httponly=True,
                            secure=auth.settings.secure,samesite='strict',path='/')
        response.headers['Cache-Control']='no-store'
        return result

    @router.get('/me')
    def me(request:Request,response:Response):
        token,user=signed_in(request)
        response.headers['Cache-Control']='no-store'
        return {'user':{'id':user['id'],'email':user['email']},'csrf_token':csrf_token(token),'expires_at':user['expires']}

    @router.post('/logout',status_code=204)
    def logout(request:Request,response:Response):
        token,_=signed_in(request,True);auth.revoke(token)
        response.delete_cookie(COOKIE,path='/')

    @router.delete('/sessions',status_code=204)
    def logout_all(request:Request,response:Response):
        token,_=signed_in(request,True);auth.revoke(token,True)
        response.delete_cookie(COOKIE,path='/')

    @router.post('/password',status_code=204)
    def change(body:PasswordChange,request:Request,response:Response):
        token,_=signed_in(request,True)
        auth.change_password(token,body.current_password.get_secret_value(),body.new_password.get_secret_value())
        response.delete_cookie(COOKIE,path='/')

    @router.post('/password/reset-request',status_code=202)
    def request_reset(body:Email,request:Request):
        limited(request,'reset-ip');auth.request_reset(body.email)
        return {'message':'If the account exists, recovery instructions will be sent'}

    @router.post('/password/reset',status_code=204)
    def reset(body:Reset,request:Request):
        limited(request,'reset-confirm-ip');auth.reset_password(body.token,body.password.get_secret_value())

    return router
