"""Публичный additive контракт изображений; текстовые Source/SourceRef не меняются."""
from typing import Literal

from pydantic import Field, StrictInt, StrictStr

from ..contracts import Contract


class ImageRegion(Contract):
    """Полуоткрытый прямоугольник [x, x+width) × [y, y+height), пиксели canonical PNG."""
    x: StrictInt = Field(ge=0)
    y: StrictInt = Field(ge=0)
    width: StrictInt = Field(gt=0)
    height: StrictInt = Field(gt=0)


class ImageSource(Contract):
    id: str
    session_id: str
    kind: Literal["image"] = "image"
    filename: str
    format: Literal["png", "jpeg", "webp"]
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    size_bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    # Provider, content endpoint and coordinates use this metadata-free oriented PNG.
    canonical_media_type: Literal["image/png"] = "image/png"
    canonical_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    canonical_size_bytes: int = Field(gt=0)
    coordinate_space: Literal["canonical_pixels"] = "canonical_pixels"


class ImageRef(Contract):
    kind: Literal["image_reference"] = "image_reference"
    source_id: str
    sha256: str
    canonical_sha256: str
    coordinate_space: Literal["canonical_pixels"] = "canonical_pixels"
    # null means the entire image, not unknown OCR coordinates.
    region: ImageRegion | None = None
    scope: Literal["whole_image", "selected_region"]


class ImageAnalysisCreate(Contract):
    region: ImageRegion | None = None


class VisualRequirement(Contract):
    text: StrictStr = Field(min_length=1, max_length=4000)
    # Any inferred product rule is explicitly a proposal, not a fact in the source.
    origin: Literal["visible", "proposal"]


class ImageDraft(Contract):
    description: StrictStr = Field(min_length=1, max_length=8000)
    requirements: list[VisualRequirement] = Field(max_length=100)
    uncertainties: list[StrictStr] = Field(max_length=100)


class ImageRequirement(VisualRequirement):
    id: str
    source_refs: list[ImageRef] = Field(min_length=1)


class ImageAnalysis(Contract):
    id: str
    source_id: str
    provider: Literal["codex", "openai"]
    description: str
    requirements: list[ImageRequirement]
    uncertainties: list[str]
    source_refs: list[ImageRef] = Field(min_length=1)


class ImageAnalysisRecord(Contract):
    id: str
    source_id: str
    state: Literal["running", "completed", "failed"]
    error_code: str | None
    result: ImageAnalysis | None
