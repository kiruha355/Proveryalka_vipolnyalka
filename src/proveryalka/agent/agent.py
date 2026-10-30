from agents import Agent
from openai import AsyncOpenAI

from .llm_config import create_model
from .prompts import ANALYST_INSTRUCTIONS


def create_agent(client: AsyncOpenAI) -> Agent:
    return Agent(
        name="Analyst Agent",
        instructions=ANALYST_INSTRUCTIONS,
        model=create_model(client),
    )
