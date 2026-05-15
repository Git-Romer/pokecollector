from fastapi import APIRouter, Depends, HTTPException, Response
import httpx
from sqlalchemy.orm import Session

from database import get_db
from models import Card, ImageCache, Set, Setting

router = APIRouter()

_client = httpx.Client(timeout=15, follow_redirects=True)


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
    svg = b'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">
<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#111827"/></linearGradient></defs>
<rect width="250" height="350" rx="18" fill="url(#g)"/>
<rect x="14" y="14" width="222" height="322" rx="14" fill="none" stroke="#f8fafc" stroke-width="8" opacity=".85"/>
<circle cx="125" cy="175" r="54" fill="#f8fafc" opacity=".95"/>
<circle cx="125" cy="175" r="22" fill="#111827"/>
<path d="M35 175h180" stroke="#111827" stroke-width="14"/>
<text x="125" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#f8fafc">POKEMON</text>
<text x="125" y="302" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="#f8fafc">NO IMAGE</text>
</svg>'''
    return Response(
        content=svg,
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

    url = card.images_small if size == "small" else card.images_large
    if not url:
        return _card_back_response()

    try:
        data, content_type = _get_or_fetch(db, f"card:{card_id}:{size}", url)
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
        raise HTTPException(status_code=404, detail="No image URL for this set")

    try:
        data, content_type = _get_or_fetch(db, cache_key, url)
    except HTTPException:
        raise HTTPException(status_code=404, detail="No image URL for this set")
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
