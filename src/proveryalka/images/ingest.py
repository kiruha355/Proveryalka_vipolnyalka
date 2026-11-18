"""Из недоверенных bytes в один canonical PNG. Файловые пути не принимаются."""
import hashlib
import io
import warnings
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

from ..api.documents import clean_filename
from ..services import ServiceError


@dataclass(frozen=True)
class ImageLimits:
    max_bytes: int = 8 * 1024 * 1024
    max_pixels: int = 16_000_000
    max_edge: int = 8192
    max_canonical_bytes: int = 32 * 1024 * 1024
    analysis_timeout: float = 180
    parallel: int = 1


FORMATS = {
    ".png": ("PNG", "png", "image/png"),
    ".jpg": ("JPEG", "jpeg", "image/jpeg"),
    ".jpeg": ("JPEG", "jpeg", "image/jpeg"),
    ".webp": ("WEBP", "webp", "image/webp"),
}


def invalid(code="IMAGE_INVALID", status=422):
    return ServiceError(status, code, {
        "IMAGE_INVALID": "Изображение повреждено или не соответствует формату",
        "IMAGE_TOO_LARGE": "Изображение превышает допустимый размер",
        "IMAGE_MULTIFRAME": "Изображения с несколькими кадрами не поддерживаются",
        "IMAGE_TYPE_MISMATCH": "Тип файла не соответствует содержимому",
        "UNSUPPORTED_IMAGE": "Поддерживаются PNG, JPEG и WebP с одним кадром",
    }[code])


def dimensions(image, limits):
    width, height = image.size
    if width < 1 or height < 1 or max(width, height) > limits.max_edge or width * height > limits.max_pixels:
        raise invalid("IMAGE_TOO_LARGE", 413)
    if getattr(image, "n_frames", 1) != 1:
        raise invalid("IMAGE_MULTIFRAME")


def ingest_image(filename, data: bytes, content_type=None, limits=None):
    limits = limits or ImageLimits()
    name = clean_filename(filename)
    suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix not in FORMATS:
        raise invalid("UNSUPPORTED_IMAGE", 415)
    if len(data) > limits.max_bytes:
        raise invalid("IMAGE_TOO_LARGE", 413)
    expected, kind, media_type = FORMATS[suffix]
    supplied_type = (content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    if supplied_type not in (media_type, "application/octet-stream"):
        raise invalid("IMAGE_TYPE_MISMATCH", 415)
    signature = (data.startswith(b"\x89PNG\r\n\x1a\n") if expected == "PNG" else
                 data.startswith(b"\xff\xd8\xff") if expected == "JPEG" else
                 data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    if not signature:
        raise invalid()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=[expected]) as image:
                dimensions(image, limits)  # Before any decoded pixel allocation.
                image.verify()
            with Image.open(io.BytesIO(data), formats=[expected]) as image:
                dimensions(image, limits)
                image.load()  # verify alone does not catch truncated JPEG pixel streams.
                oriented = ImageOps.exif_transpose(image)
                # Fresh image drops EXIF, comments, ICC, text, XMP, paths and trailing bytes.
                mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
                converted = oriented.convert(mode)
                canonical = Image.new(mode, converted.size)
                canonical.paste(converted)
                out = io.BytesIO()
                canonical.save(out, format="PNG")
                width, height = canonical.size
                pixels = out.getvalue()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise invalid("IMAGE_TOO_LARGE", 413) from error
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as error:
        raise invalid() from error
    if len(pixels) > limits.max_canonical_bytes:
        raise invalid("IMAGE_TOO_LARGE", 413)
    return {
        "filename": name, "format": kind, "media_type": media_type,
        "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
        "width": width, "height": height, "canonical_sha256": hashlib.sha256(pixels).hexdigest(),
        "canonical_size_bytes": len(pixels),
    }, pixels


def crop_image(data, region, width, height):
    if region is None:
        return data
    if region.x + region.width > width or region.y + region.height > height:
        raise ServiceError(422, "IMAGE_REGION_INVALID", "Область выходит за границы изображения")
    with Image.open(io.BytesIO(data), formats=["PNG"]) as image:
        image = image.crop((region.x, region.y, region.x + region.width, region.y + region.height))
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()
