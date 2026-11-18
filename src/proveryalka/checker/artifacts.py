import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

from ..verification.contracts import VerificationReport, VerificationRequest
from .runner import file_sha256


RUN_ID = re.compile(r"^chk_[a-z0-9]{6,64}$")
MANIFEST = "manifest.json"


class ArtifactError(ValueError):
    pass


def new_run_id():
    return f"chk_{secrets.token_hex(8)}"


def write_text(path, text):
    """Атомарная запись: читатель никогда не увидит наполовину записанный файл."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def write_json(path, data):
    write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


class RunBundle:
    """Каталог одного запуска: модель, .tla/.cfg, журналы TLC, лимиты, длительности и итоговый JSON."""

    def __init__(self, root, run_id):
        if not RUN_ID.match(run_id):
            raise ArtifactError(f"Недопустимый идентификатор запуска: {run_id}")
        self.run_id = run_id
        self.root = Path(root).resolve()
        self.path = self.root / run_id

    def create(self):
        self.path.mkdir(parents=True, exist_ok=False)
        return self

    def file(self, name):
        target = (self.path / name).resolve()
        if self.path not in target.parents:
            raise ArtifactError(f"Путь вне каталога запуска: {name}")
        return target

    def write(self, name, text):
        write_text(self.file(name), text)

    def finish(self, manifest):
        """Фиксирует перечень файлов с хэшами; временные каталоги TLC в комплект не входят."""
        files = []
        for path in sorted(self.path.rglob("*")):
            if path.is_file() and path.name != MANIFEST:
                files.append({
                    "name": path.relative_to(self.path).as_posix(),
                    "size": path.stat().st_size, "sha256": file_sha256(path),
                })
        write_json(self.file(MANIFEST), {**manifest, "run_id": self.run_id, "files": files})

    def manifest(self):
        try:
            return json.loads(self.file(MANIFEST).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ArtifactError(f"Комплект {self.run_id} не найден или повреждён") from error

    def files(self):
        return [item["name"] for item in self.manifest()["files"]]

    def open(self, name):
        """Выдаёт только файлы из манифеста: произвольный путь через API получить нельзя."""
        if name not in self.files():
            raise ArtifactError(f"Файл не входит в комплект: {name}")
        return self.file(name)

    def verify(self):
        """Проверяет, что комплект полон и не изменён после записи."""
        manifest = self.manifest()
        for item in manifest["files"]:
            path = self.file(item["name"])
            if not path.is_file() or file_sha256(path) != item["sha256"]:
                raise ArtifactError(f"Файл комплекта изменён или отсутствует: {item['name']}")
        request = VerificationRequest.model_validate_json(self.file("request.json").read_text(encoding="utf-8"))
        report = VerificationReport.model_validate_json(self.file("report.json").read_text(encoding="utf-8"))
        return manifest, request, report


class ArtifactStore:
    def __init__(self, root):
        self.root = Path(root)

    def bundle(self, run_id):
        return RunBundle(self.root, run_id)

    def create(self, run_id=None):
        return RunBundle(self.root, run_id or new_run_id()).create()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def remove_tree(path):
    shutil.rmtree(path, ignore_errors=True)
