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
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from models import ImageCache

logger = logging.getLogger(__name__)

CANDIDATE_IMAGE_TIMEOUT = 20
CANDIDATE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
CANDIDATE_IMAGE_CACHE_LIMIT = 100
ALLOWED_CANDIDATE_IMAGE_TYPES = {
    "image/avif",
    "image/jpeg",
    "image/png",
    "image/webp",
}

# The review opens on the top candidate, and arrow-key browsing usually
# settles within a card or two of it, so warming just the first few covers the
# common path cheaply. The rest are fetched (and cached) on demand when
# actually opened — most are never looked at.
PREWARM_CANDIDATE_COUNT = 2


def cache_key_for(url: str) -> str:
    return f"scan-candidate:{hashlib.sha1(url.encode('utf-8')).hexdigest()}"


def validate_candidate_image_url(raw_url: str) -> str:
    """Accept only direct HTTPS artwork URLs from TCGdex's public CDN."""
    url = str(raw_url or "").strip()
    parsed = urlparse(url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid candidate image port") from exc
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").rstrip(".").lower() != "assets.tcgdex.net"
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        raise ValueError("Candidate image must use the TCGdex HTTPS CDN")
    return url


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
    try:
        url = validate_candidate_image_url(url)
    except ValueError:
        return None

    cached = get_cached_candidate_image(db, url)
    if cached is not None:
        return cached

    try:
        # The candidate is expected to be a direct CDN object. Redirects are
        # refused so an upstream response cannot escape the trusted host
        # boundary above. Stream the body so a missing or false Content-Length
        # cannot make us buffer an unbounded response.
        async with httpx.AsyncClient(
            timeout=CANDIDATE_IMAGE_TIMEOUT,
            follow_redirects=False,
        ) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                raw_content_type = response.headers.get("content-type")
                if not raw_content_type:
                    return None
                content_type = raw_content_type.split(";", 1)[0].strip().lower()
                if content_type not in ALLOWED_CANDIDATE_IMAGE_TYPES:
                    return None
                raw_content_length = response.headers.get("content-length")
                if raw_content_length is not None:
                    content_length = int(raw_content_length)
                    if content_length > CANDIDATE_IMAGE_MAX_BYTES:
                        return None
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > CANDIDATE_IMAGE_MAX_BYTES:
                        return None
                    body.extend(chunk)
                data = bytes(body)
    except Exception:
        return None

    if not data:
        return None

    db.add(ImageCache(
        image_key=cache_key_for(url),
        data=data,
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
    # Bound only this feature's cache. Other ImageCache consumers keep their
    # own retention behavior.
    try:
        stale_ids = [row[0] for row in (
            db.query(ImageCache.id)
            .filter(ImageCache.image_key.like("scan-candidate:%"))
            .order_by(ImageCache.cached_at.desc(), ImageCache.id.desc())
            .offset(CANDIDATE_IMAGE_CACHE_LIMIT)
            .all()
        )]
        if stale_ids:
            db.query(ImageCache).filter(ImageCache.id.in_(stale_ids)).delete(
                synchronize_session=False,
            )
            db.commit()
    except Exception:
        db.rollback()
        logger.warning("Could not prune the scan candidate image cache", exc_info=True)

    return data, content_type


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
