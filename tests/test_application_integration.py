"""Production app wiring across migrations, sources, MCP and static delivery.

No network/provider calls: existing engine/provider suites cover those boundaries.
"""
import io
import json
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient
from PIL import Image

from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.deployment import create_deployment
from proveryalka.images.dto import ImageDraft, VisualRequirement
from proveryalka.mcp import LocalAccessPolicy
from proveryalka.storage.sqlite import SQLiteStore
from test_check_api import FakeChecker
from test_repositories import GitFixture, REMOTE, selection
from test_versions import setup_model


class ReadyChecker(FakeChecker):
    async def engine(self):
        return None


class PixelProvider:
    def name(self):
        return "codex"

    async def analyze(self, png):
        with Image.open(io.BytesIO(png)) as image:
            assert image.size == (24, 16)
            assert image.convert("RGB").getpixel((0, 0)) == (255, 0, 0)
        return ImageDraft(description="Красный прямоугольник", requirements=[
            VisualRequirement(text="На изображении красный прямоугольник", origin="visible")
        ], uncertainties=[])


def test_upgrade_existing_codegen_database_mounts_sources_and_preserves_versions(tmp_path):
    path = tmp_path / "state.sqlite"
    migrations = Path(__file__).parents[1] / "src/proveryalka/storage/migrations"
    # Actual previous schema, before image/repository tables existed.
    with sqlite3.connect(path) as connection:
        for filename in ("001_sessions.sql", "002_versions.sql", "003_runs.sql", "004_events.sql",
                         "005_documents_explanations.sql", "006_codegen.sql"):
            connection.executescript((migrations / filename).read_text())
        connection.execute("PRAGMA user_version=6")
    store = SQLiteStore(path)
    session, model, spec = setup_model(store)
    original = store.create_version(model["id"], {"spec": spec}, "original-version")
    git = GitFixture(tmp_path / "repo")
    git.write("requirements.md", "unselected first\nselected requirement\nunselected last\n")
    git.commit()
    settings = Settings(database_path=path, artifacts_path=tmp_path / "artifacts", check_cache_path=None)
    app = create_app(settings, checker=ReadyChecker(), codegen_sandbox=object(), image_provider=PixelProvider())
    app.state.repositories.transport = git
    sid = session["id"]
    with TestClient(app) as client:
        image = io.BytesIO()
        Image.new("RGB", (24, 16), "red").save(image, "PNG")
        uploaded = client.post(f"/api/sessions/{sid}/images", files={"file": ("test.png", image.getvalue(), "image/png")},
                               headers={"Idempotency-Key": "image"})
        assert uploaded.status_code == 201, uploaded.text
        image_id = uploaded.json()["id"]
        result = client.post(f"/api/sessions/{sid}/images/{image_id}/analysis", json={},
                             headers={"Idempotency-Key": "analysis"})
        assert result.status_code == 200, result.text
        image_result = result.json()
        assert image_result["source_refs"][0]["kind"] == "image_reference"
        imported = client.post(f"/api/sessions/{sid}/repositories", json={"remote_url": REMOTE},
                               headers={"Idempotency-Key": "repository"})
        assert imported.status_code == 201, imported.text
        snapshot = imported.json()
        context = client.post(f"/api/sessions/{sid}/repositories/{snapshot['id']}/context",
                              json=selection(snapshot, "requirements.md", 2, 2),
                              headers={"Idempotency-Key": "context"})
        assert context.status_code == 201, context.text
        source = context.json()["source"]
        assert "selected requirement" in source["text"] and "unselected" not in source["text"]
        assert client.get(f"/api/models/{model['id']}/versions/1").json() == original
        assert client.get("/ready").status_code == 200
    # A fresh application must restore both new source kinds and the old exact version.
    with TestClient(create_app(settings, checker=ReadyChecker(), codegen_sandbox=object())) as client:
        assert client.get(f"/api/sessions/{sid}/images").json()[0]["id"] == image_id
        assert client.get(f"/api/sessions/{sid}/images/{image_id}/analyses").json()[0]["result"] == image_result
        assert client.get(f"/api/sessions/{sid}/repositories").json()[0] == snapshot
        assert client.get(f"/api/models/{model['id']}/versions/1").json() == original
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 8


def _rpc(response):
    if "text/event-stream" in response.headers.get("content-type", ""):
        return json.loads(next(line[6:] for line in response.text.splitlines() if line.startswith("data: ")))
    return response.json()


def test_mcp_exact_route_coexists_with_static_and_rest_lifespans(tmp_path):
    ui = tmp_path / "ui"
    (ui / "assets").mkdir(parents=True)
    index = '<html><script src="/assets/app.js"></script></html>'
    (ui / "index.html").write_text(index)
    (ui / "assets/app.js").write_text("console.log('integration')")
    settings = Settings(database_path=tmp_path / "state.sqlite", artifacts_path=tmp_path / "artifacts")
    settings.artifacts_path.mkdir()
    app = create_deployment(settings, ui, checker=ReadyChecker(), codegen_sandbox=object(),
                            mcp_policy=LocalAccessPolicy())
    headers = {"Accept": "application/json, text/event-stream"}
    with TestClient(app, client=("127.0.0.1", 43210), base_url="http://127.0.0.1") as client:
        assert client.get("/").text == index
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/api/sessions").json() == []
        assert client.get("/ready").status_code == 200
        initialized = client.post("/mcp", headers=headers, follow_redirects=False, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name": "application-integration", "version": "1"}}})
        assert initialized.status_code == 200, initialized.text
        result = _rpc(initialized)["result"]
        session_headers = {**headers, "Mcp-Session-Id": initialized.headers["mcp-session-id"],
                           "Mcp-Protocol-Version": result["protocolVersion"]}
        client.post("/mcp", headers=session_headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = client.post("/mcp", headers=session_headers,
                            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        assert tools.status_code == 200, tools.text
        assert {tool["name"] for tool in _rpc(tools)["result"]["tools"]} == {"get_model", "get_tests"}
        assert app.state.mcp.service.backend is app.state.backend
        denied = client.post("/mcp", headers={**headers, "Origin": "https://untrusted.invalid"}, json={})
        assert denied.status_code == 403
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/api/unknown").status_code == 404
