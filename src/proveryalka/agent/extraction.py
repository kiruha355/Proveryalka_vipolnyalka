from agents import ModelSettings, RunConfig, Runner

from ..contracts import Source
from .agent import create_agent
from .analysis import Analysis, ExtractionDraft, build_analysis
from .llm_config import create_client


async def extract_requirements(source: Source) -> Analysis:
    if not source.text.strip():
        raise ValueError("Исходный текст не должен быть пустым")
    async with create_client() as client:
        agent = create_agent(client).clone(output_type=ExtractionDraft)
        result = await Runner.run(
            agent,
            input=source.model_dump_json(),
            max_turns=1,
            run_config=RunConfig(
                tracing_disabled=True,
                model_settings=ModelSettings(store=False),
            ),
        )
    return build_analysis(source, result.final_output)
