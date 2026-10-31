import asyncio
import os
from pathlib import Path

from mcp import Client, ClientSession
from mcp.client.streamable_http import streamable_http_client
import pytest

from conftest import running
from test_check_api import FakeChecker
from test_codegen_api import FakeSandbox


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["TIMEOUT", "STATE_LIMIT_REACHED", "ENGINE_ERROR", "MODEL_INVALID"])
async def test_technical_status_is_not_semantic_success(tmp_path, status):
    async with running(tmp_path, checker=FakeChecker(status)) as (url, _, backend, _, ref):
        async with Client(url) as client:
            result = await client.call_tool("check_behavior", {"model": ref, "property_ids": ["NoCancelledExecution"]})
            assert result.is_error
            body = result.structured_content
            assert body["model_ref"] == ref and body["status"] == "error"
            report = body["data"]["check"]
            assert report["run"]["state"] == "completed"
            assert report["results"][0]["status"] == status and not report["results"][0]["conclusive"]
            assert backend.store.get_check(report["run"]["run_id"]) == report


class GatedChecker(FakeChecker):
    def __init__(self):
        super().__init__()
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def run(self, request, run_id=None):
        self.started.set()
        await asyncio.Event().wait()

    def cancel(self, run_id):
        self.cancelled.set()
        return True


async def wait_until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.01)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_sdk_cancellation_cancels_durable_checker_run(tmp_path, mode):
    checker = GatedChecker()
    async with running(tmp_path, checker=checker) as (url, integration, backend, _, ref):
        async with Client(url, mode=mode) as client:
            pending = asyncio.create_task(client.call_tool("check_behavior", {"model": ref}))
            await asyncio.wait_for(checker.started.wait(), 5)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            await asyncio.wait_for(checker.cancelled.wait(), 5)
            await wait_until(lambda: integration.service.active == 0 and not backend.tasks)
            with backend.store.transaction() as connection:
                runs = list(connection.execute("SELECT state,error_code FROM runs WHERE kind='check'"))
            assert len(runs) == 1 and runs[0]["state"] == "cancelled" and runs[0]["error_code"] == "CANCELLED"


@pytest.mark.anyio
async def test_parallel_limit_deadline_and_cancel_do_not_leave_work(tmp_path):
    checker = GatedChecker()
    async with running(tmp_path, checker=checker, policy_changes={"parallel": 1, "request_seconds": 0.3}) as (url, integration, backend, _, ref):
        async with Client(url) as client:
            pending = asyncio.create_task(client.call_tool("check_behavior", {"model": ref}))
            await asyncio.wait_for(checker.started.wait(), 5)
            busy = await client.call_tool("get_model", {"model": {"model_id": ref["model_id"], "version_number": 1}})
            assert busy.is_error and busy.structured_content["error"]["code"] == "BUSY"
            timed_out = await pending
            assert timed_out.is_error and timed_out.structured_content["error"]["code"] == "REQUEST_TIMEOUT"
            assert timed_out.structured_content["model_ref"] == ref
            await asyncio.wait_for(checker.cancelled.wait(), 5)
            await wait_until(lambda: not backend.tasks)
            assert integration.service.active == 0


@pytest.mark.anyio
async def test_compare_sandbox_unavailable_is_error_not_zero_tests_pass(tmp_path):
    from proveryalka.codegen.sandbox import DockerSandbox
    from proveryalka.codegen.settings import CodegenSettings
    sandbox = DockerSandbox(CodegenSettings(docker=str(tmp_path / "no-docker")))
    async with running(tmp_path, sandbox=sandbox) as (url, _, _, codegen, ref):
        gen = codegen.generate(ref["model_id"], 1, {"allow_unverified": True}, "generation")
        async with Client(url) as client:
            result = await client.call_tool("compare_with_code", {"model": ref, "generation_id": gen["generation_id"], "code_hash": gen["code_hash"]})
            assert result.is_error
            data = result.structured_content["data"]
            assert data["test_run"]["status"] == "engine_unavailable"
            assert data["test_run"]["counts"]["total"] is None
            assert data["tlc_at_generation"]["state"] == "not_checked"
            assert data["arbitrary_code_equivalence"] == "unsupported"


@pytest.mark.anyio
async def test_sdk_cancel_compare_requests_existing_executor_stop(tmp_path):
    sandbox = FakeSandbox()
    sandbox.gate = True
    async with running(tmp_path, sandbox=sandbox) as (url, integration, _, codegen, ref):
        gen = codegen.generate(ref["model_id"], 1, {"allow_unverified": True}, "generation")
        async with Client(url, mode="legacy") as client:
            pending = asyncio.create_task(client.call_tool("compare_with_code", {"model": ref, "generation_id": gen["generation_id"], "code_hash": gen["code_hash"]}))
            await wait_until(lambda: bool(sandbox.calls))
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            await wait_until(lambda: codegen.list_test_runs(gen["generation_id"])[0]["status"] == "cancelled")
            run = codegen.list_test_runs(gen["generation_id"])[0]
            assert run["cancel_requested"] and run["error_code"] == "CANCELLED"
            assert run["counts"]["total"] is None


@pytest.mark.anyio
async def test_real_tlc_and_docker_through_official_http_client(tmp_path):
    jar = Path(os.getenv("PROVERYALKA_TLA_JAR", "tools/tla2tools.jar"))
    if not jar.is_file():
        if os.getenv("PROVERYALKA_REQUIRE_TLC") == "1":
            pytest.fail("Real TLC is required but jar is missing")
        pytest.skip("Set PROVERYALKA_TLA_JAR for real MCP TLC + Docker test")
    async with running(tmp_path, real_tlc=True) as (url, _, backend, codegen, ref):
        try:
            await codegen.sandbox.probe()
        except Exception as error:
            if os.getenv("PROVERYALKA_REQUIRE_SANDBOX") == "1":
                raise
            pytest.skip(str(error))
        async with streamable_http_client(url) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                result = await client.call_tool("check_behavior", {"model": ref})
                assert not result.is_error, result
                report = result.structured_content["data"]["check"]
                assert len(report["results"]) == 3
                assert {r["status"] for r in report["results"]} == {"PROPERTY_HOLDS"}
                assert all(r["mode"] == "engine" and r["executed"] and r["engine"]["name"] == "TLC" for r in report["results"])
                gen = codegen.generate(ref["model_id"], 1, {}, "after-real-TLC")
                result = await client.call_tool("compare_with_code", {"model": ref, "generation_id": gen["generation_id"], "code_hash": gen["code_hash"]})
                assert not result.is_error, result
                data = result.structured_content["data"]
                run = data["test_run"]
                assert run["status"] == "passed" and run["counts"]["total"] > 20
                assert run["counts"]["failed"] == 0 and run["sandbox"]["network"] == "none"
                assert run["sandbox"]["engine_version"] and run["sandbox"]["image_id"].startswith("sha256:")
                assert data["tlc_at_generation"]["state"] == "holds"
                assert result.structured_content["model_ref"] == ref
                assert codegen.get_test_run(run["test_run_id"]) == run
                evidence = os.getenv("PROVERYALKA_MCP_EVIDENCE")
                if evidence:
                    import json
                    root = Path(evidence)
                    root.mkdir(parents=True, exist_ok=True)
                    (root / "real-tlc.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                    (root / "real-docker-comparison.json").write_text(json.dumps(result.structured_content, ensure_ascii=False, indent=2) + "\n")


@pytest.mark.anyio
@pytest.mark.parametrize("code,is_error", [("TESTS_FAILED", False), ("OOM_KILLED", True), ("NO_TESTS", True), ("PYTEST_EXIT_3", True)])
async def test_failed_assertions_and_technical_sandbox_failure_are_separate(tmp_path, code, is_error):
    class ControlledSandbox(FakeSandbox):
        async def run(self, *args, **kwargs):
            result, log = await super().run(*args, **kwargs)
            return {**result, "error_code": code}, log
    sandbox = ControlledSandbox(status="failed")
    async with running(tmp_path, sandbox=sandbox) as (url, _, _, codegen, ref):
        gen = codegen.generate(ref["model_id"], 1, {"allow_unverified": True}, "generation")
        async with Client(url) as client:
            result = await client.call_tool("compare_with_code", {"model": ref, "generation_id": gen["generation_id"], "code_hash": gen["code_hash"]})
            assert result.is_error is is_error
            assert result.structured_content["data"]["test_run"]["status"] == "failed"
            assert result.structured_content["data"]["test_run"]["error_code"] == code
            assert result.structured_content["model_ref"] == ref
            assert result.structured_content["data"]["tlc_at_generation"]["state"] == "not_checked"
