"""Адаптер Codex app-server на фальшивом сервере: форма протокола, изоляция и ошибки без реальной модели."""
import asyncio
import json
import os
import stat
import sys
from pathlib import Path

import pytest
from agents import ModelBehaviorError, ModelSettings, RunConfig

from proveryalka.agent import llm_config
from proveryalka.agent.agent import create_agent
from proveryalka.agent.codex_runtime import CodexClient, DISABLED_FEATURES
from proveryalka.agent.errors import AgentError, run_agent
from proveryalka.contracts import Contract


SERVER = Path(__file__).parent / "fixtures/fake_codex_app_server.py"


class Smoke(Contract):
    answer: str
    count: int


@pytest.fixture
def codex(tmp_path, monkeypatch):
    executable = tmp_path / "codex"
    executable.write_text(f"#!/bin/sh\nexec {sys.executable} -I {SERVER} \"$@\"\n")
    executable.chmod(executable.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("PROVERYALKA_LLM_PROVIDER", "codex")
    monkeypatch.setenv("PROVERYALKA_CODEX_BIN", str(executable))
    monkeypatch.setenv("FAKE_CODEX_LOG", str(log))

    def messages():
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    return messages


def ask():
    async def scenario():
        async with llm_config.create_client() as client:
            agent = create_agent(client).clone(output_type=Smoke)
            result = await run_agent(agent, input="Сколько слов?", max_turns=1,
                                     run_config=RunConfig(tracing_disabled=True, model_settings=ModelSettings(store=False)))
        return client, result.final_output
    return asyncio.run(scenario())


def requests(messages, method):
    return [m["params"] for m in messages if m.get("method") == method]


def test_structured_answer_goes_through_pydantic_and_isolated_thread(codex):
    client, output = ask()
    assert output == Smoke(answer="да", count=4)
    assert client.process.returncode is not None and not Path(client.workdir).exists()
    log = codex()
    argv = log[0]["argv"]
    assert argv[:3] == ["app-server", "--listen", "stdio://"]
    assert all(f"features.{name}=false" in argv for name in DISABLED_FEATURES)
    thread = requests(log, "thread/start")[0]
    assert thread["ephemeral"] is True and thread["sandbox"] == "read-only" and thread["approvalPolicy"] == "never"
    assert thread["config"] == {"mcp_servers": {"docs": {"enabled": False}}}
    assert "Ты — аналитик" in thread["developerInstructions"]
    turn = requests(log, "turn/start")[0]
    assert turn["sandboxPolicy"] == {"type": "readOnly", "networkAccess": False}
    assert set(turn["outputSchema"]["properties"]) == {"answer", "count"}
    assert turn["input"] == [{"type": "text", "text": "Сколько слов?"}]


def test_structured_answer_is_validated(codex, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_ANSWER", '{"answer":"да","count":"четыре"}')
    # Тот же тип ошибки, что у Responses API: generate_state повторяет запрос с диагностикой.
    with pytest.raises(ModelBehaviorError):
        ask()


@pytest.mark.parametrize("mode,code,model_called", [
    ("logged_out", "PROVIDER_AUTH", False),
    ("mcp_enabled", "PROVIDER_ISOLATION", False),
    ("unsafe_sandbox", "PROVIDER_ISOLATION", False),
    ("tool", "PROVIDER_TOOL_USE", True),
    ("failed", "PROVIDER_RATE_LIMIT", True),
])
def test_unsafe_or_failed_turns_stop_with_codes(codex, monkeypatch, mode, code, model_called):
    monkeypatch.setenv("FAKE_CODEX_MODE", mode)
    with pytest.raises(AgentError) as error:
        ask()
    assert error.value.code == code
    log = codex()
    assert bool(requests(log, "turn/start")) is model_called
    if mode == "tool":
        assert requests(log, "turn/interrupt") == [{"threadId": "t1", "turnId": "u1"}]


def test_approval_requests_are_declined(codex, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "approval")
    _, output = ask()
    assert output.count == 4
    assert {"id": "srv1", "result": {"decision": "decline"}} in codex()


def test_missing_cli_and_unknown_provider(monkeypatch):
    monkeypatch.setenv("PROVERYALKA_CODEX_BIN", "/nonexistent/codex")
    with pytest.raises(AgentError) as error:
        asyncio.run(CodexClient.from_env().__aenter__())
    assert error.value.code == "PROVIDER_UNAVAILABLE"
    monkeypatch.setenv("PROVERYALKA_LLM_PROVIDER", "codex")
    assert llm_config.provider_configured() is False
    monkeypatch.setenv("PROVERYALKA_LLM_PROVIDER", "mai-without-tls")
    with pytest.raises(ValueError):
        llm_config.provider_name()
