import hashlib
import hmac
import secrets
import smtplib
import sqlite3
import ssl
import time
from email.message import EmailMessage
from uuid import uuid4

from ..services import ServiceError


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    # OWASP scrypt minimum equivalent: N=2^14, r=8, p=5 (16 MiB).
    result = hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=5,maxmem=64*1024*1024)
    return f'scrypt$16384$8$5${salt}${result.hex()}'


def password_matches(password, encoded):
    try:
        return hmac.compare_digest(password_hash(password,encoded.split('$')[4]),encoded)
    except (ValueError,IndexError):
        return False


def csrf_token(token):
    return digest('csrf:'+token)


class AuthService:
    def __init__(self, store, settings, delivery=None, clock=time.time):
        self.store,self.settings,self.clock = store,settings,clock
        self.delivery = delivery or self.send_reset
        self.dummy = password_hash(secrets.token_urlsafe(32))

    def limit(self, category, value):
        key = digest(category+':'+value)
        now = self.clock()
        with self.store.transaction(write=True) as c:
            c.execute('DELETE FROM auth_attempts WHERE expires<=?',(now,))
            row = c.execute('SELECT count FROM auth_attempts WHERE key=?',(key,)).fetchone()
            if row and row[0] >= self.settings.attempt_limit:
                raise ServiceError(429,'AUTH_RATE_LIMIT','Too many attempts; try later')
            c.execute('INSERT INTO auth_attempts VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
                      (key,1,now+self.settings.window_seconds))

    def register(self,email,password):
        encoded = password_hash(password)
        uid = 'u_'+uuid4().hex
        try:
            with self.store.transaction(write=True) as c:
                c.execute('INSERT INTO users VALUES (?,?,?,?)',(uid,email,encoded,self.clock()))
        except sqlite3.IntegrityError as error:
            raise ServiceError(409,'ACCOUNT_EXISTS','Account already exists') from error
        return {'id':uid,'email':email}

    def login(self,email,password):
        self.limit('login-account',email)
        with self.store.transaction() as c:
            user = c.execute('SELECT * FROM users WHERE email=?',(email,)).fetchone()
        matches = password_matches(password,user['password_hash'] if user else self.dummy)
        if not user or not matches:
            raise ServiceError(401,'INVALID_CREDENTIALS','Invalid email or password')
        token = secrets.token_urlsafe(32)
        expires = self.clock()+self.settings.session_seconds
        with self.store.transaction(write=True) as c:
            # A concurrent password change invalidates this login attempt.
            current = c.execute('SELECT password_hash FROM users WHERE id=?',(user['id'],)).fetchone()
            if current[0] != user['password_hash']:
                raise ServiceError(401,'INVALID_CREDENTIALS','Credentials changed; retry login')
            c.execute('INSERT INTO user_sessions VALUES (?,?,?,?,?)',
                      (digest(token),user['id'],expires,self.clock(),'cookie'))
        return token, {'user':{'id':user['id'],'email':user['email']},'csrf_token':csrf_token(token),'expires_at':expires}

    def authenticate(self,token):
        with self.store.transaction() as c:
            row = c.execute('SELECT u.id,u.email,s.expires,s.kind FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?',
                            (digest(token),self.clock())).fetchone()
        if not row:
            raise ServiceError(401,'AUTH_REQUIRED','Authentication required')
        return dict(row)

    def revoke(self,token,all_sessions=False):
        user = self.authenticate(token)
        with self.store.transaction(write=True) as c:
            if all_sessions:
                c.execute('DELETE FROM user_sessions WHERE user_id=?',(user['id'],))
            else:
                c.execute('DELETE FROM user_sessions WHERE token_hash=?',(digest(token),))

    def change_password(self,token,current,new):
        user = self.authenticate(token)
        self.limit('password',user['id'])
        with self.store.transaction() as c:
            old = c.execute('SELECT password_hash FROM users WHERE id=?',(user['id'],)).fetchone()[0]
        if not password_matches(current,old):
            raise ServiceError(401,'INVALID_CREDENTIALS','Invalid password')
        encoded = password_hash(new)
        with self.store.transaction(write=True) as c:
            updated = c.execute('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?',(encoded,user['id'],old))
            if not updated.rowcount:
                raise ServiceError(409,'CREDENTIALS_CHANGED','Credentials changed; retry')
            c.execute('DELETE FROM user_sessions WHERE user_id=?',(user['id'],))
            c.execute('DELETE FROM password_resets WHERE user_id=?',(user['id'],))

    def request_reset(self,email):
        self.limit('reset-account',email)
        with self.store.transaction() as c:
            user = c.execute('SELECT id FROM users WHERE email=?',(email,)).fetchone()
        if not user:
            return
        token = secrets.token_urlsafe(32)
        with self.store.transaction(write=True) as c:
            c.execute('DELETE FROM password_resets WHERE user_id=?',(user[0],))
            c.execute('INSERT INTO password_resets VALUES (?,?,?)',(digest(token),user[0],self.clock()+self.settings.reset_seconds))
        try:
            self.delivery(email,token)
        except Exception:
            # Do not leak existence, SMTP credentials, or a recovery token.
            with self.store.transaction(write=True) as c:
                c.execute('DELETE FROM password_resets WHERE token_hash=?',(digest(token),))

    def reset_password(self,token,password):
        encoded = password_hash(password)
        with self.store.transaction(write=True) as c:
            row = c.execute('SELECT user_id FROM password_resets WHERE token_hash=? AND expires>?',(digest(token),self.clock())).fetchone()
            if not row:
                raise ServiceError(400,'RESET_INVALID','Invalid or expired recovery link')
            c.execute('UPDATE users SET password_hash=? WHERE id=?',(encoded,row[0]))
            c.execute('DELETE FROM password_resets WHERE user_id=?',(row[0],))
            c.execute('DELETE FROM user_sessions WHERE user_id=?',(row[0],))

    def send_reset(self,email,token):
        cfg=self.settings
        if not cfg.smtp_host or not cfg.smtp_sender:
            raise RuntimeError('SMTP recovery delivery is not configured')
        message=EmailMessage()
        message['From']=cfg.smtp_sender; message['To']=email
        message['Subject']='Восстановление доступа — Проверялка'
        # Fragment avoids sending token in HTTP access logs; frontend #87 consumes it.
        message.set_content(f'Откройте {cfg.origin}/reset-password#token={token}\nСсылка одноразовая, действует {cfg.reset_seconds//60} минут.')
        with smtplib.SMTP_SSL(cfg.smtp_host,cfg.smtp_port,timeout=10,context=ssl.create_default_context()) as smtp:
            if cfg.smtp_user:
                smtp.login(cfg.smtp_user,cfg.smtp_password)
            smtp.send_message(message)
