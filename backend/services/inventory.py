from __future__ import annotations

import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import InventoryEvent, StorageLocation


DEFAULT_STORAGE_LOCATION_NAME = "To organize"

RAW_CONDITIONS = (
    "NM",
    "LP",
    "MP",
    "HP",
    "DMG",
)

CARD_VARIANTS = (
    "Normal",
    "Holo",
    "Reverse Holo",
    "First Edition",
)

CARD_VARIANT_ALIASES = {
    "Holofoil": "Holo",
    "Reverse Holofoil": "Reverse Holo",
}


def normalize_card_variant(value: str | None) -> str:
    variant = (value or "").strip() or "Normal"
    return CARD_VARIANT_ALIASES.get(variant, variant)


PROTECTION_TYPES = (
    "raw",
    "penny_sleeve",
    "card_saver",
    "top_loader",
    "psa_slab",
    "tag_slab",
    "other",
)

ACQUISITION_SOURCES = (
    "pulled",
    "purchased",
    "trade",
    "gift",
    "bulk_before_tracking",
    "unknown",
    "other",
)

REMOVAL_REASONS = (
    "sold",
    "traded",
    "gifted",
    "lost_damaged",
    "other",
)

SEALED_CONDITIONS = (
    "factory_sealed",
    "sealed_with_wear",
    "damaged_seal",
    "opened",
)


def get_or_create_default_storage_location(db: Session, user_id: int) -> StorageLocation:
    location = db.query(StorageLocation).filter(
        StorageLocation.user_id == user_id,
        StorageLocation.is_default.is_(True),
        StorageLocation.is_active.is_(True),
    ).order_by(StorageLocation.id.asc()).first()
    if location:
        return location

    location = db.query(StorageLocation).filter(
        StorageLocation.user_id == user_id,
        StorageLocation.name == DEFAULT_STORAGE_LOCATION_NAME,
    ).first()
    if location:
        location.is_default = True
        location.is_active = True
        db.flush()
        return location

    location = StorageLocation(
        user_id=user_id,
        name=DEFAULT_STORAGE_LOCATION_NAME,
        description="New intake waiting to be filed",
        is_default=True,
        is_active=True,
    )
    db.add(location)
    db.flush()
    return location


def resolve_storage_location(
    db: Session,
    user_id: int,
    storage_location_id: int | None,
) -> StorageLocation:
    if storage_location_id is None:
        return get_or_create_default_storage_location(db, user_id)

    location = db.query(StorageLocation).filter(
        StorageLocation.id == storage_location_id,
        StorageLocation.user_id == user_id,
        StorageLocation.is_active.is_(True),
    ).first()
    if not location:
        raise HTTPException(status_code=422, detail="Storage location was not found or is inactive")
    return location


def record_inventory_event(
    db: Session,
    *,
    user_id: int,
    entity_type: str,
    entity_id: int,
    entity_uid: str,
    action: str,
    changes: dict[str, Any] | None = None,
    notes: str | None = None,
) -> InventoryEvent:
    event = InventoryEvent(
        user_id=user_id,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_uid=entity_uid,
        action=action,
        changes=changes or {},
        notes=notes,
        occurred_at=datetime.datetime.utcnow(),
    )
    db.add(event)
    return event


def changed_values(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    return {
        key: {"before": before.get(key), "after": after.get(key)}
        for key in sorted(set(before) | set(after))
        if before.get(key) != after.get(key)
    }
