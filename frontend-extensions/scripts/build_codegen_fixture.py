"""Собирает запись реального прогона генератора для тестов и демо #49.

Источник — reports/project-review-20261031/codegen (evidence.py генератора, коммит
dbbf757): настоящие ответы HTTP API генерации, файлы экспортированного проекта,
ZIP сервера, прогоны pytest в Docker-песочнице и их журналы. Ничего не дописывается,
кроме ответа GET /api/codegen/status: его evidence.py не сохранял, поэтому он
собирается из receipt.sandbox и значений по умолчанию из контракта (помечено).

Запуск: python3 -I scripts/build_codegen_fixture.py <каталог reports/.../codegen>
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "fixtures" / "codegen-recording.json"


def main():
    source = Path(sys.argv[1]).resolve()
    receipt = json.loads((source / "receipt.json").read_text(encoding="utf-8"))
    fixed, bug = receipt["order_fixed"], receipt["order_bug"]
    generation = fixed["generation"]
    project = source / "order_fixed-project"
    files = {}
    for entry in generation["files"]:
        data = (project / entry["path"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["path"]
        files[entry["path"]] = data.decode("utf-8")
    archive_path = source / f"{generation['project_name']}-{generation['generation_id']}.zip"
    archive = archive_path.read_bytes()
    assert hashlib.sha256(archive).hexdigest() == fixed["archive"]["sha256"]
    spec = json.loads(files["model/behavioral_model.json"])

    def version_of(item, spec_value):
        g = item["generation"]
        return {
            "id": item["version"]["version_id"], "model_id": item["model_id"], "session_id": item["session_id"],
            "number": g["version_number"], "parent_id": None, "spec": spec_value,
            "spec_hash": item["version"]["spec_hash"], "approved": item["version"]["approved"],
        }

    recording = {
        "_provenance": {
            "source": "reports/project-review-20261031/codegen (receipt.json, order_fixed-project, ZIP, *.log)",
            "generator_head": receipt["worktree_head"],
            "worktree_dirty": receipt["worktree_dirty"],
            "recorded_at": receipt["finished_at"],
            "status_note": "GET /api/codegen/status не записан evidence.py; ответ собран из receipt.sandbox и значений по умолчанию контракта",
            "order_bug_files": "содержимое файлов order_bug не экспортировано; доступны метаданные генерации, ответ 409 и прогон тестов",
        },
        "status": {
            "target": generation["target"], "generator": generation["generator"],
            "technical_conditions": generation["technical_conditions"], "limits": {},
            "sandbox_status": "ready", "sandbox_reason": None, "sandbox": receipt["sandbox"],
            "default_timeout_seconds": 120.0, "max_timeout_seconds": 600.0,
        },
        "versions": [version_of(fixed, spec), version_of(bug, None)],
        "generations": [generation, bug["generation"]],
        "verification_required": {
            f"{bug['model_id']}/{bug['generation']['version_number']}": bug["generation_without_ack"]["body"],
        },
        "files": {generation["generation_id"]: files},
        "archives": {
            generation["generation_id"]: {
                "base64": base64.b64encode(archive).decode("ascii"),
                "file_name": archive_path.name,
                "code_hash": generation["code_hash"],
            }
        },
        "test_runs": {
            generation["generation_id"]: [fixed["test_run"]],
            bug["generation"]["generation_id"]: [bug["test_run"]],
        },
        "logs": {
            fixed["test_run"]["test_run_id"]: fixed["test_log"] if "test_log" in fixed else (source / "order_fixed-test-run.log").read_text(encoding="utf-8"),
            bug["test_run"]["test_run_id"]: bug["test_log"] if "test_log" in bug else (source / "order_bug-test-run.log").read_text(encoding="utf-8"),
        },
        "failed_gate": receipt["sandbox_gates"]["wrong_implementation_cancel_keeps_approved"]["result"],
    }
    OUT.write_text(json.dumps(recording, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(OUT.relative_to(ROOT), OUT.stat().st_size, "bytes")


main()
