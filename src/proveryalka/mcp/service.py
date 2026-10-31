"""MCP facade над ApplicationBackend и CodegenService, без отдельного checker/executor."""
import asyncio
import json
import logging
from uuid import uuid4

import anyio
from pydantic import ValidationError

from ..behavior import BehavioralModel
from ..services import ServiceError
from ..verification import spec_hash
from .dto import ModelRef, ToolResult

logger = logging.getLogger(__name__)
TERMINAL_CHECK = {"completed", "failed", "cancelled"}
TERMINAL_TEST = {"passed", "failed", "error", "timeout", "cancelled", "engine_unavailable"}
COMPARISON_LIMITS = [
    "Only the immutable stored generation identified by generation_id and code_hash is supported.",
    "Tests cover the generated finite model, transition/API cases and saved traces; they are not a proof for arbitrary code.",
    "A passed test run is not a TLC result or a proof of production behavior.",
]


class MCPService:
    def __init__(self, backend, codegen, policy):
        self.backend, self.codegen, self.policy = backend, codegen, policy
        self.active = 0

    def result(self, ref, status="completed", data=None, error=None):
        result = ToolResult(model_ref=ref, status=status, data=data or {}, error=error,
                            limits=self.policy.public_limits()).model_dump(mode="json")
        if len(json.dumps(result, ensure_ascii=False).encode()) > self.policy.max_result_bytes:
            return ToolResult(model_ref=ref, status="error", error={"code": "RESULT_TOO_LARGE",
                              "message": "Result exceeds configured limit; use the paginated HTTP/file API"},
                              limits=self.policy.public_limits()).model_dump(mode="json")
        return result

    async def call(self, name, request):
        ref = None
        if name not in self.policy.tools or request.model.model_id not in self.policy.model_ids:
            return self.result(None, "error", error={"code": "ACCESS_DENIED", "message": "Tool or model is outside the local allowlist"})
        if self.active >= self.policy.parallel:
            return self.result(None, "error", error={"code": "BUSY", "message": "Parallel tool limit reached"})
        self.active += 1
        try:
            with anyio.fail_after(self.policy.request_seconds):
                version = await asyncio.to_thread(self.backend.call, "get_version", model_id=request.model.model_id,
                                                  number=request.model.version_number)
                ref = ModelRef(model_id=version["model_id"], version_number=version["number"],
                               version_id=version["id"], spec_hash=version["spec_hash"])
                if spec_hash(BehavioralModel.model_validate(version["spec"])) != ref.spec_hash:
                    raise ServiceError(409, "SPEC_HASH_MISMATCH", "Stored model hash is invalid")
                if isinstance(request.model, ModelRef) and request.model != ref:
                    raise ServiceError(409, "MODEL_REF_MISMATCH", "Immutable model reference does not match")
                if name == "get_model":
                    return self.result(ref, data={"model": version})
                if name == "check_behavior":
                    if request.property_ids is None and len(version["spec"]["properties"]) > 32:
                        raise ServiceError(422, "PROPERTY_LIMIT", "Select at most 32 properties")
                    return await self.check(request, ref)
                return await self.generation(name, request, ref)
        except TimeoutError:
            return self.result(ref, "error", error={"code": "REQUEST_TIMEOUT", "message": "Tool deadline exceeded; cancellation requested"})
        except ServiceError as error:
            return self.result(ref, "error", error={"code": error.code, "message": error.message})
        except ValidationError:
            return self.result(ref, "error", error={"code": "MODEL_INVALID", "message": "Stored model is invalid"})
        except Exception:
            logger.exception("mcp_tool_failed tool=%s", name)
            return self.result(ref, "error", error={"code": "INTERNAL_ERROR", "message": "Tool failed; no semantic result"})
        finally:
            self.active -= 1

    async def check(self, request, ref):
        run_id, terminal = None, False
        try:
            # Short synchronous enqueue has no cancellation point between persistence and acquiring run_id.
            run = self.backend.call("create_check", model_id=ref.model_id, number=ref.version_number,
                                    body={"property_ids": request.property_ids, "limits": request.limits.model_dump(), "explain": False},
                                    key="mcp-" + uuid4().hex)
            run_id = run["run_id"]
            while True:
                report = await asyncio.to_thread(self.backend.call, "get_check", run_id=run_id)
                if report["run"]["state"] in TERMINAL_CHECK:
                    terminal = True
                    technical = report["run"]["state"] != "completed" or not report["results"] or any(
                        r["status"] not in {"PROPERTY_HOLDS", "PROPERTY_VIOLATED"} for r in report["results"])
                    return self.result(ref, "error" if technical else "completed", data={"check": report},
                                       error={"code": "CHECK_INCONCLUSIVE", "message": "See original technical statuses"} if technical else None)
                await anyio.sleep(0.02)
        finally:
            if run_id is not None and not terminal:
                self.backend.call("cancel_run", run_id=run_id)

    async def generation(self, name, request, ref):
        if self.codegen is None:
            raise ServiceError(503, "COMPONENT_UNAVAILABLE", "CodegenService is not connected")
        if name == "compare_with_code" and request.mode != "stored_generation":
            return self.result(ref, "unsupported", data={"limitations": COMPARISON_LIMITS},
                               error={"code": "UNSUPPORTED_CODE", "message": "Arbitrary files, paths, URLs and modified code are unsupported"})
        record = await asyncio.to_thread(self.codegen.get_generation, request.generation_id)
        if (record["model_id"], record["version_id"], record["spec_hash"], record["code_hash"]) != (
                ref.model_id, ref.version_id, ref.spec_hash, request.code_hash):
            raise ServiceError(409, "GENERATION_REF_MISMATCH", "Generation does not match model reference and code hash")
        if name == "get_tests":
            # Existing repository verifies every SHA-256 and aggregate code_hash, including before execution.
            _, files = await asyncio.to_thread(self.codegen.repo.project, request.generation_id)
            tests = [{"path": f.path, "sha256": f.sha256, "content": f.content.decode("utf-8")}
                     for f in files if f.path.startswith("tests/")]
            return self.result(ref, data={"generation_id": record["generation_id"], "code_hash": record["code_hash"],
                                         "files": tests, "coverage": record["coverage"], "tlc_at_generation": record["verification"],
                                         "limitations": COMPARISON_LIMITS})
        run_id, terminal = None, False
        try:
            run = self.codegen.create_test_run(request.generation_id, {"timeout_seconds": request.timeout_seconds}, "mcp-" + uuid4().hex)
            run_id = run["test_run_id"]
            while True:
                run = await asyncio.to_thread(self.codegen.get_test_run, run_id)
                if run["status"] in TERMINAL_TEST:
                    terminal = True
                    # Failed assertions are a completed comparison, technical failures are tool errors.
                    technical = run["status"] != "passed" and (run["status"] != "failed" or run["error_code"] != "TESTS_FAILED")
                    return self.result(ref, "error" if technical else "completed", data={
                        "test_run": run, "tlc_at_generation": record["verification"], "coverage": record["coverage"],
                        "limitations": COMPARISON_LIMITS, "arbitrary_code_equivalence": "unsupported"},
                        error={"code": run["error_code"] or "SANDBOX_ERROR", "message": "See original sandbox status"} if technical else None)
                await anyio.sleep(0.02)
        finally:
            if run_id is not None and not terminal:
                self.codegen.cancel_test_run(run_id)
