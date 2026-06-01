from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse, RedirectResponse
import hashlib
import httpx
from pathlib import Path
from urllib.parse import urljoin
from sqlalchemy.orm import Session

from database import get_db
from models import Card, ImageCache, Set, Setting
from services.card_visibility import get_configured_sync_languages, get_pinned_set_language_pairs
from services.image_url_security import validate_public_https_image_url
from services.tcgdex_languages import english_fallback_languages, strip_lang_suffix

router = APIRouter()

_client = httpx.Client(timeout=15, follow_redirects=True)
_custom_image_client = httpx.Client(timeout=10, follow_redirects=False)
_SET_FALLBACK_IMAGE = Path(__file__).resolve().parents[1] / "static" / "pokemon-logo.svg"
_MAX_CUSTOM_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_CUSTOM_IMAGE_REDIRECTS = 3


def _setting_enabled(db: Session, key: str, default: bool = True) -> bool:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        return default
    return str(row.value).lower() in {"true", "1", "yes", "on"}


def _other_lang(lang: str | None) -> str | None:
    fallback_order = english_fallback_languages(lang)
    return fallback_order[0] if fallback_order else None


def _card_back_response():
    # Keep using the frontend's existing placeholder artwork. The backend only
    # changes the missing-image response behavior; it must not replace the
    # placeholder image data/design.
    return RedirectResponse(url="/cardback.jpg", status_code=307)


def _set_fallback_response():
    # Serve a bundled Pokémon-style wordmark when TCGdex has no set logo/symbol
    # or the upstream image cannot be fetched. Serving it from the API keeps the
    # fallback independent from frontend static-asset routing.
    return FileResponse(
        _SET_FALLBACK_IMAGE,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _is_globally_visible_card_image(db: Session, card: Card) -> bool:
    if getattr(card, "is_custom", False):
        return True
    card_lang = card.lang or "en"
    if card_lang in set(get_configured_sync_languages(db)):
        return True
    return (card.set_id, card_lang) in get_pinned_set_language_pairs(db)


def _is_globally_visible_set_image(db: Session, card_set: Set) -> bool:
    set_lang = card_set.lang or "en"
    if set_lang in set(get_configured_sync_languages(db)):
        return True
    tcg_set_id = card_set.tcg_set_id or strip_lang_suffix(card_set.id)[0]
    return (tcg_set_id, set_lang) in get_pinned_set_language_pairs(db)


def _get_or_fetch(db: Session, key: str, url: str) -> tuple[bytes, str]:
    cached = db.query(ImageCache).filter(ImageCache.image_key == key).first()
    if cached:
        return cached.data, cached.content_type

    try:
        resp = _client.get(url)
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to fetch image from upstream") from exc

    content_type = resp.headers.get("content-type", "image/webp")
    entry = ImageCache(image_key=key, data=resp.content, content_type=content_type)
    db.add(entry)
    try:
        db.commit()
    except Exception:
        db.rollback()
        cached = db.query(ImageCache).filter(ImageCache.image_key == key).first()
        if cached:
            return cached.data, cached.content_type
        raise

    return resp.content, content_type


def _get_or_fetch_custom_image(db: Session, key: str, url: str) -> tuple[bytes, str]:
    cached = db.query(ImageCache).filter(ImageCache.image_key == key).first()
    if cached:
        return cached.data, cached.content_type

    current_url = validate_public_https_image_url(url)
    for _ in range(_MAX_CUSTOM_IMAGE_REDIRECTS + 1):
        chunks: list[bytes] = []
        total = 0
        try:
            with _custom_image_client.stream("GET", current_url) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location")
                    if not location:
                        raise HTTPException(status_code=502, detail="Invalid custom image redirect")
                    current_url = validate_public_https_image_url(urljoin(current_url, location))
                    continue

                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "image/webp").split(";", 1)[0].strip().lower()
                if not content_type.startswith("image/"):
                    raise HTTPException(status_code=502, detail="Custom image URL did not return an image")

                content_length = resp.headers.get("content-length")
                if content_length and int(content_length) > _MAX_CUSTOM_IMAGE_BYTES:
                    raise HTTPException(status_code=502, detail="Custom image is too large")

                for chunk in resp.iter_bytes():
                    total += len(chunk)
                    if total > _MAX_CUSTOM_IMAGE_BYTES:
                        raise HTTPException(status_code=502, detail="Custom image is too large")
                    chunks.append(chunk)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Failed to fetch custom image") from exc

        data = b"".join(chunks)
        entry = ImageCache(image_key=key, data=data, content_type=content_type)
        db.add(entry)
        try:
            db.commit()
        except Exception:
            db.rollback()
            cached = db.query(ImageCache).filter(ImageCache.image_key == key).first()
            if cached:
                return cached.data, cached.content_type
            raise
        return data, content_type

    raise HTTPException(status_code=502, detail="Custom image redirected too many times")


@router.get("/card/{card_id}/{size}")
def get_card_image(card_id: str, size: str, db: Session = Depends(get_db)):
    if size not in ("small", "large"):
        raise HTTPException(status_code=400, detail="size must be small or large")

    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    if not _is_globally_visible_card_image(db, card):
        raise HTTPException(status_code=404, detail="Card not found")

    requested_url = card.images_small if size == "small" else card.images_large
    alternate_api_url = card.images_large if size == "small" else card.images_small
    # Manual image URLs are temporary fallbacks only. If any API image is
    # available, prefer that API image over the custom URL.
    url = requested_url or alternate_api_url or card.custom_image_url
    if not url:
        return _card_back_response()

    try:
        if card.custom_image_url and url == card.custom_image_url:
            data, content_type = _get_or_fetch_custom_image(db, f"card:{card_id}:{size}:custom", url)
        else:
            url_hash = hashlib.sha1(url.encode("utf-8")).hexdigest()
            data, content_type = _get_or_fetch(db, f"card:{card_id}:{size}:{url_hash}", url)
    except (HTTPException, ValueError):
        return _card_back_response()
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/set/{set_id}/{image_type}")
def get_set_image(set_id: str, image_type: str, db: Session = Depends(get_db)):
    if image_type not in ("logo", "symbol"):
        raise HTTPException(status_code=400, detail="image_type must be logo or symbol")

    card_set = db.query(Set).filter(Set.id == set_id).first()
    if not card_set:
        raise HTTPException(status_code=404, detail="Set not found")
    if not _is_globally_visible_set_image(db, card_set):
        raise HTTPException(status_code=404, detail="Set not found")

    url = card_set.images_logo if image_type == "logo" else card_set.images_symbol
    cache_key = f"set:{set_id}:{image_type}"

    if not url and _setting_enabled(db, "cross_language_image_fallback", True):
        fallback_lang = _other_lang(card_set.lang)
        tcg_set_id = card_set.tcg_set_id or strip_lang_suffix(card_set.id)[0]
        if fallback_lang:
            sibling = db.query(Set).filter(
                Set.tcg_set_id == tcg_set_id,
                Set.lang == fallback_lang,
            ).first()
            if sibling:
                url = sibling.images_logo if image_type == "logo" else sibling.images_symbol
                cache_key = f"set:{set_id}:{image_type}:fallback:{fallback_lang}"

    if not url:
        return _set_fallback_response()

    try:
        data, content_type = _get_or_fetch(db, cache_key, url)
    except HTTPException as exc:
        if exc.status_code == 502:
            return _set_fallback_response()
        raise
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
