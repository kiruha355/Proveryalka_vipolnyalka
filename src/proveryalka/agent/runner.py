from agents import ModelSettings, RunConfig, Session

from .agent import create_agent
from .llm_config import create_client
from .errors import check_context, run_agent


async def run_message(
    message: str,
    session: Session,
) -> str:
    check_context({"history": await session.get_items(), "message": message})
    async with create_client() as client:
        result = await run_agent(
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
