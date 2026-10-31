import asyncio
import base64
import json

import httpx
import pytest
from openai import AsyncOpenAI

from proveryalka.agent.errors import AgentError
from proveryalka.images import provider as module
from proveryalka.images.dto import ImageDraft
from proveryalka.images.provider import ImageProvider
from image_helpers import image_bytes


DRAFT = {"description": "Красный прямоугольник", "requirements": [], "uncertainties": ["Нет правил продукта"]}


def run_provider(monkeypatch, status=200, draft=DRAFT):
    requests = []
    def transport(request):
        requests.append(json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "PRIVATE_PROVIDER_SOURCE_SECRET", "type": "invalid_request_error"}})
        return httpx.Response(200, json={
            "id": "resp_1", "object": "response", "created_at": 0, "status": "completed", "model": "vision-test",
            "output": [{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [
                {"type": "output_text", "text": json.dumps(draft), "annotations": []}]}],
        })
    def create_client():
        return AsyncOpenAI(api_key="synthetic-test-key", base_url="https://provider.invalid/v1", max_retries=0,
                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))
    monkeypatch.setattr(module, "create_client", create_client)
    monkeypatch.setattr(module, "provider_name", lambda: "openai")
    monkeypatch.setenv("PROVERYALKA_OPENAI_VISION", "1")
    monkeypatch.setenv("OPENAI_MODEL", "vision-test")
    png = image_bytes()
    return requests, png


def test_openai_compatible_responses_native_vision_wire_contract(monkeypatch):
    requests, png = run_provider(monkeypatch)
    result = asyncio.run(ImageProvider().analyze(png))
    assert result == ImageDraft.model_validate(DRAFT)
    request = requests[0]
    content = request["input"][0]["content"]
    assert content[1]["type"] == "input_image"
    assert base64.b64decode(content[1]["image_url"].split(",", 1)[1]) == png
    assert request["tools"] == [] and request["tool_choice"] == "none" and request["store"] is False
    assert "недоверенные" in request["instructions"]
    assert request["text"]["format"]["strict"] is True
    assert "quote" not in json.dumps(request["text"]["format"]["schema"])


def test_openai_compatible_unknown_capability_is_rejected_before_network(monkeypatch):
    monkeypatch.setattr(module, "provider_name", lambda: "openai")
    monkeypatch.delenv("PROVERYALKA_OPENAI_VISION", raising=False)
    def forbidden():
        raise AssertionError("client created for unsupported provider")
    monkeypatch.setattr(module, "create_client", forbidden)
    with pytest.raises(AgentError) as error:
        asyncio.run(ImageProvider().analyze(image_bytes()))
    assert error.value.code == "PROVIDER_IMAGE_UNSUPPORTED"


@pytest.mark.parametrize("status,code", [(400, "PROVIDER_IMAGE_UNSUPPORTED"), (401, "PROVIDER_AUTH"),
    (429, "PROVIDER_RATE_LIMIT"), (500, "PROVIDER_UNAVAILABLE")])
def test_provider_rejections_do_not_echo_sensitive_response(monkeypatch, status, code):
    run_provider(monkeypatch, status=status)
    with pytest.raises(AgentError) as error:
        asyncio.run(ImageProvider().analyze(image_bytes()))
    assert error.value.code == code
    assert "PRIVATE" not in str(error.value)


def test_provider_invalid_structured_output_is_not_a_fake_success(monkeypatch):
    run_provider(monkeypatch, draft={"description": "PRIVATE_SECRET", "requirements": "wrong"})
    with pytest.raises(AgentError) as error:
        asyncio.run(ImageProvider().analyze(image_bytes()))
    assert error.value.code == "MODEL_OUTPUT_INVALID" and "PRIVATE_SECRET" not in str(error.value)
