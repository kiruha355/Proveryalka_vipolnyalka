"""Хранение генераций кода, их файлов и запусков тестов (таблицы миграции 006).

Файлы лежат в SQLite вместе с SHA-256; наружу выдаются только пути из записи генерации.
"""
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from ..services import ServiceError
from ..verification.contracts import VerificationReport
from .sqlite import encode, now


MIGRATION = Path(__file__).with_name("migrations") / "006_codegen.sql"
TERMINAL = ("passed", "failed", "timeout", "engine_unavailable", "cancelled", "error")
UNKNOWN_COUNTS = {"total": None, "passed": None, "failed": None, "errors": None, "skipped": None}


def ensure_schema(store):
    """Идемпотентно создаёт таблицы 006 (CREATE ... IF NOT EXISTS), не меняя PRAGMA user_version."""
    with store.transaction(write=True) as connection:
        for statement in MIGRATION.read_text(encoding="utf-8").split(";"):
            if statement.strip():
                connection.execute(statement)


def verification_snapshot(connection, version):
    """Последний завершённый результат TLC по каждому свойству этой версии с тем же spec_hash."""
    properties = [prop["id"] for prop in version["spec"]["properties"]]
    kinds = {prop["id"]: prop["kind"] for prop in version["spec"]["properties"]}
    found = {}
    rows = connection.execute(
        "SELECT run_id,result_json FROM runs WHERE kind='check' AND version_id=? AND state='completed' AND result_json IS NOT NULL ORDER BY rowid DESC",
        (version["id"],),
    )
    for row in rows:
        try:
            report = VerificationReport.model_validate_json(row["result_json"])
        except ValidationError:
            continue
        if report.spec_hash != version["spec_hash"]:
            continue
        for result in report.results:
            found.setdefault(result.property_id, (row["run_id"], result))
    items, traces = [], []
    for property_id in properties:
        run_id, result = found.get(property_id, (None, None))
        items.append({"property_id": property_id, "status": result.status if result else None, "check_run_id": run_id})
        if result is not None and result.trace:
            traces.append({"property_id": property_id, "status": result.status, "kind": kinds[property_id], "check_run_id": run_id,
                           "steps": [{"transition_id": step.transition_id, "state": step.state} for step in result.trace]})
    statuses = [item["status"] for item in items]
    if not any(statuses):
        state = "not_checked"
    elif "PROPERTY_VIOLATED" in statuses:
        state = "violated"
    elif all(status == "PROPERTY_HOLDS" for status in statuses):
        state = "holds"
    else:
        state = "inconclusive"
    return {"state": state, "properties": items, "traces": traces}


class CodegenStore:
    def __init__(self, store):
        self.store = store

    def transaction(self, write=False):
        return self.store.transaction(write=write)

    # Генерации

    def version(self, model_id, number):
        with self.transaction() as connection:
            version = self.store._version(connection, model_id, number)
            return version, verification_snapshot(connection, version)

    def replay(self, scope, key, body):
        """Повтор с тем же ключом возвращает исходный ответ до любых новых проверок."""
        with self.transaction() as connection:
            previous = connection.execute("SELECT request_json,response_json FROM idempotency WHERE scope=? AND key=?", (scope, key)).fetchone()
        if previous is None:
            return None
        if previous["request_json"] != encode(body):
            raise ServiceError(409, "IDEMPOTENCY_CONFLICT", "Key already used with a different request")
        return json.loads(previous["response_json"])

    def save_generation(self, scope, key, body, version, record, files):
        with self.transaction(write=True) as connection:
            def action():
                current = self.store._version(connection, version["model_id"], version["number"])
                if current["spec_hash"] != version["spec_hash"] or not current["approved"]:
                    raise ServiceError(409, "VERSION_CHANGED", "Version changed during generation")
                connection.execute(
                    "INSERT INTO codegen_generations(generation_id,session_id,model_id,version_id,version_number,spec_hash,code_hash,target,generator_version,record_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (record["generation_id"], record["session_id"], record["model_id"], record["version_id"], record["version_number"],
                     record["spec_hash"], record["code_hash"], record["target"], record["generator"]["version"], encode(record), record["created_at"]),
                )
                for item in files:
                    entry = item.entry()
                    connection.execute("INSERT INTO codegen_files VALUES (?,?,?,?,?,?)",
                                       (record["generation_id"], item.path, len(item.content), item.sha256, encode(entry), item.content))
                return self._generation(connection, record["generation_id"])
            return self.store._idempotent(connection, scope, key, body, action)

    @staticmethod
    def _entries(connection, generation_id):
        return [json.loads(row["entry_json"]) for row in connection.execute(
            "SELECT entry_json FROM codegen_files WHERE generation_id=? ORDER BY path", (generation_id,))]

    def _generation(self, connection, generation_id):
        row = connection.execute("SELECT record_json FROM codegen_generations WHERE generation_id=?", (generation_id,)).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Generation not found")
        return {**json.loads(row["record_json"]), "files": self._entries(connection, generation_id)}

    def get_generation(self, generation_id):
        with self.transaction() as connection:
            return self._generation(connection, generation_id)

    def list_for_version(self, model_id, number):
        with self.transaction() as connection:
            version = self.store._version(connection, model_id, number)
            ids = [row[0] for row in connection.execute(
                "SELECT generation_id FROM codegen_generations WHERE version_id=? ORDER BY created_at,rowid", (version["id"],))]
            return [self._generation(connection, generation_id) for generation_id in ids]

    def list_for_session(self, session_id):
        with self.transaction() as connection:
            self.store._session(connection, session_id)
            ids = [row[0] for row in connection.execute(
                "SELECT generation_id FROM codegen_generations WHERE session_id=? ORDER BY created_at,rowid", (session_id,))]
            return [self._generation(connection, generation_id) for generation_id in ids]

    def files(self, generation_id):
        return self.get_generation(generation_id)["files"]

    def file(self, generation_id, path):
        with self.transaction() as connection:
            self._generation(connection, generation_id)
            row = connection.execute("SELECT * FROM codegen_files WHERE generation_id=? AND path=?", (generation_id, path)).fetchone()
        if row is None:
            raise ServiceError(404, "FILE_NOT_FOUND", "File is not part of this generation")
        content = bytes(row["content"])
        if len(content) != row["size"] or hashlib.sha256(content).hexdigest() != row["sha256"]:
            raise ServiceError(409, "INTEGRITY_MISMATCH", "Stored file does not match its SHA-256")
        return json.loads(row["entry_json"]), content

    def project(self, generation_id):
        """Все файлы генерации с проверкой SHA-256 и code_hash записи."""
        from ..codegen.project import GeneratedFile, code_hash
        with self.transaction() as connection:
            record = self._generation(connection, generation_id)
            rows = list(connection.execute("SELECT path,size,sha256,content FROM codegen_files WHERE generation_id=? ORDER BY path", (generation_id,)))
        files = []
        for row in rows:
            content = bytes(row["content"])
            if len(content) != row["size"] or hashlib.sha256(content).hexdigest() != row["sha256"]:
                raise ServiceError(409, "INTEGRITY_MISMATCH", f"Stored file {row['path']} does not match its SHA-256")
            files.append(GeneratedFile(row["path"], content, "", ""))
        if code_hash(files) != record["code_hash"]:
            raise ServiceError(409, "INTEGRITY_MISMATCH", "Stored files do not match code_hash")
        return record, files

    # Запуски тестов

    def _test_run(self, connection, test_run_id):
        row = connection.execute(
            "SELECT t.*,g.version_id,g.spec_hash,g.code_hash FROM codegen_test_runs t JOIN codegen_generations g ON g.generation_id=t.generation_id WHERE t.test_run_id=?",
            (test_run_id,),
        ).fetchone()
        if row is None:
            raise ServiceError(404, "NOT_FOUND", "Test run not found")
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        return {
            "test_run_id": row["test_run_id"], "generation_id": row["generation_id"], "session_id": row["session_id"],
            "version_id": row["version_id"], "spec_hash": row["spec_hash"], "code_hash": row["code_hash"],
            "status": row["status"], "error_code": row["error_code"], "message": result.get("message"),
            "cancel_requested": bool(row["cancel_requested"]), "timeout_seconds": row["timeout_seconds"],
            "created_at": row["created_at"], "started_at": row["started_at"], "finished_at": row["finished_at"],
            "duration_seconds": result.get("duration_seconds"), "exit_code": result.get("exit_code"),
            "counts": result.get("counts") or dict(UNKNOWN_COUNTS), "cases": result.get("cases", []),
            "sandbox": result.get("sandbox"), "log_available": row["log"] is not None,
            "log_truncated": result.get("log_truncated"),
        }

    def get_test_run(self, test_run_id):
        with self.transaction() as connection:
            return self._test_run(connection, test_run_id)

    def list_test_runs(self, generation_id):
        with self.transaction() as connection:
            self._generation(connection, generation_id)
            ids = [row[0] for row in connection.execute(
                "SELECT test_run_id FROM codegen_test_runs WHERE generation_id=? ORDER BY created_at,rowid", (generation_id,))]
            return [self._test_run(connection, test_run_id) for test_run_id in ids]

    def create_test_run(self, generation_id, body, key, timeout_seconds, max_pending):
        with self.transaction(write=True) as connection:
            record = self._generation(connection, generation_id)

            def action():
                pending = connection.execute("SELECT COUNT(*) FROM codegen_test_runs WHERE status IN ('queued','running')").fetchone()[0]
                if pending >= max_pending:
                    raise ServiceError(429, "QUEUE_FULL", "Test run queue is full; retry later")
                test_run_id = "trun_" + uuid4().hex
                connection.execute(
                    "INSERT INTO codegen_test_runs(test_run_id,generation_id,session_id,status,timeout_seconds,created_at) VALUES (?,?,?,'queued',?,?)",
                    (test_run_id, generation_id, record["session_id"], timeout_seconds, now()),
                )
                return self._test_run(connection, test_run_id)
            return self.store._idempotent(connection, f"codegen:test:{generation_id}", key, body, action)

    def claim_test_run(self, test_run_id):
        with self.transaction(write=True) as connection:
            row = connection.execute("SELECT * FROM codegen_test_runs WHERE test_run_id=?", (test_run_id,)).fetchone()
            if row is None or row["status"] != "queued" or row["cancel_requested"]:
                return None
            connection.execute("UPDATE codegen_test_runs SET status='running',started_at=? WHERE test_run_id=?", (now(), test_run_id))
            return dict(row)

    def finish_test_run(self, test_run_id, status, error_code=None, result=None, log=None):
        if status not in TERMINAL:
            raise ValueError(f"Not a terminal status: {status}")
        with self.transaction(write=True) as connection:
            row = connection.execute("SELECT status,cancel_requested FROM codegen_test_runs WHERE test_run_id=?", (test_run_id,)).fetchone()
            if row is None or row["status"] in TERMINAL:
                return
            connection.execute(
                "UPDATE codegen_test_runs SET status=?,error_code=?,result_json=?,log=?,finished_at=? WHERE test_run_id=?",
                (status, error_code, encode(result) if result is not None else None, log, now(), test_run_id),
            )

    def request_cancel(self, test_run_id):
        """queued → cancelled сразу; running → флаг отмены, контейнер останавливает исполнитель."""
        with self.transaction(write=True) as connection:
            run = self._test_run(connection, test_run_id)
            if run["status"] == "queued":
                connection.execute("UPDATE codegen_test_runs SET status='cancelled',cancel_requested=1,error_code='CANCELLED',finished_at=? WHERE test_run_id=?", (now(), test_run_id))
            elif run["status"] == "running":
                connection.execute("UPDATE codegen_test_runs SET cancel_requested=1 WHERE test_run_id=?", (test_run_id,))
            return self._test_run(connection, test_run_id)

    def recover(self):
        with self.transaction(write=True) as connection:
            connection.execute("UPDATE codegen_test_runs SET status='error',error_code='SERVER_RESTARTED',finished_at=? WHERE status IN ('queued','running')", (now(),))

    def log(self, test_run_id):
        with self.transaction() as connection:
            run = self._test_run(connection, test_run_id)
            if run["status"] not in TERMINAL:
                raise ServiceError(409, "TEST_RUN_PENDING", "Test run has not finished")
            row = connection.execute("SELECT log FROM codegen_test_runs WHERE test_run_id=?", (test_run_id,)).fetchone()
            if row["log"] is None:
                raise ServiceError(404, "LOG_NOT_FOUND", "No log was recorded for this test run")
            return row["log"]
