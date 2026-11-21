"""The source attachment and provenance routes are supplied by develop (f78ffa5)."""
import copy
import io
import json
import os
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace

import pytest
from agents import Agent
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from image_helpers import analyze, upload
from proveryalka.agent import dialogue, verification
from proveryalka.agent.clarification import DialogueDraft
from proveryalka.api.app import create_app
from proveryalka.checker import TLCChecker
from proveryalka.config import Settings
from proveryalka.contracts import Source
from proveryalka.images.dto import ImageDraft, VisualRequirement
from proveryalka.images.evidence import validate_observations
from proveryalka.images.storage import ImageStore
from test_analyst_http import APIChecker, CASE, NarrativeModel, TEXT, post, question, session, wait_explanation
from test_check_api import wait_run


PROPOSAL = "Уточнить, можно ли исполнить заявку после отмены."
UNCERTAINTY = "Не читается подпись на стрелке из согласования."
ANSWER = "Стрелка ведёт к исполнению."
CROP = {"x": 32, "y": 8, "width": 112, "height": 64}


def model_draft(source_id, previous=None, **changes):
    analysis = copy.deepcopy(CASE["draft"])
    for index, fact in enumerate(analysis["requirements"]):
        fact["source_id"] = source_id
        fact["previous_id"] = previous["analysis"]["requirements"][index]["id"] if previous else None
    return DialogueDraft(analysis=analysis, **{"questions": [], "resolutions": [], "corrections": [], **changes})


class DiagramProvider:
    def name(self):
        return "codex"

    async def analyze(self, png):
        with Image.open(io.BytesIO(png)) as image:
            assert image.size == (CROP["width"], CROP["height"])
            assert image.getpixel((0, 0)) == (255, 255, 255)
            assert image.getpixel((48, 16)) == (0, 0, 0)
        visible = [VisualRequirement(text=item["quote"], origin="visible") for item in CASE["draft"]["requirements"]]
        return ImageDraft(description="Схема согласования заявки",
                          requirements=[*visible, VisualRequirement(text=PROPOSAL, origin="proposal")],
                          uncertainties=[UNCERTAINTY])


def diagram_bytes():
    canvas = Image.new("RGB", (160, 80), "white")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((36, 12, 64, 36), outline="black")
    draw.rectangle((96, 12, 140, 36), outline="black")
    draw.line((64, 24, 96, 24), fill="black")
    draw.line((88, 18, 96, 24, 88, 30), fill="black")
    stream = io.BytesIO()
    canvas.save(stream, "PNG")
    return stream.getvalue()


@asynccontextmanager
async def local_client():
    yield None


def test_ambiguous_image_cannot_create_model_without_clarification():
    visible = [item["quote"] for item in CASE["draft"]["requirements"]]
    source = Source(id="src_image", session_id="session", text="\n".join(visible))
    observations = {source.id: {"visible": visible, "proposals": [], "uncertainties": [UNCERTAINTY]}}
    with pytest.raises(ValueError, match="уточняющий вопрос"):
        validate_observations(model_draft(source.id), [source], None, observations)
    with pytest.raises(ValueError, match="Факт или элемент"):
        invalid = model_draft(source.id, questions=[question("Куда ведёт стрелка?")])
        invalid.analysis.events[0].quote = UNCERTAINTY
        validate_observations(invalid, [source], None, observations)


@pytest.mark.skipif(not hasattr(ImageStore, "attach"), reason="Source attachment and provenance require develop f78ffa5")
@pytest.mark.parametrize("started", [False, True], ids=["new-chat", "existing-chat"])
def test_crop_provenance_survives_dialogue_model_check_and_reload(tmp_path, monkeypatch, started):
    settings = replace(Settings.from_env(), database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", check_cache_path=None)
    narrator = NarrativeModel()
    run_tlc = os.getenv("PROVERYALKA_REQUIRE_TLC") == "1"
    checker = TLCChecker(settings) if run_tlc else APIChecker()
    inputs = []

    async def analyst_output(agent, *, input, **kwargs):
        payload = json.loads(input)
        inputs.append(payload)
        observations = payload.get("image_observations", {})
        previous = payload["previous"]
        if not observations:
            candidate = model_draft(payload["sources"][0]["id"])
        else:
            source_id = next(iter(observations))
            assert observations[source_id]["image_ref"]["region"] == CROP
            assert observations[source_id]["uncertainties"] == [UNCERTAINTY]
            assert observations[source_id]["proposals"] == [PROPOSAL]
            if payload.get("turn_kind") == "attachment":
                candidate = model_draft(source_id, previous, questions=[question("Куда ведёт стрелка из согласования?")])
                if payload["validation_feedback"] is None:
                    candidate.analysis.requirements[-1].quote = PROPOSAL
                else:
                    assert "видимое наблюдение" in payload["validation_feedback"]["error"]
            else:
                candidate = model_draft(source_id, previous, resolutions=[{
                    "question_id": payload["answer_to_question_id"], "decision": "answered", "quote": ANSWER,
                }])
        return SimpleNamespace(final_output=candidate)

    monkeypatch.setattr(dialogue, "create_client", local_client)
    monkeypatch.setattr(dialogue, "create_agent", lambda client: Agent(name="local analyst"))
    monkeypatch.setattr(dialogue, "run_agent", analyst_output)
    monkeypatch.setattr(verification, "create_client", local_client)
    monkeypatch.setattr(verification, "create_agent", lambda client: Agent(name="local explainer", model=narrator))
    app_options = dict(checker=checker, image_provider=DiagramProvider(), codegen_sandbox=object())

    with TestClient(create_app(settings, **app_options)) as client:
        client.sid = session(client)
        other = session(client, "other-session")
        root = f"/api/sessions/{client.sid}"
        messages = f"{root}/messages"
        if started:
            first = post(client, messages, {"text": TEXT}, "initial").json()
            assert wait_run(client, first["run_id"])["state"] == "completed"
            old_model = client.get(f"{root}/dialogue").json()["model"]
            old_version_url = f"/api/models/{old_model['model_id']}/versions/1"
            old_version = client.get(old_version_url).json()

        image = upload(client, diagram_bytes(), filename="diagram.png").json()
        analysis = analyze(client, image["id"], {"region": CROP}).json()
        analyses = f"{root}/images/{image['id']}/analyses"
        attach = f"{analyses}/{analysis['id']}/source"
        response = client.post(attach)
        assert response.status_code == 201, response.text
        source = response.json()
        assert client.post(attach).json() == source
        assert client.post(attach.replace(client.sid, other)).status_code == 404
        assert UNCERTAINTY in source["text"] and PROPOSAL in source["text"]

        response = post(client, messages, {"source_id": source["id"]}, "image-turn")
        assert response.status_code == 202, response.text
        run_id = response.json()["run_id"]
        assert wait_run(client, run_id)["state"] == "completed"
        assert post(client, messages, {"source_id": source["id"]}, "image-turn").json()["run_id"] == run_id
        duplicate = post(client, messages, {"source_id": source["id"]}, "duplicate-turn")
        assert duplicate.json()["error"]["code"] == "SOURCE_ALREADY_ANALYZED"
        pending = client.get(f"{root}/dialogue").json()
        assert pending["status"] == "needs_clarification"
        assert pending["entries"][-2]["source_id"] == source["id"]
        assert pending["entries"][-2]["status"] == "processed"
        assert "Куда ведёт стрелка" in pending["questions"][0]["text"]
        assert len(inputs) == (3 if started else 2)

        answer = post(client, messages, {"text": ANSWER, "question_id": pending["open_question_ids"][0]}, "answer").json()
        assert wait_run(client, answer["run_id"])["state"] == "completed"
        saved = client.get(f"{root}/dialogue").json()
        assert saved["status"] == "ready" and saved["open_question_ids"] == []
        model = saved["model"]
        assert model["number"] == (2 if started else 1)
        version_url = f"/api/models/{model['model_id']}/versions/{model['number']}"
        version = client.get(version_url).json()
        if started:
            assert client.get(old_version_url).json() == old_version
        property_ = version["spec"]["properties"][0]
        rule = next(item for item in version["spec"]["requirements"] if item["id"] in property_["requirement_ids"])
        ref = next(item for item in rule["source_refs"] if item["source_id"] == source["id"])
        assert source["text"][ref["start"]:ref["end"]] == ref["quote"]
        provenance_url = f"{root}/sources/{ref['source_id']}/provenance?start={ref['start']}&end={ref['end']}"
        provenance = client.get(provenance_url).json()
        assert (provenance["kind"], provenance["image_source_id"], provenance["analysis_id"], provenance["region"]) == (
            "image", image["id"], analysis["id"], CROP,
        )

        check = post(client, f"{version_url}/checks", {"explain": True}, "check").json()
        assert wait_run(client, check["run_id"])["state"] == "completed"
        assert wait_explanation(client, check["run_id"])["state"] == "ready"
        checked = client.get(f"/api/checks/{check['run_id']}").json()
        assert checked["results"][0]["mode"] == ("engine" if run_tlc else "test")
        assert checked["results"][0]["status"] == "PROPERTY_VIOLATED"
        assert rule["id"] in checked["results"][0]["related_requirements"]
        assert checked["explanation"]["narrative"]["properties"][0]["property_id"] == property_["id"]

    with TestClient(create_app(settings, **app_options)) as client:
        assert client.get(f"{root}/dialogue").json() == saved
        assert client.get(version_url).json() == version
        assert client.get(analyses).json()[0]["result"] == analysis
        assert client.get(provenance_url).json() == provenance
        assert client.get(provenance_url.replace(root, f"/api/sessions/{other}")).status_code == 404
        assert client.get(provenance["url"]).content.startswith(b"\x89PNG")
