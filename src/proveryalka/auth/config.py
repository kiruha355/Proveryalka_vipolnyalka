import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class AuthSettings:
    enabled: bool = False
    origin: str = 'http://127.0.0.1:8000'
    session_seconds: int = 43200
    reset_seconds: int = 900
    attempt_limit: int = 10
    window_seconds: int = 900
    smtp_host: str = ''
    smtp_port: int = 465
    smtp_user: str = ''
    smtp_password: str = field(default='', repr=False)
    smtp_sender: str = ''

    def __post_init__(self):
        url = urlsplit(self.origin)
        if url.scheme not in ('http', 'https') or not url.hostname or url.path or url.query or url.fragment or url.username:
            raise ValueError('AUTH_ORIGIN must be a single origin without a path')
        if url.scheme != 'https' and url.hostname not in ('127.0.0.1','localhost','::1','testserver'):
            raise ValueError('Non-loopback authentication requires HTTPS')
        if min(self.session_seconds,self.reset_seconds,self.attempt_limit,self.window_seconds) < 1:
            raise ValueError('Authentication limits must be positive')

    @property
    def secure(self):
        return self.origin.startswith('https:')

    @classmethod
    def from_env(cls):
        return cls(enabled=os.getenv('PROVERYALKA_AUTH_ENABLED') == '1',
                   origin=os.getenv('PROVERYALKA_AUTH_ORIGIN','http://127.0.0.1:8000'),
                   session_seconds=int(os.getenv('PROVERYALKA_AUTH_SESSION_SECONDS','43200')),
                   smtp_host=os.getenv('PROVERYALKA_SMTP_HOST',''),
                   smtp_port=int(os.getenv('PROVERYALKA_SMTP_PORT','465')),
                   smtp_user=os.getenv('PROVERYALKA_SMTP_USER',''),
                   smtp_password=os.getenv('PROVERYALKA_SMTP_PASSWORD',''),
                   smtp_sender=os.getenv('PROVERYALKA_SMTP_SENDER',''))
