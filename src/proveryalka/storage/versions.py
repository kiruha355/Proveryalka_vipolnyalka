import json
from uuid import uuid4

from pydantic import ValidationError
from ..behavior import BehavioralModel
from ..verification import spec_hash
from ..services import ServiceError


class VersionStore:
    @staticmethod
    def _model(connection, model_id):
        row = connection.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Model not found")
        return dict(row)

    @staticmethod
    def _version(connection, model_id, number):
        row = connection.execute(
            "SELECT v.*,m.session_id FROM model_versions v JOIN models m ON m.id=v.model_id WHERE v.model_id=? AND v.number=?",
            (model_id, number),
        ).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Version not found in model")
        result = dict(row)
        result["spec"] = json.loads(result["spec"])
        result["approved"] = bool(result["approved"])
        return result

    def create_model(self, session_id, body, key):
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            def action():
                result = {"id": "m_" + uuid4().hex, "session_id": session_id, "name": body["name"]}
                connection.execute("INSERT INTO models VALUES (:id,:session_id,:name)", result)
                return result
            return self._idempotent(connection, f"model:create:{session_id}", key, body, action)

    def list_models(self, session_id):
        with self.transaction() as connection:
            self._session(connection, session_id)
            return [dict(r) for r in connection.execute("SELECT * FROM models WHERE session_id=? ORDER BY id", (session_id,))]

    def create_version(self, model_id, body, key):
        try:
            spec = BehavioralModel.model_validate(body["spec"])
        except (ValidationError, KeyError) as error:
            raise ServiceError(422, "MODEL_INVALID", "Invalid behavioral model") from error
        with self.transaction(write=True) as connection:
            model = self._model(connection, model_id)
            # A valid model's embedded sources must also belong to the durable session.
            for source in spec.sources:
                row = connection.execute("SELECT text FROM sources WHERE id=? AND session_id=?", (source.id, model["session_id"])).fetchone()
                if source.session_id != model["session_id"] or row is None or row["text"] != source.text:
                    raise ServiceError(404, "SOURCE_NOT_FOUND", "Model source does not match the session source")
            def action():
                last = connection.execute("SELECT id,number FROM model_versions WHERE model_id=? ORDER BY number DESC LIMIT 1", (model_id,)).fetchone()
                number = last["number"] + 1 if last else 1
                parent = body.get("parent_id")
                if parent is not None:
                    if connection.execute("SELECT 1 FROM model_versions WHERE id=? AND model_id=?", (parent, model_id)).fetchone() is None:
                        raise ServiceError(404, "NOT_FOUND", "Parent version not found in model")
                elif last:
                    parent = last["id"]
                connection.execute("INSERT INTO model_versions(id,model_id,number,parent_id,spec,spec_hash) VALUES (?,?,?,?,?,?)", (
                    "v_" + uuid4().hex, model_id, number, parent, spec.model_dump_json(), spec_hash(spec),
                ))
                return self._version(connection, model_id, number)
            return self._idempotent(connection, f"version:create:{model_id}", key, body, action)

    def latest_version(self, model_id):
        with self.transaction() as connection:
            row = connection.execute("SELECT number FROM model_versions WHERE model_id=? ORDER BY number DESC LIMIT 1", (model_id,)).fetchone()
            return None if row is None else self._version(connection, model_id, row["number"])

    def get_version(self, model_id, number):
        with self.transaction() as connection:
            return self._version(connection, model_id, number)

    def list_versions(self, model_id):
        with self.transaction() as connection:
            self._model(connection, model_id)
            numbers = connection.execute("SELECT number FROM model_versions WHERE model_id=? ORDER BY number", (model_id,)).fetchall()
            return [self._version(connection, model_id, row[0]) for row in numbers]

    def approve_version(self, model_id, number):
        with self.transaction(write=True) as connection:
            self._version(connection, model_id, number)
            connection.execute("UPDATE model_versions SET approved=1 WHERE model_id=? AND number=?", (model_id, number))
            return self._version(connection, model_id, number)
