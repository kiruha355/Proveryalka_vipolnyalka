"""Настоящие git commit/blob fixtures. Local transport существует только в тесте."""
import gzip
import io
import os
import socket
import subprocess
import tarfile
from dataclasses import replace
from pathlib import Path

import pytest

from proveryalka.services import ServiceError
from proveryalka.sources.repositories import RepositoryHost, RepositoryLimits, RepositoryService
from proveryalka.sources.repositories.index import digest
from proveryalka.sources.repositories.policy import public_address, remote_parts
from proveryalka.sources.repositories.transport import (
    Deadline, GitHubArchiveTransport, RepositoryArchive, SafeHTTPS, resolve_public,
)
from proveryalka.storage.sqlite import SQLiteStore


REMOTE = "https://github.com/kiruha355/Proveryalka_vipolnyalka"


class GitFixture:
    def __init__(self, path):
        self.path = path
        path.mkdir()
        self.git("init", "-q")
        self.calls = []

    def git(self, *args):
        # Ни системный/пользовательский Git config, ни credentials не читаются даже fixture.
        environment = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
        environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
        return subprocess.run(["git", "--no-replace-objects", "-c", "core.hooksPath=" + os.devnull,
                               "-c", "core.attributesFile=" + os.devnull, "-c", "user.name=Fixture",
                               "-c", "user.email=fixture@example.invalid", *args], cwd=self.path,
                              env=environment, check=True, capture_output=True).stdout

    def write(self, path, content):
        target = self.path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())

    def commit(self, message="fixture"):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD").decode().strip()

    def fetch(self, remote_url, ref, credential_ref, limits, deadline):
        self.calls.append((remote_url, ref))
        assert remote_url == REMOTE
        assert credential_ref is None
        sha = self.git("rev-parse", ref + "^{commit}").decode().strip()
        # git archive может применять smudge filters. Только plumbing blob reads, без checkout/filters.
        entries = []
        for row in self.git("ls-tree", "-rz", sha).split(b"\0"):
            if not row:
                continue
            metadata, path = row.split(b"\t", 1)
            mode, kind, object_id = metadata.split()
            if kind != b"blob":
                continue
            content = self.git("cat-file", "blob", object_id.decode())
            entries.append(("snapshot/" + path.decode(), content,
                            tarfile.SYMTYPE if mode == b"120000" else tarfile.REGTYPE))
        return RepositoryArchive(sha, archive(entries).data)


@pytest.fixture
def repository(tmp_path):
    repo = GitFixture(tmp_path / "git")
    repo.write("README.md", "first line\nselected requirement\nlast line\n")
    repo.write("src/app.py", "value = 1\n")
    repo.write("other.md", "UNSELECTED_TEXT\n")
    repo.commit()
    return repo


@pytest.fixture
def service(tmp_path, repository):
    store = SQLiteStore(tmp_path / "db.sqlite")
    store.initialize()
    session = store.create_session({"title": "Repository"}, "session")
    result = RepositoryService(store, transport=repository)
    result.initialize()
    return result, session["id"]


def imported(service, key="import"):
    return service[0].import_snapshot(service[1], {"remote_url": REMOTE}, key)


def selection(snapshot, path="README.md", start=2, end=2):
    item = next(item for item in snapshot["files"] if item["path"] == path)
    return {"manifest_sha256": snapshot["manifest_sha256"],
            "files": [{"path": path, "sha256": item["sha256"], "start_line": start, "end_line": end}]}


def assert_error(code, function, *args, **kwargs):
    with pytest.raises(ServiceError) as error:
        function(*args, **kwargs)
    assert error.value.code == code
    return error.value


def test_real_git_immutable_refresh_and_replay(service, repository):
    api, session = service
    first = imported(service)
    assert first["commit_sha"] == repository.git("rev-parse", "HEAD").decode().strip()
    assert imported(service) == first
    assert len(repository.calls) == 1
    repository.write("README.md", "new commit\nnew requirement\n")
    sha = repository.commit("update")
    second = api.refresh(session, first["id"], {"ref": "HEAD"}, "refresh")
    assert second["commit_sha"] == sha != first["commit_sha"]
    assert second["parent_snapshot_id"] == first["id"]
    assert api.repositories.get(session, first["id"]) == first
    assert api.materialize(session, first["id"], selection(first), "old-context")["excerpts"][0]["text"] == "selected requirement\n"
    restored = RepositoryService(SQLiteStore(api.store.path), transport=repository)
    restored.initialize()
    restored.initialize()  # Migration идемпотентна и не меняет schema version общего backend.
    assert restored.repositories.get(session, first["id"]) == first
    assert len(restored.repositories.list(session)) == 2
    explicit = api.import_snapshot(session, {"remote_url": REMOTE, "ref": first["commit_sha"]}, "explicit")
    assert explicit["manifest_sha256"] == first["manifest_sha256"]


def test_selection_hash_ranges_provenance_and_no_extra_writes(service):
    api, session = service
    snapshot = imported(service)
    body = selection(snapshot)
    context = api.materialize(session, snapshot["id"], body, "context")
    assert api.materialize(session, snapshot["id"], body, "context") == context
    assert context["source"]["kind"] == "text"
    assert "UNSELECTED_TEXT" not in context["source"]["text"]
    assert "first line" not in context["source"]["text"]
    excerpt = context["excerpts"][0]
    assert excerpt["provenance_url"].endswith(f"/{snapshot['commit_sha']}/README.md#L2-L2")
    assert context["source"]["text"][excerpt["source_start"]:excerpt["source_end"]] == "selected requirement\n"
    assert api.validate_source(session, context["source"]["id"]) == context["source"]
    assert api.validate_source(session, context["source"]["id"]) == context["source"]
    citation = api.locate_reference(session, context["source"]["id"], excerpt["source_start"], excerpt["source_end"])
    assert citation["start_line"] == citation["end_line"] == 2
    assert citation["commit_sha"] == snapshot["commit_sha"]
    assert citation["sha256"] == excerpt["sha256"]
    assert_error("REPOSITORY_REFERENCE_INVALID", api.locate_reference, session, context["source"]["id"], 0, 3)
    with api.store.transaction() as conn:
        assert conn.execute("SELECT count(*) FROM sources").fetchone()[0] == 1
    bad = selection(snapshot)
    bad["files"][0]["sha256"] = "0" * 64
    assert_error("REPOSITORY_FILE_HASH_MISMATCH", api.materialize, session, snapshot["id"], bad, "bad")
    bad = selection(snapshot)
    bad["manifest_sha256"] = "0" * 64
    assert_error("REPOSITORY_MANIFEST_MISMATCH", api.materialize, session, snapshot["id"], bad, "bad")
    assert_error("REPOSITORY_RANGE_INVALID", api.materialize, session, snapshot["id"], selection(snapshot, end=999), "bad")
    duplicate = selection(snapshot)
    duplicate["files"] *= 2
    assert_error("REPOSITORY_DUPLICATE_SELECTION", api.materialize, session, snapshot["id"], duplicate, "bad")


def test_session_isolation_idempotency_and_membership_before_fetch(service, repository):
    api, session = service
    snapshot = imported(service)
    other = api.store.create_session({"title": "Other"}, "other")["id"]
    assert_error("NOT_FOUND", api.repositories.get, other, snapshot["id"])
    assert_error("NOT_FOUND", api.materialize, other, snapshot["id"], selection(snapshot), "context")
    assert_error("NOT_FOUND", api.import_snapshot, "missing", {"remote_url": REMOTE}, "new")
    assert_error("INVALID_REQUEST", api.import_snapshot, session, {"remote_url": REMOTE}, "")
    assert_error("IDEMPOTENCY_CONFLICT", api.import_snapshot, session, {"remote_url": REMOTE, "ref": "other"}, "import")
    assert len(repository.calls) == 1


def test_filters_do_not_execute_hooks_filters_symlinks_or_submodules(service, repository, tmp_path):
    marker = tmp_path / "MUST_NOT_EXIST"
    # These files are data; reading archive must not invoke any of them.
    repository.write("script.py", f"open({str(marker)!r}, 'w').write('executed')\n")
    repository.write(".gitattributes", "*.py filter=malicious\n")
    repository.git("config", "filter.malicious.smudge", "touch " + str(marker))
    repository.write(".git/hooks/post-checkout", "#!/bin/sh\ntouch " + str(marker))
    repository.write(".gitmodules", "[submodule \"x\"]\npath=x\nurl=file:///private/secret\n")
    repository.write(".env.example", "innocent=example\n")
    repository.write("node_modules/pkg/index.js", "NEVER_INDEX\n")
    repository.write(".venv/pkg.py", "NEVER_INDEX\n")
    repository.write("private-key.txt", "do not expose\n")
    repository.write("config.py", "api_key = 'abcd1234567890'\n")
    repository.write("cert.txt", "-----BEGIN PRIVATE KEY-----\nredacted\n")
    repository.write("binary.py", b"\x00binary\xff")
    repository.write("image.png", b"\x89PNG\x00")
    repository.write("lfs.txt", "version https://git-lfs.github.com/spec/v1\noid sha256:abcdef\nsize 5\n")
    (repository.path / "link.txt").symlink_to("/private/secret")
    repository.commit()
    snapshot = imported(service)
    names = {item["path"] for item in snapshot["files"]}
    assert {"README.md", "script.py", "src/app.py"} <= names
    assert not {".env.example", "config.py", "cert.txt", "binary.py", "image.png", "link.txt", "lfs.txt"} & names
    assert not any(path.startswith((".git/", "node_modules/", ".venv/")) for path in names)
    assert snapshot["excluded"]["secret_pattern"] == 2
    assert snapshot["excluded"]["link_or_special"] == 1
    assert snapshot["excluded"]["lfs_pointer"] == 1
    assert not marker.exists()


@pytest.mark.parametrize("remote", [
    "file:///etc/passwd", "/tmp/repo", "git@github.com:owner/repo", "http://github.com/owner/repo",
    "https://localhost/owner/repo", "https://127.0.0.1/owner/repo", "https://[::1]/owner/repo",
    "https://github.com:443/owner/repo", "https://user:token@github.com/owner/repo",
    "https://github.com/owner/repo?token=value", "https://github.com/owner/repo#main",
    "https://github.com/owner/../repo", "https://github.com/owner/%2e%2e", "https://github.com.evil/owner/repo",
])
def test_remote_urls_rejected_before_transport(service, repository, remote):
    api, session = service
    assert_error("REPOSITORY_URL_DENIED", api.import_snapshot, session, {"remote_url": remote}, "no")
    assert repository.calls == []


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "224.0.0.1", "0.0.0.0", "2002:7f00:1::", "64:ff9b::7f00:1"])
def test_private_addresses_denied(ip):
    assert not public_address(ip)


def test_dns_rejects_mixed_public_private_answers(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("140.82.112.3", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
    ])
    assert_error("REPOSITORY_ADDRESS_DENIED", resolve_public, "github.com", Deadline(1))


def archive(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tar:
        for path, content, kind in entries:
            entry = tarfile.TarInfo(path)
            entry.type = kind
            entry.size = len(content) if kind == tarfile.REGTYPE else 0
            tar.addfile(entry, io.BytesIO(content))
    return RepositoryArchive("a" * 40, data.getvalue())


class StaticTransport:
    def __init__(self, data):
        self.data = data

    def fetch(self, *args):
        return self.data


@pytest.mark.parametrize("path", ["snapshot/../bad.py", "snapshot//bad.py", "/root/bad.py", "snapshot/a\\b.py", "snapshot/a\n.py"])
def test_unsafe_paths_atomic_failure(service, path):
    api, session = service
    api.transport = StaticTransport(archive([(path, b"data", tarfile.REGTYPE)]))
    assert_error("REPOSITORY_UNSAFE_ARCHIVE", api.import_snapshot, session, {"remote_url": REMOTE}, "bad")
    assert api.repositories.list(session) == []


@pytest.mark.parametrize("limit,value,code", [
    ("download_bytes", 20, "REPOSITORY_SIZE_LIMIT"),
    ("expanded_bytes", 100, "REPOSITORY_SIZE_LIMIT"),
    ("file_bytes", 10, "REPOSITORY_FILE_SIZE_LIMIT"),
    ("indexed_bytes", 10, "REPOSITORY_SIZE_LIMIT"),
    ("files", 1, "REPOSITORY_SIZE_LIMIT"),
    ("archive_entries", 1, "REPOSITORY_FILE_LIMIT"),
])
def test_limits_fail_without_partial_snapshot(service, limit, value, code):
    api, session = service
    api.limits = replace(api.limits, **{limit: value})
    assert_error(code, api.import_snapshot, session, {"remote_url": REMOTE}, "limit")
    assert api.repositories.list(session) == []


def test_deadline_and_context_limits(service, monkeypatch):
    api, session = service
    snapshot = imported(service)
    api.limits = replace(api.limits, context_bytes=100)
    assert_error("REPOSITORY_CONTEXT_LIMIT", api.materialize, session, snapshot["id"], selection(snapshot), "context")
    api.limits = replace(api.limits, seconds=1e-12)
    assert_error("REPOSITORY_TIMEOUT", api.import_snapshot, session, {"remote_url": REMOTE}, "timeout")
    assert len(api.repositories.list(session)) == 1


@pytest.mark.parametrize("kind", ["duplicate", "multiple_roots", "invalid", "commit_mismatch"])
def test_archive_and_commit_validation(service, kind):
    api, session = service
    data = archive([("snapshot/a.md", b"ok", tarfile.REGTYPE)])
    body = {"remote_url": REMOTE}
    if kind == "duplicate":
        data = archive([("snapshot/a.md", b"ok", tarfile.REGTYPE)] * 2)
    elif kind == "multiple_roots":
        data = archive([("one/a.md", b"ok", tarfile.REGTYPE), ("two/b.md", b"no", tarfile.REGTYPE)])
    elif kind == "invalid":
        data = RepositoryArchive("a" * 40, b"not gzip")
    else:
        body["ref"] = "b" * 40
    api.transport = StaticTransport(data)
    code = "REPOSITORY_COMMIT_MISMATCH" if kind == "commit_mismatch" else "REPOSITORY_UNSAFE_ARCHIVE"
    assert_error(code, api.import_snapshot, session, body, "invalid")
    assert api.repositories.list(session) == []


def test_crlf_and_unicode_line_citations(service, repository):
    api, session = service
    repository.write("README.md", "Первая\r\nВторая\u2028строка\r\n\nЧетвёртая")
    repository.commit()
    snapshot = imported(service)
    item = next(item for item in snapshot["files"] if item["path"] == "README.md")
    assert item["lines"] == 4
    context = api.materialize(session, snapshot["id"], selection(snapshot, start=2, end=3), "lines")
    excerpt = context["excerpts"][0]
    assert excerpt["text"] == "Вторая\u2028строка\r\n\n"
    citation = api.locate_reference(session, context["source"]["id"], excerpt["source_start"], excerpt["source_end"])
    assert (citation["start_line"], citation["end_line"]) == (2, 3)


def test_stored_content_and_source_tamper_rejected(service):
    api, session = service
    snapshot = imported(service)
    context = api.materialize(session, snapshot["id"], selection(snapshot), "context")
    with api.store.transaction(write=True) as conn:
        conn.execute("UPDATE sources SET text='tampered' WHERE id=?", (context["source"]["id"],))
    assert_error("REPOSITORY_CONTEXT_MISMATCH", api.validate_source, session, context["source"]["id"])
    with api.store.transaction(write=True) as conn:
        conn.execute("UPDATE repository_files SET content='tampered' WHERE snapshot_id=? AND path='README.md'", (snapshot["id"],))
    assert_error("REPOSITORY_FILE_HASH_MISMATCH", api.materialize, session, snapshot["id"], selection(snapshot), "context2")


def test_credentials_not_configured_or_unknown_are_honest_errors():
    transport = GitHubArchiveTransport()
    assert_error("REPOSITORY_CREDENTIAL_UNAVAILABLE", transport.fetch, REMOTE, "HEAD", "private-reference", RepositoryLimits(), Deadline(1))

    class Provider:
        def authorization(self, reference, remote_url):
            assert reference == "unknown"
            return None

    transport = GitHubArchiveTransport(credential_provider=Provider())
    assert_error("REPOSITORY_CREDENTIAL_UNAVAILABLE", transport.fetch, REMOTE, "HEAD", "unknown", RepositoryLimits(), Deadline(1))


def test_github_transport_pins_archive_to_resolved_commit(monkeypatch):
    transport = GitHubArchiveTransport()
    calls = []

    def get(url, deadline, max_bytes, authorization=None):
        calls.append((url, authorization))
        return b'{"sha":"' + b"a" * 40 + b'"}' if "/commits/" in url else b"archive"

    monkeypatch.setattr(transport.http, "get", get)
    result = transport.fetch(REMOTE, "feature/topic", None, RepositoryLimits(), Deadline(1))
    assert result.commit_sha == "a" * 40
    assert calls[0][0].endswith("/commits/feature%2Ftopic")
    assert calls[1][0].endswith("/tarball/" + "a" * 40)
    assert_error("REPOSITORY_COMMIT_MISMATCH", transport.fetch, REMOTE, "b" * 40, None, RepositoryLimits(), Deadline(1))


def test_custom_allowlist_is_server_configuration():
    host = RepositoryHost("code.example.org", "api.example.org", ("archives.example.org",))
    assert remote_parts("https://code.example.org/team/project.git", host)[0] == "https://code.example.org/team/project"
    assert_error("REPOSITORY_URL_DENIED", remote_parts, REMOTE, host)
