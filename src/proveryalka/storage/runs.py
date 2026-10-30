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
