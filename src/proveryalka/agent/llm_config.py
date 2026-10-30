import os
from pathlib import Path
from urllib.parse import urlsplit

from agents import OpenAIResponsesModel
from dotenv import load_dotenv
from openai import AsyncOpenAI, DefaultAsyncHttpx2Client


def create_client() -> AsyncOpenAI:
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    base_url = os.environ["OPENAI_BASE_URL"]
    verify_ssl = urlsplit(base_url).hostname != "api-ai.mai.ru"
    return AsyncOpenAI(
        base_url=base_url,
        api_key=os.environ["OPENAI_API_KEY"],
        timeout=300.0,
        max_retries=0,
        http_client=DefaultAsyncHttpx2Client(verify=verify_ssl),
    )


def create_model(client: AsyncOpenAI) -> OpenAIResponsesModel:
    return OpenAIResponsesModel(
        model="deepseek-v4.1-flash",
        openai_client=client,
    )
