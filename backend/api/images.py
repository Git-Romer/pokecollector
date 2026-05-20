from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse, RedirectResponse
import hashlib
import httpx
from pathlib import Path
from sqlalchemy.orm import Session

from database import get_db
from models import Card, ImageCache, Set, Setting

router = APIRouter()

_client = httpx.Client(timeout=15, follow_redirects=True)
_SET_FALLBACK_IMAGE = Path(__file__).resolve().parents[1] / "static" / "pokemon-logo.svg"


def _setting_enabled(db: Session, key: str, default: bool = True) -> bool:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        return default
    return str(row.value).lower() in {"true", "1", "yes", "on"}


def _other_lang(lang: str | None) -> str | None:
    if lang == "de":
        return "en"
    if lang == "en":
        return "de"
    return None


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


@router.get("/card/{card_id}/{size}")
def get_card_image(card_id: str, size: str, db: Session = Depends(get_db)):
    if size not in ("small", "large"):
        raise HTTPException(status_code=400, detail="size must be small or large")

    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    requested_url = card.images_small if size == "small" else card.images_large
    alternate_api_url = card.images_large if size == "small" else card.images_small
    # Manual image URLs are temporary fallbacks only. If any API image is
    # available, prefer that API image over the custom URL.
    url = requested_url or alternate_api_url or card.custom_image_url
    if not url:
        return _card_back_response()

    try:
        url_hash = hashlib.sha1(url.encode("utf-8")).hexdigest()
        data, content_type = _get_or_fetch(db, f"card:{card_id}:{size}:{url_hash}", url)
    except HTTPException:
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

    url = card_set.images_logo if image_type == "logo" else card_set.images_symbol
    cache_key = f"set:{set_id}:{image_type}"

    if not url and _setting_enabled(db, "cross_language_image_fallback", True):
        fallback_lang = _other_lang(card_set.lang)
        tcg_set_id = card_set.tcg_set_id or card_set.id.rsplit("_", 1)[0]
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
