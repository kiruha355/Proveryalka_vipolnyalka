import json
from uuid import uuid4
from pydantic import ValidationError
from ..services import ServiceError
from ..verification.contracts import VerificationRequest, VerificationReport


class RunStore:
    @staticmethod
    def _run(connection, run_id):
        row = connection.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Run not found")
        return dict(row)

    def get_run(self, run_id):
        with self.transaction() as connection:
            row = self._run(connection, run_id)
            return {k: row[k] for k in ("run_id", "session_id", "version_id", "state")}

    def get_check(self, run_id):
        with self.transaction() as connection:
            row = self._run(connection, run_id)
            if row["kind"] != "check":
                raise ServiceError(404, "NOT_FOUND", "Check not found")
            return {"run": {k: row[k] for k in ("run_id", "session_id", "version_id", "state")},
                    "results": json.loads(row["result_json"])["results"] if row["result_json"] else []}

    def create_check(self, model_id, number, body, key):
        with self.transaction(write=True) as connection:
            version = self._version(connection, model_id, number)
            ids = body.get("property_ids")
            if ids is None:
                ids = [p["id"] for p in version["spec"]["properties"]]
            try:
                request = VerificationRequest(model=version["spec"], version_id=version["id"],
                                              property_ids=ids, limits=body.get("limits") or {})
            except ValidationError as error:
                raise ServiceError(422, "INVALID_CHECK", "Select existing unique properties and valid limits") from error
            def action():
                run = {"run_id": "chk_" + uuid4().hex, "session_id": version["session_id"],
                       "version_id": version["id"], "state": "queued"}
                connection.execute("INSERT INTO runs(run_id,session_id,version_id,kind,state,request_json) VALUES (?,?,?,'check','queued',?)",
                                   (run["run_id"],run["session_id"],run["version_id"],request.model_dump_json()))
                return run
            return self._idempotent(connection, f"check:{model_id}:{number}", key, body, action)

    def claim_run(self, run_id):
        with self.transaction(write=True) as connection:
            row = self._run(connection, run_id)
            if row["state"] != "queued":
                return None
            connection.execute("UPDATE runs SET state='running' WHERE run_id=?", (run_id,))
            return row

    def finish_check(self, run_id, report, artifacts=False):
        report = VerificationReport.model_validate(report)
        with self.transaction(write=True) as connection:
            row = self._run(connection, run_id)
            request = VerificationRequest.model_validate_json(row["request_json"])
            from ..verification import spec_hash
            if (report.version_id != row["version_id"] or report.spec_hash != spec_hash(request.model)
                    or [x.property_id for x in report.results] != request.property_ids
                    or report.limits != request.limits):
                raise ValueError("Checker returned results for a different request")
            if row["state"] not in ("running", "cancelling"):
                return
            state = "cancelled" if row["state"] == "cancelling" else "completed"
            connection.execute("UPDATE runs SET state=?,result_json=?,artifacts=? WHERE run_id=?",
                               (state,report.model_dump_json(),int(artifacts),run_id))

    def fail_run(self, run_id, code):
        with self.transaction(write=True) as connection:
            connection.execute("UPDATE runs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'failed' END,error_code=? WHERE run_id=? AND state IN ('queued','running','cancelling')", (code,run_id))

    def recover_runs(self):
        with self.transaction(write=True) as connection:
            connection.execute("UPDATE runs SET state='failed',error_code='SERVER_RESTARTED' WHERE state IN ('queued','running','cancelling')")

    def create_agent_run(self, session_id, body, key):
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            def action():
                if connection.execute("SELECT 1 FROM runs WHERE session_id=? AND kind='agent' AND state IN ('queued','running','cancelling')", (session_id,)).fetchone():
                    raise ServiceError(409, "SESSION_BUSY", "An agent run is already active in this session")
                run = {"run_id": "agent_" + uuid4().hex, "session_id": session_id, "version_id": None, "state": "queued"}
                connection.execute("INSERT INTO runs(run_id,session_id,kind,state,request_json) VALUES (?,?,'agent','queued',?)", (run["run_id"],session_id,json.dumps(body)))
                return run
            return self._idempotent(connection, f"agent:{session_id}", key, body, action)

    def event(self, run_id, event_type, data):
        with self.transaction(write=True) as connection:
            row = self._run(connection, run_id)
            number = connection.execute("SELECT COALESCE(MAX(event_id),0)+1 FROM run_events WHERE run_id=?", (run_id,)).fetchone()[0]
            event = {"event_id": number, "run_id": run_id, "session_id": row["session_id"], "type": event_type, "data": data}
            connection.execute("INSERT INTO run_events VALUES (?,?,?)", (run_id,number,json.dumps(event,ensure_ascii=False)))
            return event

    def events(self, run_id, after=0):
        with self.transaction() as connection:
            self._run(connection, run_id)
            latest = connection.execute("SELECT COALESCE(MAX(event_id),0) FROM run_events WHERE run_id=?", (run_id,)).fetchone()[0]
            if after > latest:
                raise ServiceError(409, "INVALID_CURSOR", "Event cursor is ahead of run history")
            return [json.loads(row[0]) for row in connection.execute("SELECT event_json FROM run_events WHERE run_id=? AND event_id>? ORDER BY event_id LIMIT 100", (run_id,after))]

    def complete_agent(self, run_id, version_id=None):
        with self.transaction(write=True) as connection:
            connection.execute("UPDATE runs SET state='completed',version_id=? WHERE run_id=? AND state='running'", (version_id,run_id))

    def save_dialogue_sources(self, session_id, sources):
        # Answers are generated by the dialogue module; preserve IDs used by source_refs.
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            for source in sources:
                if source.session_id != session_id:
                    raise ServiceError(409, "SOURCE_CONFLICT", "Source belongs to another session")
                existing = connection.execute("SELECT session_id,text FROM sources WHERE id=?", (source.id,)).fetchone()
                if existing and (existing["session_id"] != session_id or existing["text"] != source.text):
                    raise ServiceError(409, "SOURCE_CONFLICT", "Source content changed")
                from .sqlite import now
                connection.execute("INSERT OR IGNORE INTO sources(id,session_id,kind,text,created_at) VALUES (?,?,'text',?,?)", (source.id,session_id,source.text,now()))
