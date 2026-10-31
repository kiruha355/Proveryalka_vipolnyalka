"""Детерминированный HTTPS security boundary, без обращения к локальному HTTP-сервису."""
import io
import socket
import threading
import time

import pytest

from proveryalka.sources.repositories import RepositoryHost
from proveryalka.sources.repositories import transport as network
from proveryalka.sources.repositories.transport import Deadline, SafeHTTPS
from test_repositories import assert_error


class Response:
    def __init__(self, status=200, headers=None, data=b"ok"):
        self.status, self.headers = status, headers or {}
        self.data = io.BytesIO(data)

    def getheader(self, name):
        return self.headers.get(name)

    def read1(self, size):
        return self.data.read(size)


@pytest.fixture
def https(monkeypatch):
    calls, responses, dns = [], [], []

    def resolve(host, deadline):
        dns.append(host)
        return (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("140.82.112.3", 443))

    class Connection:
        def __init__(self, host, address, deadline):
            self.host, self.address = host, address

        def request(self, method, target, headers):
            calls.append((self.host, self.address, target, headers))

        def getresponse(self):
            return responses.pop(0)

        def close(self):
            pass

        def abort(self):
            pass

    monkeypatch.setattr(network, "resolve_public", resolve)
    monkeypatch.setattr(network, "PinnedHTTPS", Connection)
    return SafeHTTPS(RepositoryHost()), calls, responses, dns


def test_redirect_credentials_are_not_forwarded(https):
    http, calls, responses, dns = https
    responses.extend([Response(302, {"Location": "https://codeload.github.com/owner/repo/tar.gz/sha"}), Response()])
    assert http.get("https://api.github.com/repos/owner/repo/tarball/sha", Deadline(1), 10, "Bearer test-fixture") == b"ok"
    assert calls[0][3]["Authorization"] == "Bearer test-fixture"
    assert "Authorization" not in calls[1][3]
    assert dns == ["api.github.com", "codeload.github.com"]
    assert all(call[1][4] == ("140.82.112.3", 443) for call in calls)


@pytest.mark.parametrize("location", ["http://codeload.github.com/file", "https://127.0.0.1/private",
    "https://localhost/private", "https://user:password@codeload.github.com/file", "https://evil.example/file",
    "https://codeload.github.com:443/file", "https://codeload.github.com/file\nheader"])
def test_unsafe_redirect_rejected_before_second_connection(https, location):
    http, calls, responses, dns = https
    responses.append(Response(302, {"Location": location}))
    assert_error("REPOSITORY_REDIRECT_DENIED", http.get, "https://api.github.com/file", Deadline(1), 100)
    assert len(calls) == 1
    assert dns == ["api.github.com"]


@pytest.mark.parametrize("status,code", [(401, "REPOSITORY_ACCESS_REQUIRED"), (404, "REPOSITORY_ACCESS_REQUIRED"),
    (403, "REPOSITORY_ACCESS_DENIED"), (429, "REPOSITORY_RATE_LIMIT"), (500, "REPOSITORY_UNAVAILABLE")])
def test_provider_errors_are_not_empty_success(https, status, code):
    http, calls, responses, dns = https
    responses.append(Response(status, data=b"upstream private details"))
    error = assert_error(code, http.get, "https://api.github.com/file", Deadline(1), 100)
    assert "private details" not in error.message


@pytest.mark.parametrize("headers", [{}, {"Content-Length": "1000"}])
def test_download_size_limit_before_persistence(https, headers):
    http, calls, responses, dns = https
    responses.append(Response(headers=headers, data=b"a" * 1000))
    assert_error("REPOSITORY_SIZE_LIMIT", http.get, "https://api.github.com/file", Deadline(1), 10)


def test_redirect_loop_is_bounded(https):
    http, calls, responses, dns = https
    responses.extend([Response(302, {"Location": "/same"}) for _ in range(4)])
    assert_error("REPOSITORY_REDIRECT_LIMIT", http.get, "https://api.github.com/file", Deadline(1), 10)
    assert len(calls) == 4


def test_dns_timeout_does_not_hold_request_thread(monkeypatch):
    gate = threading.Event()

    def resolve(*args, **kwargs):
        gate.wait(1)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("140.82.112.3", 443))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    try:
        started = time.monotonic()
        assert_error("REPOSITORY_TIMEOUT", network.resolve_public, "github.com", Deadline(0.02))
        assert time.monotonic() - started < 0.5
    finally:
        gate.set()


def test_tls_uses_verified_hostname_and_prevalidated_address(monkeypatch):
    connections, handshakes = [], []

    class Socket:
        def settimeout(self, timeout):
            assert timeout > 0

        def connect(self, address):
            connections.append(address)

    class TLS:
        def wrap_socket(self, sock, server_hostname):
            handshakes.append(server_hostname)
            return sock

    monkeypatch.setattr(socket, "socket", lambda *args: Socket())
    pinned = network.PinnedHTTPS("api.github.com", (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("140.82.112.3", 443)), Deadline(1))
    pinned._context = TLS()
    pinned.connect()
    assert connections == [("140.82.112.3", 443)]
    assert handshakes == ["api.github.com"]


def test_total_deadline_interrupts_waiting_for_response_headers(monkeypatch):
    gate = threading.Event()

    class SlowConnection:
        def __init__(self, *args):
            pass

        def request(self, *args, **kwargs):
            pass

        def getresponse(self):
            assert gate.wait(1)
            raise OSError("aborted by deadline")

        def abort(self):
            gate.set()

        def close(self):
            pass

    monkeypatch.setattr(network, "resolve_public", lambda *args: None)
    monkeypatch.setattr(network, "PinnedHTTPS", SlowConnection)
    started = time.monotonic()
    assert_error("REPOSITORY_TIMEOUT", SafeHTTPS(RepositoryHost()).get, "https://api.github.com/file", Deadline(0.02), 100)
    assert time.monotonic() - started < 0.5
