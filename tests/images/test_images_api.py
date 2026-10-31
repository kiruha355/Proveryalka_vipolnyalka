import asyncio
import hashlib
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from proveryalka.agent.errors import AgentError
from proveryalka.images.dto import ImageAnalysisCreate
from proveryalka.images.ingest import ImageLimits
from proveryalka.services import ServiceError
from conftest import analyze, image_bytes, testapp, upload


def test_upload_content_idempotency_and_session_boundary(client, store):
    raw = image_bytes()
    response = upload(client, raw, filename="../../image.png")
    assert response.status_code == 201, response.text
    source = response.json()
    assert source["kind"] == "image" and "text" not in source
    assert source["sha256"] == hashlib.sha256(raw).hexdigest()
    assert (source["width"], source["height"]) == (80, 60)
    assert upload(client, raw, filename="../../image.png").json() == source
    assert upload(client, image_bytes(color="blue")).status_code == 409
    path = f'/api/sessions/{client.sid}/images/{source["id"]}'
    assert client.get(path).json() == source
    assert client.get(f"/api/sessions/{client.sid}/images").json() == [source]
    assert client.get(path.replace(client.sid, client.other)).status_code == 404
    assert client.get(path.replace(client.sid, client.other) + "/content").status_code == 404
    content = client.get(path + "/content")
    assert content.headers["content-type"] == "image/png"
    assert content.headers["x-content-type-options"] == "nosniff"
    assert hashlib.sha256(content.content).hexdigest() == source["canonical_sha256"]
    with store.transaction() as db:
        assert db.execute("SELECT count(*) FROM sources").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM image_sources").fetchone()[0] == 1


def test_content_bytes_reach_provider_and_refs_do_not_fake_ocr(client, provider):
    source = upload(client).json()
    result = analyze(client, source["id"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert provider.color == (255, 0, 0) and provider.size == (80, 60)
    assert body["requirements"][0]["origin"] == "proposal"
    ref = body["source_refs"][0]
    assert ref["kind"] == "image_reference" and ref["region"] is None and ref["scope"] == "whole_image"
    assert ref["sha256"] == source["sha256"] and ref["canonical_sha256"] == source["canonical_sha256"]
    assert "quote" not in ref and "start" not in ref and "end" not in ref
    assert body["requirements"][0]["source_refs"] == [ref]
    assert analyze(client, source["id"]).json() == body
    assert len(provider.inputs) == 1
    assert analyze(client, source["id"], {"region": {"x": 0, "y": 0, "width": 5, "height": 5}}).status_code == 409
    assert analyze(client, source["id"], sid=client.other).status_code == 404


def test_selected_region_crops_actual_pixels_and_uses_canonical_coordinates(client, provider):
    stream = io.BytesIO()
    image = Image.new("RGB", (80, 60), "red")
    image.paste("blue", (40, 20, 70, 50))
    image.save(stream, "PNG")
    source = upload(client, stream.getvalue()).json()
    region = {"x": 40, "y": 20, "width": 30, "height": 30}
    result = analyze(client, source["id"], {"region": region}).json()
    assert provider.size == (30, 30) and provider.color == (0, 0, 255)
    assert result["source_refs"][0]["region"] == region
    assert result["source_refs"][0]["scope"] == "selected_region"
    assert result["source_refs"][0]["coordinate_space"] == "canonical_pixels"


@pytest.mark.parametrize("region", [
    {"x": -1, "y": 0, "width": 3, "height": 3},
    {"x": 0.5, "y": 0, "width": 3, "height": 3},
    {"x": True, "y": 0, "width": 3, "height": 3},
    {"x": 0, "y": 0, "width": 0, "height": 3},
    {"x": 79, "y": 0, "width": 3, "height": 3},
])
def test_invalid_regions_do_not_call_provider(client, provider, region):
    source = upload(client).json()
    assert analyze(client, source["id"], {"region": region}).status_code == 422
    assert not provider.inputs


def test_reject_paths_urls_symlinks_models_and_extra_fields(client, tmp_path):
    target = tmp_path / "source.png"
    target.write_bytes(image_bytes())
    link = tmp_path / "link.png"
    link.symlink_to(target)
    # API only accepts multipart bytes; a symlink/path/URL is never opened by the server.
    for body in ({"path": str(link)}, {"url": "file:///etc/passwd"}, {"file": "https://example.com/x.png"}):
        response = client.post(f"/api/sessions/{client.sid}/images", json=body, headers={"Idempotency-Key": "x"})
        assert response.status_code == 422
    for data in (str(link).encode(), b"PK\x03\x04archive", b"cos\nsystem\nR."):
        assert upload(client, data).status_code == 422
    source = upload(client).json()
    response = analyze(client, source["id"], {"tools": ["shell"], "path": str(link)})
    assert response.status_code == 422


def test_metadata_secrets_do_not_reach_provider_or_storage(client, provider, store):
    meta = PngImagePlugin.PngInfo()
    secret = "PRIVATE_SYNTHETIC_SECRET"
    meta.add_text("instructions", secret)
    source = upload(client, image_bytes(pnginfo=meta)).json()
    response = analyze(client, source["id"])
    assert response.status_code == 200
    assert secret not in response.text
    assert secret.encode() not in provider.inputs[0]
    with store.transaction() as db:
        row = db.execute("SELECT metadata_json,canonical_png FROM image_sources").fetchone()
        assert secret not in row[0] and secret.encode() not in row[1]


def test_unsupported_provider_has_no_invented_text(client, provider, store):
    async def unsupported(png):
        raise AgentError("PROVIDER_IMAGE_UNSUPPORTED", "source-secret-must-not-leak")
    provider.analyze = unsupported
    source = upload(client).json()
    response = analyze(client, source["id"])
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_IMAGE_UNSUPPORTED"
    assert "source-secret" not in response.text and "requirements" not in response.json()
    with store.transaction() as db:
        row = db.execute("SELECT state,response_json,error_code FROM image_analyses").fetchone()
        assert tuple(row) == ("failed", None, "PROVIDER_IMAGE_UNSUPPORTED")
    assert analyze(client, source["id"]).status_code == 409


def test_timeout_is_persisted_and_can_be_retried_with_new_key(client, provider):
    async def timeout(png):
        raise TimeoutError()
    provider.analyze = timeout
    source = upload(client).json()
    assert analyze(client, source["id"]).json()["error"]["code"] == "PROVIDER_TIMEOUT"
    assert analyze(client, source["id"], key="retry").status_code == 503


def test_upload_bounds_real_body_not_only_content_length(client):
    path = f"/api/sessions/{client.sid}/images"
    for length in ("99999999", "1"):
        response = client.post(path, content=b"x" * 300000, headers={"Content-Length": length,
            "Content-Type": "multipart/form-data; boundary=x", "Idempotency-Key": "big"})
        assert response.status_code == 413
    assert client.post(path, content=b"x", headers={"Content-Length": "invalid", "Idempotency-Key": "none"}).status_code == 411
    response = client.post(path, files=[("file", ("a.png", image_bytes())), ("file", ("b.png", image_bytes()))],
                           headers={"Idempotency-Key": "many"})
    assert response.status_code == 422


def test_recovery_and_concurrency(client, provider, store):
    source = upload(client).json()
    service = client.app.state.images
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        original = provider.analyze
        async def blocked(png):
            entered.set()
            await release.wait()
            return await original(png)
        provider.analyze = blocked
        first = asyncio.create_task(service.analyze(client.sid, source["id"], ImageAnalysisCreate(), "first"))
        await entered.wait()
        with pytest.raises(ServiceError) as error:
            await service.analyze(client.sid, source["id"], ImageAnalysisCreate(), "second")
        assert error.value.status == 429
        release.set()
        await first
        assert service.active == 0
    asyncio.run(scenario())
    service.store.reserve(source["id"], {"region": None}, "abandoned")
    service.store.recover()
    with store.transaction() as db:
        row = db.execute("SELECT state,error_code FROM image_analyses WHERE request_key='abandoned'").fetchone()
        assert tuple(row) == ("failed", "IMAGE_ANALYSIS_INTERRUPTED")


def test_openapi_contract_is_additive_and_refs_are_distinct(client):
    schema = client.get("/openapi.json").json()
    assert schema["components"]["schemas"]["ImageRef"]["properties"]["kind"]["const"] == "image_reference"
    assert "quote" not in schema["components"]["schemas"]["ImageRef"]["properties"]


def test_persisted_analysis_is_available_after_reload(client, provider):
    source = upload(client).json()
    result = analyze(client, source["id"]).json()
    path = f'/api/sessions/{client.sid}/images/{source["id"]}/analyses'
    records = client.get(path).json()
    assert records == [{"id": result["id"], "source_id": source["id"], "state": "completed", "error_code": None, "result": result}]
    assert client.get(path.replace(client.sid, client.other)).status_code == 404
    async def fail(png):
        raise AgentError("PROVIDER_IMAGE_UNSUPPORTED", "no vision")
    provider.analyze = fail
    assert analyze(client, source["id"], key="failed").status_code == 503
    records = client.get(path).json()
    assert records[1]["state"] == "failed" and records[1]["result"] is None
    assert records[1]["error_code"] == "PROVIDER_IMAGE_UNSUPPORTED"


def test_corrupt_saved_image_is_not_sent_to_provider(client, provider, store):
    source = upload(client).json()
    with store.transaction(write=True) as db:
        db.execute("UPDATE image_sources SET canonical_png=? WHERE id=?", (b"corrupt", source["id"]))
    response = analyze(client, source["id"])
    assert response.status_code == 503 and response.json()["error"]["code"] == "IMAGE_SOURCE_CORRUPT"
    assert not provider.inputs
