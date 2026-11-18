"""One connection per transaction; no SQLite handles shared across threads."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ..contracts import SessionCreate, TextSourceCreate
from ..services import ServiceError, UnavailableBackend


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(prefix):
    return f"{prefix}_{uuid4().hex}"


from .versions import VersionStore
from .runs import RunStore


class SQLiteStore(VersionStore, RunStore):
    def __init__(self, path):
        self.path = Path(path)

    def _connect(self):
        try:
            connection = sqlite3.connect(str(self.path), timeout=10, isolation_level=None)
        except sqlite3.OperationalError as error:
            raise ServiceError(503, "STORAGE_UNAVAILABLE", "Storage is temporarily unavailable") from error
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("BEGIN IMMEDIATE")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > 4:
                raise RuntimeError("Database schema is newer than this application")
            for target, filename in [(1, "001_sessions.sql"), (2, "002_versions.sql"), (3, "003_runs.sql"), (4, "004_events.sql")]:
                if version >= target:
                    continue
                migration = Path(__file__).with_name("migrations") / filename
                for statement in migration.read_text().split(";"):
                    if statement.strip():
                        connection.execute(statement)
                connection.execute(f"PRAGMA user_version={target}")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @contextmanager
    def transaction(self, write=False):
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection
            connection.commit()
        except sqlite3.OperationalError as error:
            connection.rollback()
            # Do not expose database paths or SQL to clients.
            raise ServiceError(503, "STORAGE_UNAVAILABLE", "Storage is temporarily unavailable") from error
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _session(connection, session_id):
        row = connection.execute("SELECT id,title,mode,created_at FROM sessions WHERE id=?", (session_id,)).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Session not found")
        return dict(row)

    @staticmethod
    def _idempotent(connection, scope, key, body, action):
        if not isinstance(key, str) or not 1 <= len(key) <= 128:
            raise ServiceError(422, "INVALID_REQUEST", "Idempotency key must contain 1–128 characters")
        request = encode(body)
        previous = connection.execute(
            "SELECT request_json,response_json FROM idempotency WHERE scope=? AND key=?", (scope, key),
        ).fetchone()
        if previous is not None:
            if previous["request_json"] != request:
                raise ServiceError(409, "IDEMPOTENCY_CONFLICT", "Key already used with a different request")
            return json.loads(previous["response_json"])
        result = action()
        connection.execute("INSERT INTO idempotency VALUES (?,?,?,?)", (scope, key, request, encode(result)))
        return result

    def create_session(self, body, key):
        body = SessionCreate.model_validate(body).model_dump()
        with self.transaction(write=True) as connection:
            def action():
                result = {"id": identifier("s"), **body, "created_at": now()}
                connection.execute(
                    "INSERT INTO sessions(id,title,mode,created_at) VALUES (:id,:title,:mode,:created_at)", result,
                )
                return result
            return self._idempotent(connection, "session:create", key, body, action)

    def list_sessions(self, limit=50, offset=0):
        if not 1 <= limit <= 200 or offset < 0:
            raise ServiceError(422, "INVALID_REQUEST", "Invalid pagination")
        with self.transaction() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT id,title,mode,created_at FROM sessions ORDER BY created_at,id LIMIT ? OFFSET ?", (limit, offset),
            )]

    @staticmethod
    def _messages(connection, session_id, limit=None):
        if limit is not None:
            if limit <= 0:
                return []
            rows = list(connection.execute(
                "SELECT * FROM agent_messages WHERE session_id=? ORDER BY sequence DESC LIMIT ?", (session_id, limit),
            ))[::-1]
        else:
            rows = connection.execute("SELECT * FROM agent_messages WHERE session_id=? ORDER BY sequence", (session_id,))
        return [{**dict(row), "message_data": json.loads(row["message_data"])} for row in rows]

    def get_session(self, session_id):
        with self.transaction() as connection:
            session = self._session(connection, session_id)
            session["messages"] = self._messages(connection, session_id)
            session["sources"] = [dict(row) for row in connection.execute(
                "SELECT id,session_id,kind,text FROM sources WHERE session_id=? ORDER BY created_at,id", (session_id,),
            )]
            session["requirements"] = [dict(row) for row in connection.execute(
                "SELECT id,session_id,source_id,'R'||number AS code,text FROM requirements WHERE session_id=? ORDER BY number", (session_id,),
            )]
            return session

    def create_source(self, session_id, body, key):
        body = TextSourceCreate.model_validate(body).model_dump()
        if any(not text.strip() for text in body["requirements"]):
            raise ServiceError(422, "INVALID_REQUEST", "Requirements must not be blank")
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)

            def action():
                result = {"id": identifier("src"), "session_id": session_id, "kind": "text", "text": body["text"]}
                connection.execute(
                    "INSERT INTO sources(id,session_id,kind,text,created_at) VALUES (:id,:session_id,:kind,:text,:created_at)",
                    {**result, "created_at": now()},
                )
                number = connection.execute("SELECT next_requirement FROM sessions WHERE id=?", (session_id,)).fetchone()[0]
                for text in body["requirements"]:
                    connection.execute("INSERT INTO requirements VALUES (?,?,?,?,?)", (
                        identifier("req"), session_id, result["id"], number, text,
                    ))
                    number += 1
                connection.execute("UPDATE sessions SET next_requirement=? WHERE id=?", (number, session_id))
                return result

            return self._idempotent(connection, f"source:create:{session_id}", key, body, action)

    def get_source(self, session_id, source_id):
        with self.transaction() as connection:
            self._session(connection, session_id)
            row = connection.execute(
                "SELECT id,session_id,kind,text FROM sources WHERE id=? AND session_id=?", (source_id, session_id),
            ).fetchone()
            if row is None:
                raise ServiceError(404, "NOT_FOUND", "Source not found in session")
            return dict(row)

    def append_messages(self, session_id, items):
        # Serialize the whole batch first; failure cannot leave a partial history.
        if any(not isinstance(item, dict) for item in items):
            raise ServiceError(422, "INVALID_REQUEST", "History items must be JSON objects")
        serialized = [encode(item) for item in items]
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            number = connection.execute("SELECT next_message FROM sessions WHERE id=?", (session_id,)).fetchone()[0]
            for item in serialized:
                connection.execute("INSERT INTO agent_messages VALUES (?,?,?,?,?)", (
                    identifier("msg"), session_id, number, item, now(),
                ))
                number += 1
            connection.execute("UPDATE sessions SET next_message=? WHERE id=?", (number, session_id))

    def history(self, session_id, limit=None):
        with self.transaction() as connection:
            self._session(connection, session_id)
            return [row["message_data"] for row in self._messages(connection, session_id, limit)]

    def pop_message(self, session_id):
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            row = connection.execute(
                "SELECT id,message_data FROM agent_messages WHERE session_id=? ORDER BY sequence DESC LIMIT 1", (session_id,),
            ).fetchone()
            if row is None:
                return None
            connection.execute("DELETE FROM agent_messages WHERE id=? AND session_id=?", (row["id"], session_id))
            return json.loads(row["message_data"])

    def clear_history(self, session_id):
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            connection.execute("DELETE FROM agent_messages WHERE session_id=?", (session_id,))


class SQLiteBackend(UnavailableBackend):
    def __init__(self, store):
        self.store = store

    def call(self, operation, **arguments):
        handlers = {
            "create_session": self.store.create_session,
            "list_sessions": self.store.list_sessions,
            "get_session": self.store.get_session,
            "create_source": self.store.create_source,
            **{name: getattr(self.store, name) for name in ("create_model", "list_models", "create_version", "list_versions", "get_version", "approve_version")},
        }
        if operation in handlers:
            return handlers[operation](**arguments)
        return super().call(operation, **arguments)
