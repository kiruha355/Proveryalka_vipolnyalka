"""Delivery checks: real HTTP process/restart and static/API confinement; no LLM."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from proveryalka.config import Settings
from proveryalka.deployment import create_deployment
from test_check_api import FakeChecker


@pytest.fixture
def built_ui(tmp_path):
    directory = tmp_path / "ui"
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text('<html><script src="/assets/app.js"></script></html>')
    (directory / "assets/app.js").write_text('console.log("delivery fixture")')
    return directory


def test_static_build_api_and_readiness_are_one_origin(tmp_path, built_ui):
    class ReadyChecker(FakeChecker):
        async def engine(self):
            return None

    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts")
    settings.artifacts_path.mkdir()
    app = create_deployment(settings, built_ui, checker=ReadyChecker())
    with TestClient(app) as client:
        assert client.get("/").text.startswith("<html>")
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/api/sessions").json() == []
        assert client.get("/ready").status_code == 200
        for path in ("/.env", "/data/db", "/%2e%2e/db", "/api/unknown"):
            assert client.get(path).status_code == 404
        (built_ui / "assets/app.js").unlink()
        assert client.get("/ready").status_code == 503
        (built_ui / "index.html").unlink()
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 503


def test_missing_build_fails_before_binding(tmp_path):
    with pytest.raises(ValueError, match="Vite build missing"):
        create_deployment(frontend_dist=tmp_path)


def test_real_process_shutdown_and_restart_keep_sqlite(tmp_path, built_ui):
    from test_checker_tlc import JAVA, JAR, PROBLEM
    if PROBLEM:
        pytest.skip(PROBLEM)
    # CI uses the actual build from its frontend job; local unit tests use a tiny
    # static fixture unless an explicit built distribution is supplied.
    ui = os.getenv("PROVERYALKA_TEST_FRONTEND_DIST", str(built_ui))
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = {**os.environ, "PYTHONPATH": str(Path("src").resolve()),
           "PROVERYALKA_TLA_JAR": str(JAR), "PROVERYALKA_JAVA": JAVA,
           "PROVERYALKA_LLM_PROVIDER": "openai", "OPENAI_API_KEY": "", "OPENAI_BASE_URL": ""}
    # This test owns exactly its child, data and port. No live demo is touched.
    for name in ("PROVERYALKA_DATABASE_PATH", "PROVERYALKA_ARTIFACTS_PATH", "PROVERYALKA_CHECK_CACHE"):
        env.pop(name, None)
    command = [sys.executable, "-m", "proveryalka.deployment", "--env-file", str(tmp_path / "absent.env"),
               "--data-dir", str(tmp_path / "persistent"), "--frontend-dist", ui, "--port", str(port)]
    def start(log):
        child = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    assert child.poll() is None, "Delivery process exited; inspect process log"
                    try:
                        if client.get("/ready").status_code == 200:
                            return child
                    except httpx.TransportError:
                        pass
                    time.sleep(0.1)
            raise AssertionError("Delivery readiness timeout")
        except BaseException:
            child.terminate()
            child.wait(timeout=20)
            raise
    with (tmp_path / "delivery.log").open("w") as log:
        for iteration in range(2):
            child = start(log)
            try:
                with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                    assert client.get("/").status_code == 200
                    if iteration == 0:
                        response = client.post("/api/sessions", json={"title": "Перезапуск"}, headers={"Idempotency-Key": "persistent"})
                        assert response.status_code == 201
                        saved = response.json()
                    else:
                        detail = client.get(f"/api/sessions/{saved['id']}").json()
                        assert {key: detail[key] for key in saved} == saved
                    assert client.get("/ready").json()["agent_configured"] is False
            finally:
                child.terminate()
                child.wait(timeout=20)
            assert child.returncode in (0, -15)
    assert (tmp_path / "persistent/proveryalka.sqlite3").is_file()
