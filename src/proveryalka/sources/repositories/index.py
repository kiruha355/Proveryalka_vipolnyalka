import gzip
import hashlib
import io
import tarfile
from collections import Counter
from urllib.parse import quote

from ...services import ServiceError
from ...storage.sqlite import encode
from .policy import POLICY_VERSION, SECRET, excluded_path, safe_path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_lines(text):
    # Git/GitHub line anchors разделяют строки по LF; CRLF сохраняем побайтно.
    parts = text.split("\n")
    return [part + "\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def manifest_hash(remote_url, commit_sha, files, excluded):
    return digest(encode({"remote_url": remote_url, "commit_sha": commit_sha, "files": files,
                          "excluded": excluded, "policy_version": POLICY_VERSION}).encode())


def index_archive(archive, remote_url, limits, deadline):
    if len(archive.data) > limits.download_bytes:
        raise ServiceError(413, "REPOSITORY_SIZE_LIMIT", "Repository download exceeds byte limit")
    try:
        # Ограничение распакованного размера действует до tar parser, включая PAX headers и padding.
        with gzip.GzipFile(fileobj=io.BytesIO(archive.data)) as compressed:
            chunks, size = [], 0
            while True:
                deadline.remaining()
                chunk = compressed.read(min(64 * 1024, limits.expanded_bytes - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > limits.expanded_bytes:
                    raise ServiceError(413, "REPOSITORY_SIZE_LIMIT", "Repository expanded archive exceeds byte limit")
                chunks.append(chunk)
        data = b"".join(chunks)
        files, contents, excluded, seen = [], {}, Counter(), set()
        root, total = None, 0
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as tar:
            for count, entry in enumerate(tar, 1):
                deadline.remaining()
                if count > limits.archive_entries:
                    raise ServiceError(413, "REPOSITORY_FILE_LIMIT", "Repository archive entry limit exceeded")
                name = entry.name.rstrip("/") if entry.isdir() else entry.name
                safe_path(name)
                parts = name.split("/", 1)
                root = root or parts[0]
                if parts[0] != root:
                    raise ServiceError(422, "REPOSITORY_UNSAFE_ARCHIVE", "Archive must have one repository root")
                if len(parts) == 1:
                    if not entry.isdir():
                        raise ServiceError(422, "REPOSITORY_UNSAFE_ARCHIVE", "Archive entry lacks repository root")
                    continue
                path = safe_path(parts[1])
                if path in seen:
                    raise ServiceError(422, "REPOSITORY_UNSAFE_ARCHIVE", "Archive contains duplicate paths")
                seen.add(path)
                if entry.isdir():
                    continue
                if not entry.isfile():
                    excluded["link_or_special"] += 1
                    continue
                reason = excluded_path(path)
                if reason:
                    excluded[reason] += 1
                    continue
                if entry.size > limits.file_bytes:
                    # Не маскируем превышение лимита успешным, но неполным снимком.
                    raise ServiceError(413, "REPOSITORY_FILE_SIZE_LIMIT", "Repository text file exceeds byte limit")
                raw = tar.extractfile(entry).read(limits.file_bytes + 1)
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    excluded["binary_or_non_utf8"] += 1
                    continue
                if any(ord(c) < 32 and c not in "\t\n\r" for c in text) or "\x7f" in text:
                    excluded["binary_or_non_utf8"] += 1
                    continue
                if SECRET.search(text):
                    excluded["secret_pattern"] += 1
                    continue
                if text.startswith("version https://git-lfs.github.com/spec/v1\n"):
                    excluded["lfs_pointer"] += 1
                    continue
                total += len(raw)
                if total > limits.indexed_bytes or len(files) >= limits.files:
                    raise ServiceError(413, "REPOSITORY_SIZE_LIMIT", "Repository indexed text/file limit exceeded")
                files.append({"path": path, "sha256": digest(raw), "size_bytes": len(raw),
                              "lines": len(file_lines(text)),
                              "provenance_url": f"{remote_url}/blob/{archive.commit_sha}/{quote(path, safe='/')}"})
                contents[path] = text
        files.sort(key=lambda item: item["path"])
        deadline.remaining()
        return files, contents, dict(sorted(excluded.items()))
    except (OSError, EOFError, tarfile.TarError, ValueError):
        raise ServiceError(422, "REPOSITORY_UNSAFE_ARCHIVE", "Repository archive is invalid") from None
