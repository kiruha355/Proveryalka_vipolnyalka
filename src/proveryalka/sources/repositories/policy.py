"""Ограничения задаёт сервер, а не импортируемый репозиторий или HTTP-клиент."""
import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from ...services import ServiceError


POLICY_VERSION = "repository-text-v1"


@dataclass(frozen=True)
class RepositoryLimits:
    download_bytes: int = 8 * 1024 * 1024
    expanded_bytes: int = 32 * 1024 * 1024
    indexed_bytes: int = 4 * 1024 * 1024
    file_bytes: int = 256 * 1024
    files: int = 1000
    archive_entries: int = 5000
    seconds: float = 30
    context_bytes: int = 48 * 1024
    context_lines: int = 800

    def __post_init__(self):
        if any(value <= 0 for value in self.__dict__.values()):
            raise ValueError("Repository limits must be positive")


@dataclass(frozen=True)
class RepositoryHost:
    """Оператор может настроить GitHub-compatible публичный host/API/archive allowlist."""
    remote_host: str = "github.com"
    api_host: str = "api.github.com"
    archive_hosts: tuple[str, ...] = ("codeload.github.com",)

    @property
    def allowed_hosts(self):
        return frozenset((self.remote_host, self.api_host, *self.archive_hosts))


def public_address(value):
    address = ipaddress.ip_address(value)
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    if address.version == 6 and (address.sixtofour is not None or address.teredo is not None
                                 or address in ipaddress.ip_network("64:ff9b::/96")):
        return False
    return address.is_global and not address.is_multicast and not address.is_reserved


def remote_parts(url, host):
    try:
        parsed = urlsplit(url)
        valid = (not any(ord(c) < 32 or ord(c) == 127 for c in url)
                 and parsed.scheme == "https" and parsed.hostname == host.remote_host
                 and parsed.netloc == host.remote_host and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise ServiceError(422, "REPOSITORY_URL_DENIED", "Only a configured public HTTPS repository URL is allowed")
    match = re.fullmatch(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?", parsed.path)
    if not match or any(part in (".", "..") for part in match.groups()):
        raise ServiceError(422, "REPOSITORY_URL_DENIED", "Expected an owner/repository URL without credentials")
    owner, name = match.groups()
    return f"https://{host.remote_host}/{owner}/{name}", owner, name


def safe_path(path):
    if (not path or len(path) > 1000 or path.startswith("/") or "\\" in path
            or any(ord(char) < 32 or ord(char) == 127 for char in path)
            or any(part in ("", ".", "..") for part in path.split("/"))):
        raise ServiceError(422, "REPOSITORY_UNSAFE_ARCHIVE", "Archive contains an unsafe path")
    return path


EXCLUDED_PARTS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "bower_components", ".venv", "venv", "env",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".nuxt", ".cache",
    ".tox", ".nox", ".idea", ".vscode", "dist", "build", "coverage", "htmlcov", "logs",
    ".ssh", ".aws", ".azure", ".gcloud", "secrets", "credentials", "site-packages",
    ".codex", ".claude", ".t3", ".local", ".config", "tmp", "temp", "cache", "caches",
    "sessions", "runtime", "artifacts", "target",
})
TEXT_SUFFIXES = frozenset({
    ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".txt", ".rst", ".toml", ".yaml",
    ".yml", ".xml", ".html", ".css", ".scss", ".sql", ".sh", ".go", ".rs", ".java", ".c",
    ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".vue", ".svelte", ".tla",
})
SECRET = re.compile(
    r"-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----"
    r"|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b"
    r"|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|credential)\b"
    r"\s*[\"']?\s*[:=]\s*[\"']?[^\s\"'<>]{4,}"
    r"|[a-z][a-z0-9+.-]*://[^\s/:]+:[^\s/@]+@"
    r"|\bBearer\s+[A-Za-z0-9._~-]{16,}"
    r"|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}",
    re.IGNORECASE,
)


def excluded_path(path):
    parts = path.lower().split("/")
    name = parts[-1]
    if (any(part in EXCLUDED_PARTS or part.startswith(".env") for part in parts)
            or name in {".npmrc", ".pypirc", ".netrc", ".gitconfig", "id_rsa", "id_ed25519"}
            or re.search(r"(?:secret|credential|password|token|private[_-]?key)", name)
            or name.endswith((".pem", ".key", ".p12", ".pfx", ".keystore", ".lock"))):
        return "sensitive_or_service_path"
    suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if suffix not in TEXT_SUFFIXES and name not in {"readme", "license", "dockerfile", "makefile"}:
        return "unsupported_type"
    return None
