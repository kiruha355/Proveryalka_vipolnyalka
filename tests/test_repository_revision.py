from fastapi.testclient import TestClient

from proveryalka.agent import dialogue
from proveryalka.agent.analysis import ExtractionDraft
from proveryalka.agent.clarification import DialogueDraft
from proveryalka.agent.review import Finding, ReviewDraft
from proveryalka.api import reviews
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from test_analyst_http import Script
from test_check_api import wait_run
from test_repositories import GitFixture, REMOTE
from test_versions import setup_model


def test_reviewed_repository_feature_continues_the_selected_version(tmp_path, monkeypatch):
    repo = GitFixture(tmp_path / "git")
    repo.write("app/routes.py", "from app.booking import reserve_slot\n\nreserve_slot('morning')\n")
    repo.write("app/booking.py", "def reserve_slot(slot):\n    return slot\n")
    repo.write("README.md", "A slot can be reserved once.\n")
    repo.commit()

    async def review(payload):
        if payload["mode"] == "review":
            source = payload["model"]["sources"][0]
            requirement = payload["model"]["requirements"][0]
            return ReviewDraft(summary="Review", findings=[Finding(
                kind="domain", text="Check which initial state is intended", element_id=requirement["id"],
                source_id=source["id"], quote=requirement["source_refs"][0]["quote"],
            )])
        source = payload["repository_sources"][0]
        return ReviewDraft(summary="Preserve current booking rules", findings=[Finding(
            kind="impact", text="Add rescheduling next to the existing reservation function", element_id=None,
            source_id=source["id"], quote="def reserve_slot(slot):",
        )])

    def revised(sources, previous):
        analysis = previous.analysis.model_dump(include=set(ExtractionDraft.model_fields))
        analysis["requirements"] = [
            {"text": rule.text, "previous_id": rule.id, "source_id": rule.source_refs[0].source_id, "quote": rule.source_refs[0].quote}
            for rule in previous.analysis.requirements
        ] + [{"text": sources[-1].text, "quote": sources[-1].text, "source_id": sources[-1].id, "previous_id": None}]
        return DialogueDraft(analysis=analysis, questions=[], resolutions=[], corrections=[])

    script = Script([revised])
    monkeypatch.setattr(dialogue, "generate_state", script)
    monkeypatch.setattr(reviews, "review_model", review)
    app = create_app(Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts"), codegen_sandbox=object())
    app.state.repositories.transport = repo
    with TestClient(app) as client:
        store = app.state.backend.store
        session, model, spec = setup_model(store)
        first = store.create_version(model["id"], {"spec": spec}, "v1")
        spec["name"] = "Версия из графа"
        spec["transitions"][0]["guard"]["value"] = False
        edited = store.create_version(model["id"], {"spec": spec}, "v2")
        spec["name"] = "Другая ветвь"
        spec["transitions"][0]["guard"]["value"] = True
        latest = store.create_version(model["id"], {"spec": spec}, "v3")
        base = f"/api/sessions/{session['id']}"

        def post(path, body, key):
            response = client.post(path, json=body, headers={"Idempotency-Key": key})
            assert response.is_success, response.text
            return response.json()

        snapshot = post(base + "/repositories", {"remote_url": REMOTE}, "snapshot")
        plan = post(base + f"/repositories/{snapshot['id']}/selection", {"query": "reserve slot"}, "plan")
        paths = {item["path"] for item in plan["selection"]["files"]}
        assert {"app/routes.py", "app/booking.py"} <= paths
        context = post(base + f"/repositories/{snapshot['id']}/context", plan["selection"], "context")
        assert 'Requested analysis scope: "reserve slot"' in context["source"]["text"]
        endpoint = base + f"/versions/{edited['id']}/reviews"
        semantic = post(endpoint, {}, "review")
        assert semantic["findings"][0]["element_id"] == first["spec"]["requirements"][0]["id"]
        impact = post(endpoint, {"snapshot_id": snapshot["id"], "feature": "Allow rescheduling a reservation."}, "impact")
        assert impact["findings"][0]["location"]["path"] == "app/booking.py"
        assert [v["id"] for v in store.list_versions(model["id"])] == [first["id"], edited["id"], latest["id"]]
        run = post(endpoint + f"/{impact['id']}/apply", None, "approve-impact")
        result = wait_run(client, run["run_id"])
        assert result["state"] == "completed", result
        child = store.session_version(session["id"], result["version_id"])
        assert child["parent_id"] == edited["id"]
        assert child["spec"]["transitions"] == edited["spec"]["transitions"]
        assert child["spec"]["properties"] == edited["spec"]["properties"]
        assert child["spec"]["name"] == edited["spec"]["name"]
        assert script.payloads[0]["impact_review"]["id"] == impact["id"]
        assert script.payloads[0]["attached_source_id"] == impact["source_id"]
        assert client.get(base + "/dialogue").json()["model"]["version_id"] == child["id"]
        assert client.get(endpoint).json()[0]["id"] == impact["id"]
