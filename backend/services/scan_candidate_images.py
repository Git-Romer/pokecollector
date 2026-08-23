"""Cache-backed serving of a scan candidate's full-resolution artwork.

Reviewing a scan means comparing the user's photo against a TCGdex candidate at
full size, and fetching that image straight from the TCGdex asset CDN on every
expand is slow enough to read as broken — a cold fetch can take several
seconds, during which the review modal shows a blank frame next to the user's
photo.

This module keeps a local copy of each candidate's full-resolution scan in the
shared `ImageCache` table (the same table `backend/api/images.py` and
`backend/services/product_images.py` already use for pokedex/product image
caching), keyed by a hash of the image URL. Recognition calls
`prewarm_candidate_images` for its top-ranked candidates so that by the time a
reviewer opens the comparison, the image is usually already a local read; the
`GET .../candidates/{index}/image` endpoint in `backend/api/scan_jobs.py`
falls back to fetching (and caching) on demand for anything that was not
pre-warmed or has since aged out of the ranking.
"""

from __future__ import annotations

import hashlib
import logging

import httpx
from sqlalchemy.orm import Session

from models import ImageCache

logger = logging.getLogger(__name__)

CANDIDATE_IMAGE_TIMEOUT = 20

# The review opens on the top candidate, and arrow-key browsing usually
# settles within a card or two of it, so warming just the first few covers the
# common path cheaply. The rest are fetched (and cached) on demand when
# actually opened — most are never looked at.
PREWARM_CANDIDATE_COUNT = 2


def cache_key_for(url: str) -> str:
    return f"scan-candidate:{hashlib.sha1(url.encode('utf-8')).hexdigest()}"


def _candidate_image_url(candidate: dict) -> str | None:
    return candidate.get("image_hd") or candidate.get("image")


def get_cached_candidate_image(db: Session, url: str) -> tuple[bytes, str] | None:
    """Return cached bytes for a candidate image URL, or None on a cache miss."""
    cached = (
        db.query(ImageCache)
        .filter(ImageCache.image_key == cache_key_for(url))
        .first()
    )
    if cached is None:
        return None
    return cached.data, cached.content_type


async def fetch_and_cache_candidate_image(
    db: Session, url: str
) -> tuple[bytes, str] | None:
    """Serve a candidate image from cache, or fetch it once and store it.

    Concurrent callers can race to insert the same key; the loser rolls back
    and reads back the winner's row rather than erroring, since serving the
    image is what matters, not which request happened to write it.
    """
    cached = get_cached_candidate_image(db, url)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=CANDIDATE_IMAGE_TIMEOUT) as client:
            response = await client.get(url)
        response.raise_for_status()
    except Exception:
        return None

    content_type = response.headers.get("content-type", "image/webp")
    db.add(ImageCache(
        image_key=cache_key_for(url),
        data=response.content,
        content_type=content_type,
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        cached = get_cached_candidate_image(db, url)
        if cached is not None:
            return cached
        raise
    return response.content, content_type


async def prewarm_candidate_images(candidates: list[dict]) -> int:
    """Best-effort: pull the top few candidates' full-res scans into the cache.

    Runs against its own database session so it never holds the caller's
    request-scoped session open, and is meant to be fired with
    `asyncio.create_task` rather than awaited — recognition should not get
    slower because of a cache warm-up. Every failure (network, decode,
    database) is swallowed: a cold cache just means the review endpoint falls
    back to fetching on demand, which is the pre-existing behavior.
    """
    try:
        from database import SessionLocal
    except Exception:
        logger.warning("Could not import SessionLocal to prewarm candidate images", exc_info=True)
        return 0

    warmed = 0
    try:
        db = SessionLocal()
    except Exception:
        logger.warning("Could not open a database session to prewarm candidate images", exc_info=True)
        return 0

    try:
        for candidate in (candidates or [])[:PREWARM_CANDIDATE_COUNT]:
            url = _candidate_image_url(candidate)
            if not url:
                continue
            try:
                result = await fetch_and_cache_candidate_image(db, url)
                if result is not None:
                    warmed += 1
            except Exception:
                logger.warning("Could not pre-cache candidate image %s", url, exc_info=True)
    finally:
        db.close()
    return warmed
