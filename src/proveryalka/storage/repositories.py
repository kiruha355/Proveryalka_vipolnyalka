"""Добавочное хранилище: не меняет SQLiteStore и его user_version до интеграции."""
import json
from pathlib import Path

from ..services import ServiceError
from .sqlite import encode, identifier, now


class RepositoryStore:
    def __init__(self, store):
        self.store = store

    def initialize(self):
        migration = Path(__file__).with_name("migrations") / "008_repository_snapshots.sql"
        with self.store.transaction(write=True) as connection:
            for statement in migration.read_text().split(";"):
                if statement.strip():
                    connection.execute(statement)

    def get(self, session_id, snapshot_id):
        with self.store.transaction() as connection:
            self.store._session(connection, session_id)
            return self._get(connection, session_id, snapshot_id)

    @staticmethod
    def _get(connection, session_id, snapshot_id):
        row = connection.execute("SELECT * FROM repository_snapshots WHERE id=? AND session_id=?",
                                 (snapshot_id, session_id)).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Repository snapshot not found")
        result = dict(row)
        result["files"] = json.loads(result.pop("files_json"))
        result["excluded"] = json.loads(result.pop("excluded_json"))
        return result

    def list(self, session_id, limit=50, offset=0):
        with self.store.transaction() as connection:
            self.store._session(connection, session_id)
            ids = connection.execute("SELECT id FROM repository_snapshots WHERE session_id=? ORDER BY created_at,id LIMIT ? OFFSET ?",
                                     (session_id, limit, offset))
            return [self._get(connection, session_id, row[0]) for row in ids]

    def save(self, session_id, request, key, snapshot, contents):
        with self.store.transaction(write=True) as connection:
            self.store._session(connection, session_id)

            def action():
                result = {"id": identifier("repo"), "session_id": session_id, "created_at": now(), **snapshot}
                if result["parent_snapshot_id"]:
                    self._get(connection, session_id, result["parent_snapshot_id"])
                connection.execute(
                    "INSERT INTO repository_snapshots VALUES (:id,:session_id,:remote_url,:commit_sha,:manifest_sha256,"
                    ":parent_snapshot_id,:created_at,:files_json,:excluded_json,:policy_version)",
                    {**result, "files_json": encode(result["files"]), "excluded_json": encode(result["excluded"])})
                connection.executemany("INSERT INTO repository_files VALUES (?,?,?)",
                                       [(result["id"], path, text) for path, text in contents.items()])
                return result

            return self.store._idempotent(connection, f"repository:import:{session_id}", key, request, action)

    def read_contents(self, session_id, snapshot_id):
        with self.store.transaction() as connection:
            snapshot = self._get(connection, session_id, snapshot_id)
            contents = dict(connection.execute("SELECT path,content FROM repository_files WHERE snapshot_id=?", (snapshot_id,)))
            return snapshot, contents

    def save_context(self, session_id, snapshot_id, selection, key, source_text, excerpts, context_hash):
        with self.store.transaction(write=True) as connection:
            self._get(connection, session_id, snapshot_id)

            def action():
                source = {"id": identifier("src"), "session_id": session_id, "kind": "text", "text": source_text}
                connection.execute("INSERT INTO sources VALUES (:id,:session_id,:kind,:text,:created_at)",
                                   {**source, "created_at": now()})
                connection.execute("INSERT INTO repository_source_contexts VALUES (?,?,?,?,?,?)",
                                   (source["id"], session_id, snapshot_id, encode(selection), context_hash, encode(excerpts)))
                snapshot = self._get(connection, session_id, snapshot_id)
                return {"snapshot_id": snapshot_id, "commit_sha": snapshot["commit_sha"],
                        "manifest_sha256": snapshot["manifest_sha256"], "excerpts": excerpts, "source": source}

            return self.store._idempotent(connection, f"repository:context:{session_id}:{snapshot_id}", key, selection, action)

    def context(self, session_id, source_id):
        with self.store.transaction() as connection:
            row = connection.execute("SELECT * FROM repository_source_contexts WHERE source_id=? AND session_id=?",
                                     (source_id, session_id)).fetchone()
            if row is None:
                raise ServiceError(404, "NOT_FOUND", "Repository source context not found")
            return dict(row)
