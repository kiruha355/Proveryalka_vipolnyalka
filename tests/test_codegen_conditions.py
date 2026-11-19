import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from test_codegen_api import add_version, generate
from proveryalka.api.app import create_app
from proveryalka.config import Settings


def conditions(**updates):
    return {"language": "python", "platform": "fastapi", "api_prefix": "/api/v1",
            "storage": "sqlite", "integrations": [], **updates}


@pytest.mark.parametrize("fixture", ["order_fixed", "tickets"])
def test_explicit_conditions_are_saved_with_files_and_version(tmp_path, fixture):
    app = create_app(Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts"))
    with TestClient(app) as client:
        _, model, version = add_version(app.state.backend.store, fixture)
        body = {"allow_unverified": True, "technical_conditions": conditions()}
        response = generate(client, model["id"], body)
        assert response.status_code == 201, response.text
        record = response.json()
        assert record["technical_conditions"]["storage"] == "sqlite"
        assert record["version_id"] == version["id"]
        assert record["spec_hash"] == version["spec_hash"]
        repeat = generate(client, model["id"], body, key="g2").json()
        assert repeat["generation_id"] != record["generation_id"]
        assert repeat["code_hash"] == record["code_hash"]
        archive = client.get(f"/api/generations/{record['generation_id']}/archive")
        with zipfile.ZipFile(io.BytesIO(archive.content)) as files:
            assert files.testzip() is None
            names = [name.split("/", 1)[1] for name in files.namelist()]
            assert {"app/state_store.py", "tests/test_persistence.py"} <= set(names)
            manifest = json.loads(files.read(next(n for n in files.namelist() if n.endswith("/GENERATION.json"))))
            assert manifest["technical_conditions"] == record["technical_conditions"]


@pytest.mark.parametrize(("value", "code"), [
    ({"language": "python"}, "CONDITIONS_INCOMPLETE"),
    (conditions(storage="postgres"), "UNSUPPORTED_TECHNICAL_CONDITIONS"),
    (conditions(language="javascript"), "UNSUPPORTED_TECHNICAL_CONDITIONS"),
    (conditions(integrations=["stripe"]), "UNSUPPORTED_TECHNICAL_CONDITIONS"),
])
def test_conditions_fail_before_generation(tmp_path, value, code):
    app = create_app(Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts"))
    with TestClient(app) as client:
        _, model, _ = add_version(app.state.backend.store)
        response = generate(client, model["id"], {"allow_unverified": True, "technical_conditions": value})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == code
        assert client.get(f"/api/models/{model['id']}/versions/1/generations").json() == []


def test_agent_application_uses_existing_rules_and_idempotent_record(tmp_path):
    calls = []

    async def planner(conditions, transitions):
        calls.append((conditions, transitions))
        return {"actions": [{"name": "approve_request", "transition_id": "Approve"}]}

    app = create_app(Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts"),
                     codegen_planner=planner)
    with TestClient(app) as client:
        _, model, _ = add_version(app.state.backend.store)
        body = {"allow_unverified": True, "technical_conditions": conditions(), "application_mode": "agent"}
        response = generate(client, model["id"], body)
        assert response.status_code == 201, response.text
        generation = response.json()
        assert generation["application_mode"] == "agent"
        root = f"/api/generations/{generation['generation_id']}/files"
        source = client.get(root + "/app/actions.py").text
        assert "'approve_request': 'Approve'" in source
        assert "engine.apply(state, ACTIONS[action])" in source
        assert generate(client, model["id"], body).json() == generation
        assert len(calls) == 1 and calls[0][0]["storage"] == "sqlite"
