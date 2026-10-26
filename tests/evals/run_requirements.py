import argparse
import asyncio
import hashlib
import json
import time
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path

from proveryalka.agent import extraction
from proveryalka.agent.prompts import ANALYST_INSTRUCTIONS
from proveryalka.contracts import Source


ROOT = Path(__file__).resolve().parents[2]
CURRENT = ContextVar("evaluation_run")
CREATE_CLIENT = extraction.create_client
BUILD_ANALYSIS = extraction.build_analysis


def create_client():
    client = CREATE_CLIENT()
    create_response = client.responses.create

    async def capture_response(*args, **kwargs):
        if CURRENT.get().get("fresh_requested"):
            kwargs["extra_body"] = {**(kwargs.get("extra_body") or {}), "cache": {"no-cache": True, "no-store": True}}
        response = await create_response(*args, **kwargs)
        CURRENT.get()["provider_response"] = response.model_dump(mode="json")
        return response

    client.responses.create = capture_response
    return client


def build_analysis(source, draft):
    CURRENT.get()["draft"] = draft.model_dump(mode="json")
    return BUILD_ANALYSIS(source, draft)


async def main(selected, dataset="tests/fixtures/live_requirements_cases.json", fresh=False, repeats=True):
    cases = json.loads((ROOT / dataset).read_text(encoding="utf-8"))
    if selected:
        cases = [case for case in cases if case["id"] in selected]
    started = datetime.now(timezone.utc)
    destination = ROOT / "junk" / ("requirements-eval-" + started.strftime("%Y%m%dT%H%M%SZ"))
    destination.mkdir(parents=True)
    report = {
        "started_at": started.isoformat(),
        "requested_model": "deepseek-v4.1-flash",
        "timeout_seconds": 300,
        "max_retries": 0,
        "concurrency": 2,
        "dataset": dataset,
        "fresh_requested": fresh,
        "prompt_sha256": hashlib.sha256(ANALYST_INSTRUCTIONS.encode()).hexdigest(),
        "instructions": ANALYST_INSTRUCTIONS,
        "cases": cases,
        "runs": [],
    }
    semaphore = asyncio.Semaphore(2)

    def save():
        (destination / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    async def run(case, repetition):
        async with semaphore:
            record = {"case_id": case["id"], "repetition": repetition, "fresh_requested": fresh}
            token = CURRENT.set(record)
            begin = time.monotonic()
            try:
                source = Source(id="live-" + case["id"], session_id="live-evaluation", text=case["text"])
                result = await extraction.extract_requirements(source)
                record["analysis"] = result.model_dump(mode="json")
                record["questions"] = result.missing_information
                record["question_count"] = len(result.missing_information)
                record["status"] = "completed"
            except Exception as error:
                record["status"] = "error"
                record["error_type"] = type(error).__name__
                if isinstance(error, ValueError):
                    record["error_message"] = str(error)[:500]
                if getattr(error, "status_code", None):
                    record["http_status"] = error.status_code
            finally:
                record["elapsed_seconds"] = round(time.monotonic() - begin, 2)
                CURRENT.reset(token)
            report["runs"].append(record)
            save()
            response = record.get("provider_response", {})
            print(json.dumps({
                "case": case["id"],
                "repetition": repetition,
                "status": record["status"],
                "model_reported_by_provider": response.get("model"),
                "seconds": record["elapsed_seconds"],
                "error_type": record.get("error_type"),
                "question_count": record.get("question_count"),
            }, ensure_ascii=False), flush=True)

    extraction.create_client = create_client
    extraction.build_analysis = build_analysis
    save()
    print(str(destination), flush=True)
    jobs = [(case, 1) for case in cases]
    if repeats:
        jobs += [(case, 2) for case in cases if case["id"] in {"barbershop", "payment_retry"}]
    await asyncio.gather(*(run(case, repetition) for case, repetition in jobs))
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", nargs="+")
    parser.add_argument("--dataset", default="tests/fixtures/live_requirements_cases.json")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--no-repeats", action="store_true")
    arguments = parser.parse_args()
    asyncio.run(main(arguments.cases, arguments.dataset, arguments.fresh, not arguments.no_repeats))
