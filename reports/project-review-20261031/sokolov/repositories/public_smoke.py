"""Опциональная воспроизводимая live проверка только public repo этого проекта, без LLM."""
import json
import tempfile
from pathlib import Path

from proveryalka.sources.repositories import RepositoryService
from proveryalka.storage.sqlite import SQLiteStore


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="repository-public-smoke-") as temporary:
        store = SQLiteStore(Path(temporary) / "db")
        store.initialize()
        session_id = store.create_session({"title": "public repository smoke"}, "session")["id"]
        service = RepositoryService(store)
        service.initialize()
        snapshot = service.import_snapshot(session_id, {
            "remote_url": "https://github.com/kiruha355/Proveryalka_vipolnyalka",
        }, "public")
        print(json.dumps({"status": "PASS", "commit_sha": snapshot["commit_sha"],
                          "manifest_sha256": snapshot["manifest_sha256"], "files": len(snapshot["files"]),
                          "indexed_bytes": sum(item["size_bytes"] for item in snapshot["files"]),
                          "excluded": snapshot["excluded"]}, ensure_ascii=False))
