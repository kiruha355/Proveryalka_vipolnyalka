from agents import ModelSettings, RunConfig, Runner, Session

from .agent import create_agent
from .llm_config import create_client


async def run_message(
    message: str,
    session: Session,
) -> str:
    async with create_client() as client:
        result = await Runner.run(
            create_agent(client),
            input=message,
            session=session,
            max_turns=1,
            run_config=RunConfig(
                tracing_disabled=True,
                model_settings=ModelSettings(store=False),
            ),
        )
    return result.final_output
