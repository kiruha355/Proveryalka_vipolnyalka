"""Безопасные относительные пути проекта и детерминированный ZIP."""
import io
import re
import zipfile


SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$")
MAX_DEPTH = 8
ZIP_TIME = (1980, 1, 1, 0, 0, 0)


class UnsafePath(ValueError):
    pass


def safe_path(path):
    """Только относительные пути из простых сегментов: без '..', '/', '\\', двоеточий и управляющих символов."""
    if not isinstance(path, str) or not path or len(path) > 300:
        raise UnsafePath("Недопустимый путь")
    parts = path.split("/")
    if len(parts) > MAX_DEPTH or any(not SEGMENT.match(part) or part in (".", "..") or part.endswith(".") for part in parts):
        raise UnsafePath("Недопустимый путь")
    return path


def build_archive(root, files):
    """files: [(path, bytes)]. Порядок и метаданные фиксированы: одинаковый проект — одинаковые байты ZIP."""
    safe_path(root)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, content in sorted(files):
            info = zipfile.ZipInfo(f"{root}/{safe_path(path)}", date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, content)
    return buffer.getvalue()
