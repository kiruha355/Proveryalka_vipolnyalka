"""HTTPS без proxy/netrc/git config; DNS проверен и адрес соединения закреплён."""
import http.client
import json
import queue
import re
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote, urljoin, urlsplit

from ...services import ServiceError
from .policy import RepositoryHost, public_address, remote_parts


class Deadline:
    def __init__(self, seconds):
        self.end = time.monotonic() + seconds

    def remaining(self):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise ServiceError(504, "REPOSITORY_TIMEOUT", "Repository import timed out")
        return remaining


class CredentialProvider(Protocol):
    def authorization(self, reference: str, remote_url: str) -> str | None:
        """Только зарегистрированный сервером provider: Authorization, без чтения профилей здесь."""
        ...


@dataclass(frozen=True)
class RepositoryArchive:
    commit_sha: str
    data: bytes


class RepositoryTransport(Protocol):
    def fetch(self, remote_url, ref, credential_ref, limits, deadline) -> RepositoryArchive: ...


_DNS_SLOTS = threading.BoundedSemaphore(4)


def resolve_public(host, deadline):
    # getaddrinfo не поддерживает deadline. Ограничены и ожидание, и число зависших resolver threads.
    if not _DNS_SLOTS.acquire(blocking=False):
        raise ServiceError(503, "REPOSITORY_DNS_BUSY", "Repository DNS resolver is busy")
    results = queue.Queue(maxsize=1)

    def resolve():
        try:
            results.put(socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))
        except Exception as error:
            results.put(error)
        finally:
            _DNS_SLOTS.release()

    threading.Thread(target=resolve, daemon=True).start()
    try:
        addresses = results.get(timeout=deadline.remaining())
    except queue.Empty:
        raise ServiceError(504, "REPOSITORY_TIMEOUT", "Repository DNS lookup timed out") from None
    if isinstance(addresses, Exception) or not addresses:
        raise ServiceError(502, "REPOSITORY_UNAVAILABLE", "Repository DNS lookup failed")
    if any(not public_address(row[4][0]) for row in addresses):
        raise ServiceError(422, "REPOSITORY_ADDRESS_DENIED", "Repository host must resolve only to public addresses")
    return addresses[0]


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, deadline):
        super().__init__(host, timeout=deadline.remaining(), context=ssl.create_default_context())
        self.address, self.deadline = address, deadline

    def connect(self):
        family, kind, proto, _, address = self.address
        self.sock = socket.socket(family, kind, proto)
        self.sock.settimeout(self.deadline.remaining())
        self.sock.connect(address)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)

    def abort(self):
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class SafeHTTPS:
    def __init__(self, host_policy):
        self.host_policy = host_policy

    def get(self, url, deadline, max_bytes, authorization=None):
        for redirect in range(4):
            parsed = urlsplit(url)
            if (parsed.scheme != "https" or parsed.hostname not in self.host_policy.allowed_hosts
                    or parsed.netloc != parsed.hostname or parsed.fragment
                    or any(ord(c) < 32 or ord(c) == 127 for c in url)):
                raise ServiceError(422, "REPOSITORY_REDIRECT_DENIED", "Repository URL or redirect is not allowed")
            address = resolve_public(parsed.hostname, deadline)
            connection = PinnedHTTPS(parsed.hostname, address, deadline)
            timer = threading.Timer(deadline.remaining(), connection.abort)
            timer.daemon = True
            timer.start()
            try:
                headers = {"User-Agent": "proveryalka-repository-import", "Accept": "application/vnd.github+json",
                           "Accept-Encoding": "identity"}
                if authorization:
                    headers["Authorization"] = authorization
                connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""), headers=headers)
                response = connection.getresponse()
                deadline.remaining()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location or redirect == 3:
                        raise ServiceError(502, "REPOSITORY_REDIRECT_LIMIT", "Repository redirect limit exceeded")
                    if any(ord(c) < 32 or ord(c) == 127 for c in location):
                        raise ServiceError(422, "REPOSITORY_REDIRECT_DENIED", "Repository redirect is not allowed")
                    try:
                        next_url = urljoin(url, location)
                        next_host = urlsplit(next_url).hostname
                    except ValueError:
                        raise ServiceError(422, "REPOSITORY_REDIRECT_DENIED", "Repository redirect is not allowed") from None
                    if next_host != parsed.hostname:
                        authorization = None  # Never forward credentials to the archive host.
                    url = next_url
                    continue
                if response.status in (401, 404):
                    raise ServiceError(403, "REPOSITORY_ACCESS_REQUIRED", "Repository/ref is missing or requires authorized access")
                if response.status == 403:
                    raise ServiceError(403, "REPOSITORY_ACCESS_DENIED", "Repository access denied or provider rate limit reached")
                if response.status == 429:
                    raise ServiceError(429, "REPOSITORY_RATE_LIMIT", "Repository provider rate limit reached")
                if response.status != 200:
                    raise ServiceError(502, "REPOSITORY_UNAVAILABLE", "Repository provider request failed")
                length = response.getheader("Content-Length")
                if length and (not length.isdigit() or int(length) > max_bytes):
                    raise ServiceError(413, "REPOSITORY_SIZE_LIMIT", "Repository download exceeds byte limit")
                chunks, size = [], 0
                while True:
                    deadline.remaining()
                    chunk = response.read1(min(64 * 1024, max_bytes - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ServiceError(413, "REPOSITORY_SIZE_LIMIT", "Repository download exceeds byte limit")
                    chunks.append(chunk)
                deadline.remaining()
                return b"".join(chunks)
            except (OSError, http.client.HTTPException):
                deadline.remaining()
                raise ServiceError(502, "REPOSITORY_UNAVAILABLE", "Repository HTTPS request failed") from None
            finally:
                timer.cancel()
                connection.close()


class GitHubArchiveTransport:
    def __init__(self, host_policy=RepositoryHost(), credential_provider: CredentialProvider | None = None):
        self.host_policy = host_policy
        self.credential_provider = credential_provider
        self.http = SafeHTTPS(host_policy)

    def fetch(self, remote_url, ref, credential_ref, limits, deadline):
        canonical, owner, name = remote_parts(remote_url, self.host_policy)
        authorization = None
        if credential_ref:
            if self.credential_provider is None:
                raise ServiceError(403, "REPOSITORY_CREDENTIAL_UNAVAILABLE", "No repository credential provider is configured")
            try:
                authorization = self.credential_provider.authorization(credential_ref, canonical)
            except Exception:
                raise ServiceError(403, "REPOSITORY_CREDENTIAL_UNAVAILABLE", "Repository credential reference is unavailable") from None
            if not authorization or "\r" in authorization or "\n" in authorization:
                raise ServiceError(403, "REPOSITORY_CREDENTIAL_UNAVAILABLE", "Repository credential reference is unavailable")
        api = f"https://{self.host_policy.api_host}/repos/{owner}/{name}"
        metadata = self.http.get(f"{api}/commits/{quote(ref, safe='')}", deadline, 256 * 1024, authorization)
        try:
            commit = json.loads(metadata)["sha"]
            if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise ServiceError(502, "REPOSITORY_INVALID_COMMIT", "Provider did not return a full commit SHA") from None
        if re.fullmatch(r"[0-9a-f]{40}", ref) and ref != commit:
            raise ServiceError(409, "REPOSITORY_COMMIT_MISMATCH", "Provider commit differs from requested SHA")
        data = self.http.get(f"{api}/tarball/{commit}", deadline, limits.download_bytes, authorization)
        return RepositoryArchive(commit, data)
