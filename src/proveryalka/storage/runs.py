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
            return {k: row[k] for k in ("run_id", "session_id", "version_id", "state", "error_code")}

    def get_check(self, run_id):
        with self.transaction() as connection:
            row = self._run(connection, run_id)
            if row["kind"] != "check":
                raise ServiceError(404, "NOT_FOUND", "Check not found")
            return {"run": {k: row[k] for k in ("run_id", "session_id", "version_id", "state", "error_code")},
                    "results": json.loads(row["result_json"])["results"] if row["result_json"] else [],
                    "explanation": self._explanation(connection, run_id)}

    @staticmethod
    def _explanation(connection, check_run_id):
        row = connection.execute(
            "SELECT run_id,state,error_code,result_json FROM runs WHERE parent_run_id=? AND kind='explain' ORDER BY rowid DESC LIMIT 1",
            (check_run_id,),
        ).fetchone()
        if row is None:
            return {"state": "not_requested", "run_id": None, "error_code": None, "narrative": None}
        state = {"queued": "queued", "running": "running", "cancelling": "running", "completed": "ready"}.get(row["state"], row["state"])
        return {"state": state, "run_id": row["run_id"], "error_code": row["error_code"],
                "narrative": json.loads(row["result_json"]) if row["state"] == "completed" and row["result_json"] else None}

    def check_record(self, run_id):
        with self.transaction() as connection:
            row = self._run(connection, run_id)
            if row["kind"] != "check":
                raise ServiceError(404, "NOT_FOUND", "Check not found")
            return row

    def create_explanation(self, check_run_id, key):
        """Объяснение сохранённого отчёта отдельным запуском: TLC не повторяется."""
        with self.transaction(write=True) as connection:
            check = self._run(connection, check_run_id)
            if check["kind"] != "check":
                raise ServiceError(404, "NOT_FOUND", "Check not found")
            body = {"check_run_id": check_run_id}

            def action():
                if check["state"] != "completed" or not check["result_json"]:
                    raise ServiceError(409, "CHECK_PENDING", "Check has no saved report")
                if not VerificationReport.model_validate_json(check["result_json"]).executed:
                    raise ServiceError(409, "NOT_EXPLAINABLE", "The engine did not run; there is nothing to explain")
                current = self._explanation(connection, check_run_id)["state"]
                if current in ("queued", "running"):
                    raise ServiceError(409, "EXPLANATION_ACTIVE", "Explanation is already running")
                if current == "ready":
                    raise ServiceError(409, "EXPLANATION_READY", "Explanation is already saved")
                self.check_capacity(connection)
                run = {"run_id": "exp_" + uuid4().hex, "session_id": check["session_id"],
                       "version_id": check["version_id"], "state": "queued"}
                connection.execute(
                    "INSERT INTO runs(run_id,session_id,version_id,kind,state,request_json,parent_run_id) VALUES (?,?,?,'explain','queued',?,?)",
                    (run["run_id"], run["session_id"], run["version_id"], json.dumps(body), check_run_id),
                )
                return run
            return self._idempotent(connection, f"explain:{check_run_id}", key, body, action)

    def finish_explanation(self, run_id, narrative):
        with self.transaction(write=True) as connection:
            return connection.execute("UPDATE runs SET state='completed',result_json=? WHERE run_id=? AND state='running'", (narrative, run_id)).rowcount == 1

    def active_agent_run(self, session_id):
        with self.transaction() as connection:
            row = connection.execute("SELECT run_id FROM runs WHERE session_id=? AND kind='agent' AND state IN ('queued','running','cancelling')", (session_id,)).fetchone()
            return row["run_id"] if row else None

    def analyst_version(self, session_id, model_hash):
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT v.id,v.model_id,v.number,v.spec_hash FROM model_versions v JOIN models m ON m.id=v.model_id "
                "WHERE m.session_id=? AND v.spec_hash=? ORDER BY v.rowid DESC LIMIT 1", (session_id, model_hash),
            ).fetchone()
            return None if row is None else {"model_id": row["model_id"], "version_id": row["id"], "number": row["number"], "spec_hash": row["spec_hash"]}

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
                self.check_capacity(connection)
                run = {"run_id": "chk_" + uuid4().hex, "session_id": version["session_id"],
                       "version_id": version["id"], "state": "queued"}
                connection.execute("INSERT INTO runs(run_id,session_id,version_id,kind,state,request_json,explain) VALUES (?,?,?,'check','queued',?,?)",
                                   (run["run_id"],run["session_id"],run["version_id"],request.model_dump_json(),int(bool(body.get("explain")))))
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
        # Код отмены, записанный request_cancel, сохраняется: по нему клиент отличает отмену от остановки сервера.
        with self.transaction(write=True) as connection:
            connection.execute("UPDATE runs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'failed' END,"
                               "error_code=CASE WHEN state='cancelling' AND error_code IS NOT NULL THEN error_code ELSE ? END "
                               "WHERE run_id=? AND state IN ('queued','running','cancelling')", (code,run_id))

    def recover_runs(self):
        with self.transaction(write=True) as connection:
            connection.execute("UPDATE runs SET state='failed',error_code='SERVER_RESTARTED' WHERE state IN ('queued','running','cancelling')")

    def idempotent_response(self, scope, key, body):
        """Сохранённый ответ на повтор ключа, чтобы проверки состояния не мешали повтору."""
        from .sqlite import encode
        with self.transaction() as connection:
            row = connection.execute("SELECT request_json,response_json FROM idempotency WHERE scope=? AND key=?", (scope, key)).fetchone()
        if row is None:
            return None
        if row["request_json"] != encode(body):
            raise ServiceError(409, "IDEMPOTENCY_CONFLICT", "Key already used with a different request")
        return json.loads(row["response_json"])

    def create_agent_run(self, session_id, body, key):
        with self.transaction(write=True) as connection:
            self._session(connection, session_id)
            def action():
                self.check_capacity(connection)
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

    def check_capacity(self, connection):
        count = connection.execute("SELECT COUNT(*) FROM runs WHERE state IN ('queued','running','cancelling')").fetchone()[0]
        if count >= getattr(self, "max_pending_runs", 32):
            raise ServiceError(429, "QUEUE_FULL", "Run queue is full; retry later")

    def request_cancel(self, run_id, code="CANCELLED"):
        # CANCELLED — явная отмена пользователем; SERVER_SHUTDOWN — остановка сервера, ход можно повторить.
        with self.transaction(write=True) as connection:
            row = self._run(connection, run_id)
            if row["state"] in ("queued", "running"):
                connection.execute("UPDATE runs SET state='cancelling',error_code=? WHERE run_id=?", (code, run_id))
        return self.get_run(run_id)

    def finalize_events(self, run_id):
        with self.transaction(write=True) as connection:
            row = self._run(connection, run_id)
            if row["state"] == "cancelling":
                connection.execute("UPDATE runs SET state='cancelled' WHERE run_id=?", (run_id,))
                row["state"] = "cancelled"
            if row["state"] not in ('completed','failed','cancelled'):
                return
            existing = [json.loads(r[0])["type"] for r in connection.execute("SELECT event_json FROM run_events WHERE run_id=?",(run_id,))]
            if "run_finished" in existing:
                return
            events = []
            if row["error_code"]:
                events.append(("error", {"code":row["error_code"],"message":"Run stopped; saved history is available"}))
            events.append(("run_finished", {"state":row["state"]}))
            number = connection.execute("SELECT COALESCE(MAX(event_id),0) FROM run_events WHERE run_id=?",(run_id,)).fetchone()[0]
            for kind,data in events:
                number += 1
                event = {"event_id":number,"run_id":run_id,"session_id":row["session_id"],"type":kind,"data":data}
                connection.execute("INSERT INTO run_events VALUES (?,?,?)",(run_id,number,json.dumps(event)))

    def terminal_event_id(self, run_id):
        with self.transaction() as connection:
            row = connection.execute("SELECT event_id,event_json FROM run_events WHERE run_id=? ORDER BY event_id DESC LIMIT 1",(run_id,)).fetchone()
            return row[0] if row is not None and json.loads(row[1])["type"] == "run_finished" else None
