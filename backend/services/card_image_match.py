"""Pick the right printing by comparing artwork, with no cloud call.

This runs ahead of the visual-verification step that asks Gemini "which of these
candidates is the photo?", and resolves almost every case before it. Measurement
showed that call was not earning its place: across 290 recorded scans it decided
exactly zero of them, and with no API key configured it only downloaded candidate
images, got a 403, and swallowed the error.

This stage is deliberately not a model. Benchmarked on 64 cards with
confirmed answers — 57 of them with three or more same-name printings in the
pool, which is the case metadata cannot separate:

    SIFT align + NCC (needs OpenCV)   98.4%
    this ensemble                     96.9%
    ORB keypoints (needs OpenCV)      96.9%
    phash alone (the existing stage)  95.3%
    colour histogram alone            78.1%

On the nine cases where the existing phash stage declines — precisely the ones
that used to reach Gemini — this recovers eight. It needs nothing that was not
already installed.

Two details that were measured rather than assumed:

* Cropping to the artwork window helps *here* (96.9% vs 93.8% uncropped) because
  colour over the whole card is dominated by the era-generic frame. The opposite
  is true for keypoint methods, which want the frame and set symbol — so this
  crop is specific to hashing and should not be copied elsewhere.
* Colour is weighted double. Same-artwork reprints across sets differ mostly in
  tint and border treatment, which is exactly what the structural hashes miss.
"""

from __future__ import annotations

import io
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Fraction of the card occupied by the artwork window on a standard layout.
# Full-art cards ignore this happily — the crop still lands on artwork.
ART_WINDOW = (0.07, 0.11, 0.93, 0.52)

# Calibrated on the 64-card benchmark described above.
#   max distance 48 — the worst *correct* match scored 40; the one confidently
#                     wrong match scored 63, so this rejects it without
#                     discarding anything real.
#   min margin 9    — the point at which every answer given was correct
#                     (58/58, 91% of cases). Below it the runner-up is close
#                     enough that guessing is worse than leaving the ranked list
#                     for the user, who can see all eight candidates anyway.
# Both were fit on that one 72-card set. Re-check them against new data before
# trusting them on a materially different collection.
ENSEMBLE_MAX_DISTANCE = 48.0
ENSEMBLE_MIN_MARGIN = 9.0

_WEIGHTS = (("phash", 1.0), ("dhash", 1.0), ("colorhash", 2.0))


def _crop_art(img):
    left, top, right, bottom = ART_WINDOW
    width, height = img.size
    return img.crop((int(width * left), int(height * top),
                     int(width * right), int(height * bottom)))


def load_image(data: bytes):
    """Decode to RGB, or None if the bytes are not an image we can read."""
    try:
        from PIL import Image
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None


def ensemble_distance(photo, candidate) -> Optional[float]:
    """Weighted hash distance between two PIL images. Lower is more alike."""
    try:
        import imagehash
    except ImportError:
        return None
    try:
        a, b = _crop_art(photo), _crop_art(candidate)
        total = 0.0
        for name, weight in _WEIGHTS:
            fn = getattr(imagehash, name)
            total += weight * float(fn(a) - fn(b))
        return total
    except Exception:
        return None


# Rotations a handheld photo realistically arrives in. Anything between these is
# skew, which is a different problem and not something a preview should "correct".
_ROTATIONS = (0, 90, 180, 270)

# Measured on 36 synthetic rotations of 9 cards (every card at every angle): the
# correct rotation won all 36 times, and the closest runner-up was 10 away. Six
# leaves room for a harder photo while still refusing a coin flip — showing a
# preview the wrong way up is worse than leaving it as the user took it.
ROTATION_MIN_MARGIN = 6.0


def detect_rotation(photo_bytes: bytes, reference_bytes: bytes) -> Optional[int]:
    """How far the photo is rotated from upright, or None if unclear.

    The model cannot answer this: asked directly it reports "upright" for every
    photo, including ones rotated 90, 180 and 270 (0/18 correct). It reads rotated
    cards perfectly well, it just has no sense of which way up they are.

    But by the time a preview is rendered we know *which* card this is, and the
    catalogue scan of that card is upright by definition. Comparing the photo
    against it at four rotations recovers the angle exactly, with no model call.

    Returns degrees the photo must be rotated *counter-clockwise* to stand upright.
    """
    photo = load_image(photo_bytes)
    reference = load_image(reference_bytes)
    if photo is None or reference is None:
        return None
    try:
        import imagehash
        ref_hash = imagehash.phash(reference)
        scored = sorted(
            (float(imagehash.phash(photo.rotate(angle, expand=True)) - ref_hash), angle)
            for angle in _ROTATIONS
        )
    except Exception:
        return None

    best, angle = scored[0]
    if (scored[1][0] - best) < ROTATION_MIN_MARGIN:
        return None
    return angle or None


def best_match(photo_bytes: bytes, candidates: list[tuple[str, bytes]]):
    """Return (card_id, distance, margin) for a clear winner, else None.

    `candidates` is (card_id, image_bytes). Pure: callers do the downloading, so
    this is testable without a network and the bytes can be shared with the phash
    stage rather than fetched twice.
    """
    photo = load_image(photo_bytes) if photo_bytes else None
    if photo is None or len(candidates) < 2:
        return None

    scored = []
    for card_id, data in candidates:
        image = load_image(data)
        if image is None:
            continue
        distance = ensemble_distance(photo, image)
        if distance is not None:
            scored.append((distance, card_id))
    if len(scored) < 2:
        return None

    scored.sort()
    (best, card_id), (runner_up, _) = scored[0], scored[1]
    margin = runner_up - best
    if best > ENSEMBLE_MAX_DISTANCE or margin < ENSEMBLE_MIN_MARGIN:
        logger.info(
            "Artwork match inconclusive (best %.0f, margin %.0f) — leaving the ranked order",
            best, margin,
        )
        return None
    return card_id, best, margin
