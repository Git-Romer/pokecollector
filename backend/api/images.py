from fastapi import APIRouter, Depends, HTTPException, Response
import httpx
from sqlalchemy.orm import Session

from database import get_db
from models import Card, ImageCache, Set

router = APIRouter()

_client = httpx.Client(timeout=15, follow_redirects=True)


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
        raise HTTPException(status_code=404, detail="No image URL for this card")

    data, content_type = _get_or_fetch(db, f"card:{card_id}:{size}", url)
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
    if not url:
        raise HTTPException(status_code=404, detail="No image URL for this set")

    data, content_type = _get_or_fetch(db, f"set:{set_id}:{image_type}", url)
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
