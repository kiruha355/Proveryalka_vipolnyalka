import hashlib
import io
import struct
import zipfile
import zlib

import pytest
from PIL import Image, PngImagePlugin

from proveryalka.images.ingest import ImageLimits, ingest_image
from proveryalka.services import ServiceError
from conftest import image_bytes


def test_pixels_are_real_and_original_metadata_and_trailer_are_removed():
    metadata = PngImagePlugin.PngInfo()
    secret = "PRIVATE_EXIF_TEST_SECRET"
    metadata.add_text("comment", secret)
    raw = image_bytes(pnginfo=metadata) + secret.encode()
    info, png = ingest_image("../../home/secrets/image.png", raw)
    assert info["filename"] == "image.png"
    assert info["sha256"] == hashlib.sha256(raw).hexdigest()
    assert info["canonical_sha256"] == hashlib.sha256(png).hexdigest()
    assert secret.encode() not in png
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (80, 60) and image.getpixel((0, 0)) == (255, 0, 0)
        assert image.info == {}


@pytest.mark.parametrize("format,name,mime", [("PNG", "x.png", "image/png"), ("JPEG", "x.JPEG", "image/jpeg"), ("WEBP", "x.webp", "image/webp")])
def test_real_supported_formats(format, name, mime):
    info, png = ingest_image(name, image_bytes(format=format), mime)
    assert info["media_type"] == mime and info["width"] == 80
    assert png.startswith(b"\x89PNG")


def test_exif_orientation_coordinates_refer_to_displayed_canonical_pixels():
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "PRIVATE_LOCATION"
    info, png = ingest_image("x.jpg", image_bytes("JPEG", exif=exif))
    assert (info["width"], info["height"]) == (60, 80)
    with Image.open(io.BytesIO(png)) as image:
        assert not image.getexif()
    assert b"PRIVATE_LOCATION" not in png


@pytest.mark.parametrize("name,data,mime,code", [
    ("x.png", b"", "image/png", "IMAGE_INVALID"),
    ("x.png", image_bytes("JPEG"), "image/png", "IMAGE_INVALID"),
    ("x.jpg", image_bytes(), "image/jpeg", "IMAGE_INVALID"),
    ("x.png", image_bytes(), "image/jpeg", "IMAGE_TYPE_MISMATCH"),
    ("x.svg", b'<svg onload="steal()"/>', "image/svg+xml", "UNSUPPORTED_IMAGE"),
    ("x.pkl", b"cos\nsystem\n(S'touch /tmp/owned'\ntR.", "application/octet-stream", "UNSUPPORTED_IMAGE"),
    ("x.zip", b"PK\x03\x04", "application/zip", "UNSUPPORTED_IMAGE"),
    ("x.onnx", b"model", None, "UNSUPPORTED_IMAGE"),
    ("x.png", b"PK\x03\x04", "image/png", "IMAGE_INVALID"),
])
def test_reject_nonimages_mismatches_models_archives(name, data, mime, code):
    with pytest.raises(ServiceError) as error:
        ingest_image(name, data, mime)
    assert error.value.code == code


@pytest.mark.parametrize("format,name", [("PNG", "x.png"), ("JPEG", "x.jpg"), ("WEBP", "x.webp")])
def test_truncated_pixel_streams_are_rejected(format, name):
    data = image_bytes(format=format)
    with pytest.raises(ServiceError):
        ingest_image(name, data[:len(data)//2])


@pytest.mark.parametrize("format,name", [("PNG", "x.png"), ("WEBP", "x.webp")])
def test_multiframe_is_rejected(format, name):
    stream = io.BytesIO()
    Image.new("RGB", (10, 10), "red").save(stream, format, save_all=True,
        append_images=[Image.new("RGB", (10, 10), "blue")], duration=100, loop=0)
    with pytest.raises(ServiceError) as error:
        ingest_image(name, stream.getvalue())
    assert error.value.code == "IMAGE_MULTIFRAME"


def test_pixel_and_byte_limits():
    for limits in (ImageLimits(max_pixels=10), ImageLimits(max_edge=2), ImageLimits(max_bytes=4), ImageLimits(max_canonical_bytes=4)):
        with pytest.raises(ServiceError) as error:
            ingest_image("x.png", image_bytes(), limits=limits)
        assert error.value.status == 413 and error.value.code == "IMAGE_TOO_LARGE"


def test_bomb_dimensions_are_rejected_before_load(monkeypatch):
    data = bytearray(image_bytes())
    data[16:24] = struct.pack(">II", 9000, 9000)
    data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]))
    def forbidden(*args, **kwargs):
        raise AssertionError("decoded before dimension limit")
    monkeypatch.setattr(Image.Image, "load", forbidden)
    with pytest.raises(ServiceError) as error:
        ingest_image("x.png", bytes(data))
    assert error.value.code == "IMAGE_TOO_LARGE"
