"""Load the observations behind a text projection used in an analyst turn."""
import json

from .storage import ImageStore, image_projection


def dialogue_observations(store, session_id, sources):
    # The image-source attachment workflow owns this relation.
    if not sources or not hasattr(ImageStore, "attach"):
        return {}
    placeholders = ",".join("?" for _ in sources)
    with store.transaction() as db:
        rows = db.execute(f"""
            SELECT c.source_id, a.response_json FROM image_source_contexts c
            JOIN image_analyses a ON a.id=c.analysis_id
            JOIN image_sources i ON i.id=a.source_id AND i.session_id=c.session_id
            WHERE c.session_id=? AND a.state='completed' AND c.source_id IN ({placeholders})
        """, (session_id, *(source.id for source in sources))).fetchall()
    observations = {}
    for row in rows:
        result = json.loads(row["response_json"])
        _, visible_ranges = image_projection(result)
        observations[row["source_id"]] = {
            "analysis_id": result["id"],
            "image_ref": result["source_refs"][0],
            "visible": [item["text"] for item in result["requirements"] if item["origin"] == "visible"],
            "visible_ranges": visible_ranges,
            "proposals": [item["text"] for item in result["requirements"] if item["origin"] == "proposal"],
            "uncertainties": result["uncertainties"],
        }
    return observations


def validate_observations(draft, sources, observations, introduced_source_id):
    if not observations:
        return
    evidence = {
        source.id: observations[source.id]["visible"] if source.id in observations else [source.text]
        for source in sources
    }

    def supported(source_id, quote):
        return quote.strip() and any(quote in text for text in evidence.get(source_id, ()))

    analysis = draft.analysis
    for requirement in analysis.requirements:
        if requirement.source_id in observations and not supported(requirement.source_id, requirement.quote):
            raise ValueError("Требование из изображения должно опираться на видимое наблюдение")
    for fact in (*analysis.entities, *analysis.participants, *analysis.initial_state,
                 *analysis.variables, *analysis.events, *analysis.properties):
        if not any(supported(source_id, fact.quote) for source_id in evidence):
            raise ValueError("Факт или элемент модели требует видимого наблюдения или текстового источника")

    current = observations.get(introduced_source_id)
    ambiguities = [text for text in (*current["uncertainties"], *current["proposals"]) if text.strip()] if current else []
    if ambiguities:
        if not any(fragment in question.reason for fragment in ambiguities for question in draft.questions):
            raise ValueError("По неоднозначному изображению нужен новый уточняющий вопрос с цитатой из uncertainties или proposals в reason")
        return introduced_source_id
