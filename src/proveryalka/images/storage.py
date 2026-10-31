"""Image storage over the existing SQLiteStore transaction boundary; no new connections/paths."""
import json
import hashlib

from ..services import ServiceError
from ..storage.sqlite import encode, identifier, now
from .dto import ImageSource


class ImageStore:
    def __init__(self, store):
        self.store = store

    def create(self, session_id, metadata, pixels, key):
        with self.store.transaction(write=True) as db:
            self.store._session(db, session_id)
            def action():
                source = ImageSource(id=identifier("img"), session_id=session_id, **metadata).model_dump(mode="json")
                db.execute("INSERT INTO image_sources VALUES (?,?,?,?,?)",
                           (source["id"], session_id, encode(source), pixels, now()))
                return source
            return self.store._idempotent(db, f"{session_id}:image", key, metadata, action)

    def list(self, session_id):
        with self.store.transaction() as db:
            self.store._session(db, session_id)
            return [json.loads(row[0]) for row in db.execute(
                "SELECT metadata_json FROM image_sources WHERE session_id=? ORDER BY created_at,id", (session_id,))]

    def get(self, session_id, source_id):
        with self.store.transaction() as db:
            self.store._session(db, session_id)
            row = db.execute("SELECT metadata_json,canonical_png FROM image_sources WHERE id=? AND session_id=?",
                             (source_id, session_id)).fetchone()
            if row is None:
                raise ServiceError(404, "NOT_FOUND", "Источник изображения не найден")
            try:
                source, pixels = ImageSource.model_validate_json(row[0]), bytes(row[1])
            except (ValueError, TypeError) as error:
                raise ServiceError(503, "IMAGE_SOURCE_CORRUPT", "Сохранённый источник изображения повреждён") from error
            if hashlib.sha256(pixels).hexdigest() != source.canonical_sha256 or len(pixels) != source.canonical_size_bytes:
                raise ServiceError(503, "IMAGE_SOURCE_CORRUPT", "Сохранённый источник изображения повреждён")
            return source, pixels

    def analyses(self, session_id, source_id):
        self.get(session_id, source_id)  # Enforce the same session boundary as content access.
        with self.store.transaction() as db:
            return [{"id": row["id"], "source_id": source_id, "state": row["state"],
                     "error_code": row["error_code"],
                     "result": json.loads(row["response_json"]) if row["response_json"] else None}
                    for row in db.execute("SELECT * FROM image_analyses WHERE source_id=? ORDER BY created_at,id", (source_id,))]

    def reserve(self, source_id, body, key):
        if not isinstance(key, str) or not 1 <= len(key) <= 128:
            raise ServiceError(422, "INVALID_REQUEST", "Нужен Idempotency-Key длиной 1–128")
        request = encode(body)
        with self.store.transaction(write=True) as db:
            row = db.execute("SELECT * FROM image_analyses WHERE source_id=? AND request_key=?", (source_id, key)).fetchone()
            if row is not None:
                if row["request_json"] != request:
                    raise ServiceError(409, "IDEMPOTENCY_CONFLICT", "Ключ уже использован с другим запросом")
                if row["state"] == "completed":
                    return row["id"], json.loads(row["response_json"])
                if row["state"] == "failed":
                    raise ServiceError(409, row["error_code"], "Предыдущий разбор не завершён. Для повтора нужен новый Idempotency-Key")
                raise ServiceError(409, "IMAGE_ANALYSIS_RUNNING", "Разбор с этим ключом уже выполняется")
            aid = identifier("imganalysis")
            db.execute("INSERT INTO image_analyses VALUES (?,?,?,?,?,?,?,?)",
                       (aid, source_id, key, request, "running", None, None, now()))
            return aid, None

    def finish(self, aid, result=None, code=None):
        with self.store.transaction(write=True) as db:
            db.execute("UPDATE image_analyses SET state=?, response_json=?, error_code=? WHERE id=? AND state='running'",
                       ("completed" if result is not None else "failed", encode(result) if result is not None else None, code, aid))

    def recover(self):
        with self.store.transaction(write=True) as db:
            db.execute("UPDATE image_analyses SET state='failed',error_code='IMAGE_ANALYSIS_INTERRUPTED' WHERE state='running'")
