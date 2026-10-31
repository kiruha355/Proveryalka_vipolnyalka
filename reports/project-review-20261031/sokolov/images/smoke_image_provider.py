"""One opt-in real provider smoke on synthetic pixels, via the application's ImageService.

Run from worktree with its src on PYTHONPATH. No account files or keys are read here.
This does not start any demo server or execute generated code.
"""
import asyncio
import io
import json
import os
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from proveryalka.images.dto import ImageAnalysisCreate
from proveryalka.images.service import ImageService
from proveryalka.storage.sqlite import SQLiteStore


HERE = Path(__file__).resolve().parent


async def main():
    os.environ["PROVERYALKA_LLM_PROVIDER"] = "codex"
    os.environ["PROVERYALKA_CODEX_MODEL"] = "gpt-6.1-sol"
    os.environ["PROVERYALKA_CODEX_EFFORT"] = "xhigh"
    image = Image.new("RGB", (720, 280), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 30, 140, 140), fill="red")
    draw.ellipse((200, 30, 310, 140), fill="blue")
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 36)
    draw.text((30, 195), "Capacity limit: 4827", fill="black", font=font)
    out = io.BytesIO()
    image.save(out, "PNG")
    raw = out.getvalue()
    (HERE / "synthetic-source.png").write_bytes(raw)
    with tempfile.TemporaryDirectory(prefix="proveryalka-image-smoke-") as directory:
        store = SQLiteStore(Path(directory) / "smoke.sqlite")
        store.initialize()
        migration = Path(__import__("proveryalka").__file__).parent / "storage/migrations/007_images.sql"
        with store.transaction(write=True) as db:
            for statement in migration.read_text().split(";"):
                if statement.strip():
                    db.execute(statement)
        sid = store.create_session({"title": "Synthetic image smoke"}, "session")["id"]
        service = ImageService(store)
        source = service.upload(sid, "synthetic.png", raw, "image/png", "image")
        try:
            result = await service.analyze(sid, source["id"], ImageAnalysisCreate(), "smoke")
        except Exception as error:
            (HERE / "provider-smoke.json").write_text(json.dumps({
                "status": "FAIL", "code": getattr(error, "code", type(error).__name__),
                "source": source,
            }, indent=2, ensure_ascii=False))
            raise
        # The prompt never contains 4827; only source pixels carry the value.
        observed = result.description + " " + " ".join(r.text for r in result.requirements)
        assert "4827" in observed, "Provider did not read the value present only in pixels"
        (HERE / "provider-smoke.json").write_text(json.dumps({
            "status": "PASS", "proof": "value 4827 appears only in pixels, absent from provider prompt",
            "provider": "codex", "model_requested": "gpt-6.1-sol", "effort_requested": "xhigh",
            "source": source, "analysis": result.model_dump(mode="json"),
            "limitations": "One synthetic image; no browser, main dialogue chain, CI or production E2E",
        }, indent=2, ensure_ascii=False))
        print("PASS native image pixels reached the provider; value 4827 recovered")


if __name__ == "__main__":
    asyncio.run(main())
