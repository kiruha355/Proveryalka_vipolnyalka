"""Prepare a bounded snapshot and the reference cases for one comparison."""
import json
import re

from ..services import ServiceError
from ..sources.repositories.index import digest, manifest_hash
from ..storage.repositories import RepositoryStore
from .comparison_harness import HARNESS
from .paths import UnsafePath, safe_path
from .project import GeneratedFile, code_hash
from .templates import PYTEST_INI

OUTCOMES = {"not_enabled": (409, "TRANSITION_NOT_ENABLED"), "out_of_domain": (409, "EFFECT_OUT_OF_DOMAIN")}
CASE_NAME = re.compile(r"test_transition\[(case_[0-9]+)\]")


def snapshot_files(store, session_id, snapshot_id, manifest):
    snapshot, contents = RepositoryStore(store).read_contents(session_id, snapshot_id)
    items = snapshot["files"]
    if (snapshot["manifest_sha256"] != manifest
            or manifest_hash(snapshot["remote_url"], snapshot["commit_sha"], items, snapshot["excluded"]) != manifest
            or set(contents) != {item["path"] for item in items}):
        raise ServiceError(409, "SNAPSHOT_HASH_MISMATCH", "Snapshot does not match the pinned manifest")
    files = []
    folded = set()
    for item in items:
        path = item["path"]
        try:
            safe_path(f"candidate/{path}", snapshot=True)
        except UnsafePath as error:
            raise ServiceError(422, "UNSUPPORTED_SNAPSHOT_PATH", "Snapshot contains a path unsupported by the sandbox") from error
        if path.casefold() in folded:
            raise ServiceError(422, "UNSUPPORTED_SNAPSHOT_PATH", "Snapshot paths collide on a case-insensitive filesystem")
        folded.add(path.casefold())
        content = contents[path].encode("utf-8")
        if len(content) != item["size_bytes"] or digest(content) != item["sha256"]:
            raise ServiceError(409, "SNAPSHOT_HASH_MISMATCH", "Snapshot file contents do not match the pinned manifest")
        files.append(GeneratedFile(path, content, "", ""))
    if any("/".join(path.split("/")[:depth]) in folded
           for path in folded for depth in range(1, len(path.split("/")))):
        raise ServiceError(422, "UNSUPPORTED_SNAPSHOT_PATH", "Snapshot files collide with a directory")
    return snapshot, files


def reference_cases(files):
    project = {item.path: item.content for item in files}
    reference = json.loads(project["tests/data/conformance.json"])
    model = json.loads(project["model/behavioral_model.json"])
    transitions = {item["id"]: item["requirement_ids"] for item in model["transitions"]}
    variables = {item["id"]: item["requirement_ids"] for item in model["variables"]}
    unknown = "unknown transition outside BehavioralModel identifiers"
    cases = []

    def add(scenario, state, transition, status, expected, requirements=()):
        cases.append({"key": f"case_{len(cases)}", "scenario_id": scenario, "state": state,
                      "transition": transition, "status": status, "expected": expected,
                      "requirement_ids": list(requirements)})

    add("unknown-transition", reference["initial_state"], unknown, 404, "UNKNOWN_TRANSITION")
    for row in reference["rows"]:
        status, expected = (200, row["next"]) if row["outcome"] == "applied" else OUTCOMES[row["outcome"]]
        add(row["id"], row["state"], row["transition"], status, expected, transitions[row["transition"]])
    for invalid in reference["invalid_states"]:
        add(invalid["id"], invalid["state"], unknown, 422, "INVALID_STATE", variables.get(invalid["variable"], []))
    for trace in reference["traces"]:
        for step, (before, after) in enumerate(zip(trace["steps"], trace["steps"][1:]), start=1):
            transition = after["transition_id"]
            add(f"{trace['property_id']}-trace-{step}", before["state"], transition, 200,
                after["state"], transitions[transition])
    return cases


def prepare(store, record, reference_files, request):
    if request["reference_code_hash"] != record["code_hash"]:
        raise ServiceError(409, "GENERATION_REF_MISMATCH", "Reference does not match the stored generation")
    snapshot, candidate = snapshot_files(store, record["session_id"], request["snapshot_id"], request["manifest_sha256"])
    cases = reference_cases(reference_files)
    if len(cases) > 5000:
        raise ServiceError(422, "COMPARISON_CASE_LIMIT", "Reference exceeds the sandbox limit of 5000 cases")
    trusted = [
        GeneratedFile("pytest.ini", PYTEST_INI.encode(), "", ""),
        GeneratedFile("tests/test_comparison.py", HARNESS.encode(), "", ""),
        GeneratedFile("tests/expected.json", json.dumps(cases, ensure_ascii=False, sort_keys=True).encode(), "", ""),
    ]
    comparison = {
        "snapshot_id": snapshot["id"], "manifest_sha256": snapshot["manifest_sha256"], "commit_sha": snapshot["commit_sha"],
        "reference_code_hash": record["code_hash"], "adapter": request["adapter"],
        "code_hash": code_hash(candidate), "tests_hash": code_hash(trusted),
    }
    job = [(f"candidate/{item.path}", item.content) for item in candidate]
    job.extend((item.path, item.content) for item in trusted)
    job.append(("adapter.json", json.dumps(comparison["adapter"], sort_keys=True).encode()))
    return comparison, job, {case["key"]: case for case in cases}


def comparison_result(result, cases):
    differences = []
    statuses = set()
    if result["status"] == "passed":
        # The first case is the adapter probe. Everything else must be collected and run.
        status = "matches" if result["counts"]["passed"] == len(cases) else "execution_error"
        return {"status": status, "differences": []}
    if result["error_code"] != "TESTS_FAILED":
        return {"status": "execution_error", "differences": []}
    for case in result["cases"]:
        if case["outcome"] == "error":
            statuses.add("execution_error")
        if case["outcome"] != "failed":
            continue
        message = case["message"] or ""
        if "EXECUTION_ERROR:" in message:
            statuses.add("execution_error")
        elif "INCOMPATIBLE_ADAPTER:" in message:
            statuses.add("incompatible_adapter")
        else:
            match = CASE_NAME.fullmatch(case["name"])
            expected = cases.get(match[1]) if match else None
            if expected is None:
                statuses.add("execution_error")
                continue
            statuses.add("mismatch")
            differences.append({
                "scenario_id": expected["scenario_id"],
                "transition_id": None if expected["status"] == 422 else expected["transition"],
                "requirement_ids": expected["requirement_ids"], "message": case["message"],
            })
    status = next((item for item in ("execution_error", "incompatible_adapter", "mismatch") if item in statuses),
                  "execution_error")
    return {"status": status, "differences": differences}
