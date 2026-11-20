import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from agents import OpenAIResponsesModel
from dotenv import load_dotenv
from openai import AsyncOpenAI, DefaultAsyncHttpx2Client


PROVIDERS = ("openai", "codex")


def provider_name() -> str:
    """openai — OpenAI-совместимый Responses API по ключу; codex — локальный Codex app-server по подписке."""
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    name = os.getenv("PROVERYALKA_LLM_PROVIDER", "openai")
    if name not in PROVIDERS:
        raise ValueError(f"PROVERYALKA_LLM_PROVIDER должен быть одним из: {', '.join(PROVIDERS)}")
    return name


def provider_configured() -> bool:
    """Наличие настроек, а не успешная авторизация: ключ и подписка проверяются первым запросом."""
    if provider_name() == "codex":
        return shutil.which(os.getenv("PROVERYALKA_CODEX_BIN", "codex")) is not None
    return bool(os.getenv("OPENAI_API_KEY") and os.getenv("OPENAI_BASE_URL"))


def create_client():
    if provider_name() == "codex":
        from .codex_runtime import CodexClient

        return CodexClient.from_env()
    base_url = os.environ["OPENAI_BASE_URL"]
    verify_ssl = urlsplit(base_url).hostname != "api-ai.mai.ru"
    return AsyncOpenAI(
        base_url=base_url,
        api_key=os.environ["OPENAI_API_KEY"],
        timeout=300.0,
        max_retries=0,
        http_client=DefaultAsyncHttpx2Client(verify=verify_ssl),
    )


def create_model(client):
    from .codex_runtime import CodexClient, CodexModel

    if isinstance(client, CodexClient):
        return CodexModel(client)
    return OpenAIResponsesModel(
        model=os.getenv("OPENAI_MODEL", "deepseek-v4.1-flash"),
        openai_client=client,
    )
