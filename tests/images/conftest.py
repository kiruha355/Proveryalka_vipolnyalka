"""Isolated testapp applies 007 and mounts the production router without touching shared files."""
import io
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from PIL import Image

from proveryalka.images.dto import ImageDraft, VisualRequirement
from proveryalka.images.ingest import ImageLimits
from proveryalka.images.router import create_images_router
from proveryalka.services import ServiceError
from proveryalka.storage.sqlite import SQLiteStore


MIGRATION = Path(__file__).parents[2] / "src/proveryalka/storage/migrations/007_images.sql"


def image_bytes(format="PNG", size=(80, 60), color="red", **kwargs):
    stream = io.BytesIO()
    Image.new("RGB", size, color).save(stream, format, **kwargs)
    return stream.getvalue()


class InspectProvider:
    def __init__(self):
        self.inputs = []

    def name(self):
        return "codex"

    async def analyze(self, png):
        self.inputs.append(png)
        with Image.open(io.BytesIO(png)) as image:
            self.size = image.size
            self.color = image.convert("RGB").getpixel((0, 0))
        return ImageDraft(description="Красный прямоугольник", requirements=[
            VisualRequirement(text="Предлагается использовать красный для предупреждения", origin="proposal"),
        ], uncertainties=["Правило продукта не задано"])


def testapp(store, provider, limits=None):
    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        with store.transaction(write=True) as db:
            for statement in MIGRATION.read_text().split(";"):
                if statement.strip():
                    db.execute(statement)
        yield
    app = FastAPI(lifespan=lifespan)
    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse(status_code=error.status, content={"error": {"code": error.code, "message": error.message, "details": []}})
    router = create_images_router(store, limits or ImageLimits(max_bytes=200_000), provider)
    app.include_router(router)
    app.state.images = router.images
    return app


testapp.__test__ = False


@pytest.fixture
def provider():
    return InspectProvider()


@pytest.fixture
def store(tmp_path):
    return SQLiteStore(tmp_path / "db")


@pytest.fixture
def client(store, provider):
    with TestClient(testapp(store, provider)) as client:
        client.sid = store.create_session({"title": "Изображения"}, "session")["id"]
        client.other = store.create_session({"title": "Другая"}, "other")["id"]
        yield client


def upload(client, data=None, filename="image.png", mime="image/png", key="image"):
    return client.post(f"/api/sessions/{client.sid}/images", files={"file": (filename, image_bytes() if data is None else data, mime)},
                       headers={"Idempotency-Key": key})


def analyze(client, source_id, body=None, key="analysis", sid=None):
    return client.post(f"/api/sessions/{sid or client.sid}/images/{source_id}/analysis", json=body or {},
                       headers={"Idempotency-Key": key})
