from contextlib import asynccontextmanager

from fastapi import APIRouter, Header, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException

from ..contracts import ErrorResponse
from ..services import ServiceError
from .dto import ImageAnalysis, ImageAnalysisCreate, ImageAnalysisRecord, ImageSource
from .service import ImageService


def create_images_router(store, limits=None, provider=None):
    service = ImageService(store, limits, provider)

    @asynccontextmanager
    async def lifespan(app):
        # Called after parent initializes migrations, like the codegen router.
        service.store.recover()
        yield

    router = APIRouter(prefix="/api/sessions/{session_id}/images", tags=["images"], lifespan=lifespan)
    router.images = service
    errors = {code: {"model": ErrorResponse} for code in (404, 409, 411, 413, 415, 422, 429, 503)}

    @router.post("", response_model=ImageSource, status_code=201, responses=errors,
        openapi_extra={"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
            "type": "object", "required": ["file"], "additionalProperties": False,
            "properties": {"file": {"type": "string", "format": "binary", "description": "PNG, JPEG, WebP (один кадр)"}},
        }}}}})
    async def upload(session_id: str, request: Request, idempotency_key: str = Header(min_length=1, max_length=128)):
        length = request.headers.get("content-length", "")
        if not length.isdigit():
            raise ServiceError(411, "LENGTH_REQUIRED", "Для загрузки нужен Content-Length")
        maximum = service.limits.max_bytes + 64 * 1024
        if int(length) > maximum:
            raise ServiceError(413, "IMAGE_TOO_LARGE", "Изображение превышает допустимый размер")
        # Content-Length is untrusted; count real chunks before multipart spools to disk.
        chunks = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > maximum:
                raise ServiceError(413, "IMAGE_TOO_LARGE", "Изображение превышает допустимый размер")
            chunks.append(chunk)
        async def receive():
            return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
        bounded = Request(request.scope, receive)
        try:
            form = await bounded.form(max_files=1, max_fields=0)
        except HTTPException as error:
            raise ServiceError(422, "INVALID_REQUEST", "Нужен multipart с одним полем file") from error
        try:
            upload = form.get("file")
            if len(form.multi_items()) != 1 or not isinstance(upload, UploadFile):
                raise ServiceError(422, "INVALID_REQUEST", "Нужен multipart с одним полем file")
            data = await upload.read(service.limits.max_bytes + 1)
            return await run_in_threadpool(service.upload, session_id, upload.filename, data,
                                          upload.content_type, idempotency_key)
        finally:
            await form.close()

    @router.get("", response_model=list[ImageSource], responses=errors)
    async def list_images(session_id: str):
        return await run_in_threadpool(service.store.list, session_id)

    @router.get("/{source_id}", response_model=ImageSource, responses=errors)
    async def get_image(session_id: str, source_id: str):
        source, _ = await run_in_threadpool(service.store.get, session_id, source_id)
        return source

    @router.get("/{source_id}/content", responses=errors, response_class=Response)
    async def content(session_id: str, source_id: str):
        _, pixels = await run_in_threadpool(service.store.get, session_id, source_id)
        return Response(pixels, media_type="image/png", headers={
            "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
            "Content-Disposition": 'inline; filename="image.png"',
        })

    @router.get("/{source_id}/analyses", response_model=list[ImageAnalysisRecord], responses=errors)
    async def analyses(session_id: str, source_id: str):
        return await run_in_threadpool(service.store.analyses, session_id, source_id)

    @router.post("/{source_id}/analysis", response_model=ImageAnalysis, responses=errors)
    async def analyze(session_id: str, source_id: str, body: ImageAnalysisCreate,
                      idempotency_key: str = Header(min_length=1, max_length=128)):
        return await service.analyze(session_id, source_id, body, idempotency_key)

    return router
