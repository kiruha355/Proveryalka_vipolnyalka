import pytest
import asyncio
from types import SimpleNamespace
from proveryalka.delivery_provider import Budget, main


def test_provider_budget_caps_calls_total_input_and_output_tokens():
    budget = Budget(1, 512, 1000, 10)
    assert budget.reserve({"input": "bounded", "max_output_tokens": 10000})["max_output_tokens"] == 512
    with pytest.raises(RuntimeError, match="BUDGET_EXHAUSTED"):
        budget.reserve({"input": "second"})
    budget = Budget(2, 512, 1000, 10)
    with pytest.raises(RuntimeError, match="BUDGET_EXHAUSTED"):
        budget.reserve({"input": "x" * 1001})
    assert budget.calls == 0
    budget.deadline = 0
    with pytest.raises(RuntimeError, match="BUDGET_EXHAUSTED"):
        budget.reserve({"input": "late"})


def test_provider_lane_rejects_subscription_without_auth_access(tmp_path, monkeypatch):
    monkeypatch.setenv("PROVERYALKA_LLM_PROVIDER", "codex")
    with pytest.raises(SystemExit) as error:
        main(["--confirm-provider-spend", "--output", str(tmp_path / "out")])
    assert error.value.code == 2 and not (tmp_path / "out").exists()


def test_provider_factory_applies_cap_before_real_sdk_boundary(monkeypatch):
    from proveryalka.delivery_provider import install_budget
    from proveryalka.agent import dialogue, verification
    import openai
    constructed, calls = [], []
    async def response(**kwargs):
        calls.append(kwargs)
        return "response"
    def factory(**kwargs):
        constructed.append(kwargs)
        return SimpleNamespace(responses=SimpleNamespace(create=response))
    monkeypatch.setattr(openai, "AsyncOpenAI", factory)
    monkeypatch.setattr(dialogue, "create_client", dialogue.create_client)
    monkeypatch.setattr(verification, "create_client", verification.create_client)
    for key, value in {"OPENAI_API_KEY": "fixture-key", "OPENAI_BASE_URL": "https://fixture.invalid/v1", "OPENAI_MODEL": "fixture-model"}.items():
        monkeypatch.setenv(key, value)
    install_budget(Budget(1, 512, 1000, 10))
    client = dialogue.create_client()
    assert asyncio.run(client.responses.create(input="hello")) == "response"
    with pytest.raises(RuntimeError, match="BUDGET_EXHAUSTED"):
        asyncio.run(verification.create_client().responses.create(input="again"))
    assert len(calls) == 1 and calls[0]["max_output_tokens"] == 512
    assert all(item["max_retries"] == 0 and item["timeout"] <= 10 for item in constructed)
