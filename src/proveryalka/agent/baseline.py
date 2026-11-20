from .analysis import Analysis
from .clarification import DialogueState


def version_state(model, version_id, max_rounds):
    quotes = {item.id: item.source_refs[0].quote for item in model.requirements}

    def element(item, exclude=()):
        return {**item.model_dump(exclude=set(exclude)), "quote": quotes[item.requirement_ids[0]]}

    analysis = Analysis(
        subject=model.name, source=model.sources[0], requirements=model.requirements,
        entities=[], participants=[], initial_state=[], assumptions=[], contradictions=[],
        variables=[element(item) for item in model.variables],
        events=[element(item) for item in model.transitions],
        properties=[{**element(item, {"approved_by"}), "assumption": item.name if item.approved_by else None}
                    for item in model.properties],
        behavior=model,
    )
    return DialogueState(
        sources=model.sources, analysis=analysis, questions=[], answers=[], corrections=[],
        property_approvals={item.id: item.approved_by for item in model.properties if item.approved_by},
        round=0, max_rounds=max_rounds, status="ready", base_version_id=version_id,
    )
