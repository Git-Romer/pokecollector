"""Shared card upsert helper."""

from __future__ import annotations

import datetime

from sqlalchemy.orm import Session

from models import Card, ImageCache
from services.price_utils import preserve_existing_prices_for_invalid_update


def upsert_card(db: Session, card_data: dict) -> Card:
    """Insert or update a card row consistently across sync and API flows."""
    existing = db.query(Card).filter(Card.id == card_data["id"]).first()
    card_data["updated_at"] = datetime.datetime.utcnow()
    preserve_existing_prices_for_invalid_update(card_data, existing)
    has_api_image = bool(card_data.get("images_small") or card_data.get("images_large"))
    if existing:
        for key, value in card_data.items():
            if key != "id":
                setattr(existing, key, value)
        if has_api_image:
            existing.custom_image_url = None
            db.query(ImageCache).filter(ImageCache.image_key.in_([
                f"card:{existing.id}:small:custom",
                f"card:{existing.id}:large:custom",
            ])).delete(synchronize_session=False)
    else:
        existing = Card(**card_data)
        db.add(existing)
    return existing
