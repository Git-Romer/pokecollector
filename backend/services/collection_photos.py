"""Normalising owner-supplied card photos before they are stored.

Every photo that becomes part of a collection goes through here, whether it came
from the scanner or from a direct upload, because all three things this does are
things you only want to think about once.

Stripping metadata is the reason it exists. A phone photograph carries EXIF, and
EXIF routinely carries GPS coordinates, a camera serial number and a timestamp.
A scan photo was previously transient — taken, matched, discarded — and keeping
it as the card's picture turns it into stored data, and into something that
leaves the instance the moment the owner exports or shares a collection. None of
that metadata describes the card, so none of it is kept.

Re-encoding also bounds the size: these live in Postgres rather than on a CDN,
and a modern phone photo is several megabytes against roughly 200 KB for a
catalogue scan of the same card.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# Comfortably above a TCGdex "high" scan (roughly 1000x1400), so the photo is
# never the limiting factor when comparing it against the real card, and far
# below what a phone produces.
MAX_EDGE = 1400
JPEG_QUALITY = 88

# Refuse anything that is not plausibly a card photo before decoding it.
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
# Reject pathological dimensions from the header before Pillow decodes the
# pixel buffer. 40 MP comfortably covers modern phone cameras while preventing
# a small compressed decompression bomb from consuming unbounded memory.
MAX_SOURCE_PIXELS = 40_000_000


class InvalidPhoto(ValueError):
    """Not an image, or one we will not store."""


def normalize_photo(data: bytes) -> tuple[bytes, str]:
    """Return (jpeg_bytes, content_type), stripped of metadata and bounded in size.

    Raises InvalidPhoto if the bytes are not a decodable image.
    """
    if not data:
        raise InvalidPhoto("Empty image")
    if len(data) > MAX_UPLOAD_BYTES:
        raise InvalidPhoto("Image too large")

    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(data))
        width, height = img.size
        if width <= 0 or height <= 0 or width * height > MAX_SOURCE_PIXELS:
            raise InvalidPhoto("Image dimensions are too large")
        # Honour the orientation flag before discarding it, or stripping EXIF
        # would leave photos from every phone on their side. This also means the
        # stored bytes are upright, so nothing downstream has to re-read it.
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
    except InvalidPhoto:
        raise
    except Exception as exc:
        raise InvalidPhoto("Could not read this image") from exc

    width, height = img.size
    longest = max(width, height)
    if longest > MAX_EDGE:
        scale = MAX_EDGE / longest
        img = img.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)

    buf = io.BytesIO()
    # A fresh image saved without an `exif` argument carries no EXIF, so this is
    # the strip: nothing is copied across from the original.
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue(), "image/jpeg"
