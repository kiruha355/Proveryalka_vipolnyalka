from ..contracts import Source
from .analysis import Analysis
from .dialogue import generate_state


async def extract_requirements(source: Source) -> Analysis:
    if not source.text.strip():
        raise ValueError("Исходный текст не должен быть пустым")
    state = await generate_state({"sources": [source.model_dump()]}, [source], None, None, 5)
    return state.analysis
