"""Shared card upsert helper."""

from __future__ import annotations

import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Card, ImageCache
from services.price_utils import preserve_existing_prices_for_invalid_update


def upsert_card(db: Session, card_data: dict) -> Card:
    """Insert or update a card row consistently across sync and API flows."""
    card_id = str(card_data.get("id", "")).strip()
    if not card_id:
        raise ValueError("Cannot upsert card without an id")
    card_data["id"] = card_id
    existing = db.get(Card, card_id)
    if existing is None:
        existing = db.query(Card).filter(Card.id == card_id).first()
    card_data["updated_at"] = datetime.datetime.utcnow()
    preserve_existing_prices_for_invalid_update(card_data, existing)
    has_api_image = bool(card_data.get("images_small") or card_data.get("images_large"))
    if existing:
        for key, value in card_data.items():
            if key != "id":
                setattr(existing, key, value)
    else:
        existing = Card(**card_data)
        db.add(existing)
        try:
            with db.begin_nested():
                db.flush()
        except IntegrityError:
            existing = db.query(Card).filter(Card.id == card_id).first()
            if not existing:
                raise
            for key, value in card_data.items():
                if key != "id":
                    setattr(existing, key, value)

    if has_api_image and existing:
        existing.custom_image_url = None
        db.query(ImageCache).filter(ImageCache.image_key.in_([
            f"card:{existing.id}:small:custom",
            f"card:{existing.id}:large:custom",
        ])).delete(synchronize_session=False)
    return existing
