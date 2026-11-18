"""Opt-in Responses API acceptance harness, independent of ordinary CI.

Limits bound request count, total input characters, output tokens per request and
wall time. They are not a monetary cap. Subscription auth is never exported here.
"""
import argparse
import json
import os
import threading
import time
from pathlib import Path


class Budget:
    def __init__(self, max_calls, max_output_tokens, max_input_chars, seconds):
        if not 1 <= max_calls <= 10 or not 256 <= max_output_tokens <= 8192 or not 1000 <= max_input_chars <= 200000 or not 10 <= seconds <= 900:
            raise ValueError("Budget outside allowed bounds")
        self.max_calls, self.max_output_tokens = max_calls, max_output_tokens
        self.max_input_chars = max_input_chars
        self.deadline = time.monotonic() + seconds
        self.calls, self.input_chars = 0, 0
        self.lock = threading.Lock()

    def reserve(self, kwargs):
        size = len(json.dumps({k: kwargs.get(k) for k in ("input", "instructions", "tools", "text")}, ensure_ascii=False))
        with self.lock:
            if time.monotonic() >= self.deadline or self.calls >= self.max_calls or self.input_chars + size > self.max_input_chars:
                raise RuntimeError("PROVIDER_BUDGET_EXHAUSTED")
            self.calls += 1
            self.input_chars += size
        return {**kwargs, "max_output_tokens": self.max_output_tokens}


def install_budget(budget):
    from openai import AsyncOpenAI
    from .agent import dialogue, verification
    def factory():
        client = AsyncOpenAI(base_url=os.environ["OPENAI_BASE_URL"], api_key=os.environ["OPENAI_API_KEY"], max_retries=0,
                             timeout=min(90, max(1, budget.deadline - time.monotonic())))
        original = client.responses.create
        async def bounded(*args, **kwargs):
            # Agents SDK calls Responses with kwargs. Positional input is rejected
            # so it cannot bypass accounting.
            if args:
                raise ValueError("Positional Responses arguments are unsupported")
            return await original(**budget.reserve(kwargs))
        client.responses.create = bounded
        return client
    dialogue.create_client = factory
    verification.create_client = factory


def run_acceptance(output, budget):
    from fastapi.testclient import TestClient
    from .api.app import create_app
    from .config import Settings
    output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    case = json.loads((root / "tests/fixtures/formal_cases.json").read_text())[0]
    receipt = {"proof_level": "provider+API+SQLite+TLC", "status": "running", "model": os.environ["OPENAI_MODEL"],
               "phase": "initial_analysis", "limits": {"max_calls": budget.max_calls, "max_output_tokens_per_call": budget.max_output_tokens,
                          "max_total_input_chars": budget.max_input_chars}, "stages": []}
    settings = Settings(database_path=output / "private/db", artifacts_path=output / "private/artifacts", check_cache_path=None,
                        agent_timeout_seconds=min(630, max(1, budget.deadline - time.monotonic())))
    def save():
        receipt.update(provider_calls=budget.calls, total_input_chars=budget.input_chars)
        (output / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    try:
        with TestClient(create_app(settings)) as client:
            def post(url, body, key):
                response = client.post(url, json=body, headers={"Idempotency-Key": key})
                if response.status_code not in (200, 201, 202):
                    raise AssertionError("API_REQUEST_FAILED")
                return response.json()
            def wait(run_id):
                while time.monotonic() < budget.deadline:
                    run = client.get(f"/api/runs/{run_id}").json()
                    if run["state"] in ("completed", "failed", "cancelled"):
                        if run["state"] != "completed":
                            raise AssertionError(run.get("error_code") or "RUN_FAILED")
                        return
                    time.sleep(0.1)
                client.post(f"/api/runs/{run_id}/cancel")
                raise AssertionError("WALL_BUDGET_EXHAUSTED")
            sid = post("/api/sessions", {"title": "Provider acceptance"}, "session")["id"]
            initial = post(f"/api/sessions/{sid}/messages", {"text": case["source"]["text"]}, "initial")
            wait(initial["run_id"])
            model = client.get(f"/api/sessions/{sid}/dialogue").json()["model"]
            if not model:
                raise AssertionError("MODEL_NOT_READY")
            first_model = dict(model)
            for number, expected in ((1, "PROPERTY_VIOLATED"), (2, "PROPERTY_HOLDS")):
                if number == 2:
                    receipt["phase"] = "explicit_refinement"
                    text = ("Уточняю правила явно: Approve доступен только в Created. Cancel доступен только в Created или Approved "
                            "и устанавливает status=Cancelled, cancelled=true, approved=false. Execute по-прежнему требует approved=true. "
                            "Остальные исходные правила и свойство о запрете исполнения отменённой заявки сохранить.")
                    update = post(f"/api/sessions/{sid}/messages", {"text": text}, "refinement")
                    wait(update["run_id"])
                    view = client.get(f"/api/sessions/{sid}/dialogue").json()
                    model = view["model"]
                    if not model or model["number"] != 2 or not view["corrections"] or model["spec_hash"] == first_model["spec_hash"]:
                        raise AssertionError("EXPLICIT_REVISION_MISSING")
                receipt["phase"] = f"check_version_{number}"
                version = client.get(f"/api/models/{model['model_id']}/versions/{number}").json()
                run = post(f"/api/models/{model['model_id']}/versions/{number}/checks", {"explain": number == 1}, f"check-{number}")
                wait(run["run_id"])
                while True:
                    report = client.get(f"/api/checks/{run['run_id']}").json()
                    if number == 2 or report["explanation"]["state"] in ("ready", "failed", "cancelled"):
                        break
                    if time.monotonic() >= budget.deadline:
                        raise AssertionError("EXPLANATION_TIMEOUT")
                    time.sleep(0.1)
                if number == 1 and report["explanation"]["state"] != "ready":
                    raise AssertionError("EXPLANATION_NOT_READY")
                results = report["results"]
                if not results or any(not r["conclusive"] or r["engine"]["name"] != "TLC" for r in results):
                    raise AssertionError("TLC_INCONCLUSIVE")
                if number == 1:
                    violated = [r for r in results if r["status"] == expected and r["trace"] and
                                r["trace"][-1]["state"].get("cancelled") is True and r["trace"][-1]["state"].get("status") == "Executed"]
                    if not violated:
                        raise AssertionError("COUNTEREXAMPLE_MISSING")
                    target = violated[0]["property_id"]
                    original_property = next(p for p in version["spec"]["properties"] if p["id"] == target)
                    before = report
                else:
                    revised_property = next((p for p in version["spec"]["properties"] if p["id"] == target), None)
                    if revised_property is None or any(revised_property[field] != original_property[field] for field in ("kind", "predicate")):
                        raise AssertionError("PROPERTY_CHANGED_DURING_REFINEMENT")
                    if not any(r["property_id"] == target and r["status"] == expected for r in results):
                        raise AssertionError("REVISED_PROPERTY_NOT_PROVED")
                    if client.get(f"/api/checks/{before['run']['run_id']}").json() != before:
                        raise AssertionError("OLD_REPORT_CHANGED")
                receipt["stages"].append({"version_id": model["version_id"], "spec_hash": model["spec_hash"],
                    "check_run_id": run["run_id"], "statuses": {r["property_id"]: r["status"] for r in results},
                    "explanation": report["explanation"]["state"]})
                save()
        receipt["status"] = "passed"
    except Exception as error:
        # No raw provider response, exception text, endpoint, key or auth files.
        receipt.update(status="failed", error_type=type(error).__name__)
        import re
        if isinstance(error, AssertionError) and re.fullmatch(r"[A-Z_]{1,80}", str(error)):
            receipt["error_code"] = str(error)
    finally:
        save()
    return 0 if receipt["status"] == "passed" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-provider-spend", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-calls", type=int, default=6)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--max-input-chars", type=int, default=150000)
    parser.add_argument("--seconds", type=int, default=600)
    args = parser.parse_args(argv)
    if os.getenv("PROVERYALKA_LLM_PROVIDER") != "openai" or not all(os.getenv(k) for k in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL")):
        parser.error("Explicit openai provider, endpoint, model and API secret are required; subscription auth is unsupported in this lane")
    budget = Budget(args.max_calls, args.max_output_tokens, args.max_input_chars, args.seconds)
    install_budget(budget)
    return run_acceptance(args.output.resolve(), budget)


if __name__ == "__main__":
    raise SystemExit(main())
