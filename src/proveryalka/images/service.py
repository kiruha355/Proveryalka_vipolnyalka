import asyncio
from uuid import NAMESPACE_URL, uuid5

from ..agent.errors import AgentError
from ..services import ServiceError
from .dto import ImageAnalysis, ImageRef, ImageRequirement
from .ingest import ImageLimits, crop_image, ingest_image
from .provider import ImageProvider
from .storage import ImageStore


class ImageService:
    def __init__(self, store, limits=None, provider=None):
        self.store = ImageStore(store)
        self.limits = limits or ImageLimits()
        self.provider = provider or ImageProvider()
        self.active = 0

    def upload(self, session_id, filename, data, content_type, key):
        metadata, pixels = ingest_image(filename, data, content_type, self.limits)
        return self.store.create(session_id, metadata, pixels, key)

    async def analyze(self, session_id, source_id, body, key):
        source, pixels = await asyncio.to_thread(self.store.get, session_id, source_id)
        png = await asyncio.to_thread(crop_image, pixels, body.region, source.width, source.height)
        provider = self.provider.name()
        # No await between admission check and increment: one router per application event loop.
        if self.active >= self.limits.parallel:
            raise ServiceError(429, "IMAGE_ANALYSIS_BUSY", "Дождитесь завершения текущего разбора изображения")
        self.active += 1
        aid = None
        try:
            aid, saved = self.store.reserve(source_id, {**body.model_dump(mode="json"), "provider": provider}, key)
            if saved is not None:
                return ImageAnalysis.model_validate(saved)
            draft = await asyncio.wait_for(self.provider.analyze(png), self.limits.analysis_timeout)
            ref = ImageRef(source_id=source_id, sha256=source.sha256, canonical_sha256=source.canonical_sha256,
                           region=body.region, scope="selected_region" if body.region else "whole_image")
            requirements = [ImageRequirement(**item.model_dump(), source_refs=[ref],
                id="imgreq_" + uuid5(NAMESPACE_URL, f"{aid}:{i}:{item.text}").hex)
                for i, item in enumerate(draft.requirements)]
            result = ImageAnalysis(id=aid, source_id=source_id, provider=provider, description=draft.description,
                                   requirements=requirements, uncertainties=draft.uncertainties, source_refs=[ref])
            self.store.finish(aid, result.model_dump(mode="json"))
            return result
        except (AgentError, TimeoutError) as error:
            code = "PROVIDER_TIMEOUT" if isinstance(error, TimeoutError) else error.code
            if aid is not None:
                self.store.finish(aid, code=code)
            raise ServiceError(503, code, "Не удалось выполнить разбор изображения") from error
        except BaseException:
            if aid is not None:
                self.store.finish(aid, code="IMAGE_ANALYSIS_INTERRUPTED")
            raise
        finally:
            self.active -= 1
