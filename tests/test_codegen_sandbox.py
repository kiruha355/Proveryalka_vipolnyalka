"""Песочница Docker на настоящем движке: сгенерированные проекты, ошибочная реализация, враждебный код.

Без Docker или собранного образа (python -m proveryalka.codegen sandbox-build) тесты пропускаются;
при PROVERYALKA_REQUIRE_SANDBOX=1 отсутствие песочницы — ошибка, а не успешная проверка.
"""
import asyncio
import os
import re
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from proveryalka.codegen.sandbox import DockerSandbox, SandboxUnavailable
from proveryalka.codegen.settings import CodegenSettings
from test_codegen import generate, load
from test_codegen_api import HOLDS, add_version, build, complete_check


SETTINGS = CodegenSettings()


def sandbox_ready():
    try:
        asyncio.run(DockerSandbox(SETTINGS).probe())
    except SandboxUnavailable as error:
        return str(error)
    return None


REASON = sandbox_ready()
pytestmark = pytest.mark.skipif(REASON is not None and os.getenv("PROVERYALKA_REQUIRE_SANDBOX") != "1",
                                reason=f"Docker sandbox unavailable: {REASON}")


def run(files, run_id, timeout=120, settings=SETTINGS, stop_after=None):
    async def go():
        stop = asyncio.Event()
        if stop_after is not None:
            asyncio.get_running_loop().call_later(stop_after, stop.set)
        return await DockerSandbox(settings).run(files, run_id=run_id, timeout_seconds=timeout, stop=stop)
    return asyncio.run(go())


def project_files(name):
    return [(item.path, item.content) for item in generate(load(name)).files]


def no_container(run_id):
    output = subprocess.run(["docker", "ps", "-aq", "--filter", f"name=pv-codegen-{run_id}"], capture_output=True, text=True, check=True)
    return output.stdout.strip() == ""


@pytest.mark.parametrize("name", ["order_fixed", "order_bug", "tickets", "counter_overflow", "swap"])
def test_generated_project_passes_in_sandbox(name):
    result, log = run(project_files(name), f"trun_ok{name.replace('_', '')}")
    assert result["status"] == "passed", log
    assert result["counts"]["failed"] == 0 and result["counts"]["errors"] == 0 and result["counts"]["total"] > 20
    assert result["python"].startswith("3.11.")
    assert result["sandbox"]["network"] == "none" and result["sandbox"]["image_id"].startswith("sha256:")
    assert no_container(f"trun_ok{name.replace('_', '')}")


def test_wrong_implementation_fails():
    files = dict(project_files("order_fixed"))
    rules = files["app/rules.py"].decode()
    assert "        'approved': False,\n" in rules
    # Ошибка из ТЗ: отмена не снимает согласование.
    files["app/rules.py"] = rules.replace("        'approved': False,\n", "", 1).encode()
    result, log = run(sorted(files.items()), "trun_wrongimpl")
    assert result["status"] == "failed" and result["error_code"] == "TESTS_FAILED", log
    failed = {case["name"] for case in result["cases"] if case["outcome"] == "failed"}
    assert "test_Cancel_applies_effects_and_keeps_other_variables" in failed
    assert any(name.startswith("test_conformance_table[r1-Cancel") for name in failed)
    assert not any("Approve" in name for name in failed)


HOSTILE = '''import os
import socket
import subprocess


def test_tmp_is_writable():
    with open("/tmp/ok.txt", "w") as stream:
        stream.write("ok")


def test_write_project():
    with open("/job/pwned.txt", "w") as stream:
        stream.write("x")


def test_write_runner():
    with open("/opt/runner/runner.py", "a") as stream:
        stream.write("# pwned")


def test_write_site_packages():
    import fastapi
    with open(os.path.join(os.path.dirname(fastapi.__file__), "pwned.py"), "w") as stream:
        stream.write("x")


def test_read_shadow():
    open("/etc/shadow").read()


def test_host_home():
    os.listdir("/Users")


def test_docker_socket():
    assert os.path.exists("/var/run/docker.sock")


def test_tcp():
    socket.create_connection(("1.1.1.1", 443), timeout=3)


def test_dns():
    socket.getaddrinfo("example.com", 443)


def test_become_root():
    os.setuid(0)


def test_exec_from_tmp():
    with open("/tmp/run.sh", "w") as stream:
        stream.write("#!/bin/sh\\necho escaped\\n")
    os.chmod("/tmp/run.sh", 0o755)
    subprocess.run(["/tmp/run.sh"], check=True)


def test_many_processes():
    children = []
    try:
        for _ in range(400):
            children.append(subprocess.Popen(["sleep", "30"]))
    finally:
        for child in children:
            child.kill()
            child.wait()


def test_host_secret():
    assert os.environ["OPENAI_API_KEY"]
'''

EXPECTED = {
    "test_write_project": r"Read-only file system",
    "test_write_runner": r"Read-only file system|Permission denied",
    "test_write_site_packages": r"Read-only file system|Permission denied",
    "test_read_shadow": r"Permission denied",
    "test_host_home": r"No such file or directory",
    "test_docker_socket": r"assert False",
    "test_tcp": r"Network is unreachable|unreachable",
    "test_dns": r"Temporary failure in name resolution|Name or service not known|No address",
    "test_become_root": r"Operation not permitted",
    "test_exec_from_tmp": r"Permission denied",
    "test_many_processes": r"Resource temporarily unavailable",
    "test_host_secret": r"OPENAI_API_KEY",
}


def test_hostile_actions_are_blocked(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "host-secret-must-not-leak")
    files = [("pytest.ini", b"[pytest]\ntestpaths = tests\n"), ("tests/test_hostile.py", HOSTILE.encode())]
    result, log = run(files, "trun_hostile")
    cases = {case["name"]: case for case in result["cases"]}
    assert result["status"] == "failed" and result["counts"]["total"] == len(EXPECTED) + 1, log
    assert cases["test_tmp_is_writable"]["outcome"] == "passed"
    for name, pattern in EXPECTED.items():
        assert cases[name]["outcome"] == "failed", (name, log)
        assert re.search(pattern, cases[name]["message"] or ""), (name, cases[name]["message"])
    assert "host-secret-must-not-leak" not in log
    assert no_container("trun_hostile")


def test_hang_is_stopped_by_timeout():
    files = [("tests/test_hang.py", b"import time\n\ndef test_hang():\n    time.sleep(3600)\n")]
    started = time.monotonic()
    result, _ = run(files, "trun_hang", timeout=5)
    assert result["status"] == "timeout" and result["error_code"] == "TIMEOUT"
    assert result["counts"] == {"total": None, "passed": None, "failed": None, "errors": None, "skipped": None}
    assert time.monotonic() - started < 40
    assert no_container("trun_hang")


def test_memory_limit_stops_allocation():
    settings = CodegenSettings(memory_mb=128)
    files = [("tests/test_memory.py", b"def test_memory():\n    blocks = [b'x' * (64 << 20) for _ in range(16)]\n    assert blocks\n")]
    result, log = run(files, "trun_memory", settings=settings)
    assert result["status"] == "failed", log
    assert result["error_code"] in ("OOM_KILLED", "PYTEST_SIGNAL_9"), result
    assert result["sandbox"]["memory_mb"] == 128
    assert no_container("trun_memory")


def test_cancel_stops_running_container():
    files = [("tests/test_slow.py", b"import time\n\ndef test_slow():\n    time.sleep(3600)\n")]
    result, _ = run(files, "trun_cancel", timeout=120, stop_after=2)
    assert result["status"] == "cancelled" and result["error_code"] == "CANCELLED"
    assert no_container("trun_cancel")


def test_http_generation_and_sandbox_run(tmp_path):
    app, _ = build(tmp_path, DockerSandbox(SETTINGS))
    store = app.state.backend.store
    store.initialize()
    _, model, _ = add_version(store)
    complete_check(store, model["id"], 1, HOLDS)
    with TestClient(app) as client:
        generation = client.post(f"/api/models/{model['id']}/versions/1/generations", json={}, headers={"Idempotency-Key": "g"}).json()
        assert generation["verification"]["state"] == "holds"
        response = client.post(f"/api/generations/{generation['generation_id']}/test-runs", json={"timeout_seconds": 120}, headers={"Idempotency-Key": "t"})
        assert response.status_code == 202
        for _ in range(600):
            current = client.get(f"/api/test-runs/{response.json()['test_run_id']}").json()
            if current["status"] not in ("queued", "running"):
                break
            time.sleep(0.1)
        assert current["status"] == "passed", current
        assert current["code_hash"] == generation["code_hash"] and current["counts"]["failed"] == 0
        assert "passed" in client.get(f"/api/test-runs/{current['test_run_id']}/log").text
