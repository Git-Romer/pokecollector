"""Helpers for optional digital-only TCGdex sets."""

from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy.orm import Session

from models import Card, Set, Setting

DIGITAL_SETS_SETTING_KEY = "tcgdex_digital_sets_enabled"
DIGITAL_SERIES_IDS = {"tcgp"}


def setting_truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"true", "1", "yes", "on"}


def digital_sets_enabled(db: Session) -> bool:
    row = db.query(Setting).filter(Setting.key == DIGITAL_SETS_SETTING_KEY).first()
    return setting_truthy(row.value if row else "true")


def refresh_digital_catalogue_flags(db: Session) -> dict[str, int]:
    """Mark known digital catalogue rows without deleting user or catalogue data."""
    return mark_existing_digital_rows(db)


def is_digital_set_data(set_data: Mapping[str, Any] | None) -> bool:
    if not set_data:
        return False

    serie = set_data.get("serie") or {}
    series_id = (
        set_data.get("_series_id")
        or (serie.get("id") if isinstance(serie, Mapping) else None)
    )
    if str(series_id or "").strip().lower() in DIGITAL_SERIES_IDS:
        return True

    for image_key in ("logo", "symbol"):
        value = str(set_data.get(image_key) or "").lower()
        if "/tcgp/" in value:
            return True

    return False


def mark_existing_digital_rows(db: Session) -> dict[str, int]:
    digital_set_rows = db.query(Set).filter(
        (
            (Set.is_digital == True)
            |
            (Set.series.ilike("%pocket%"))
            | (Set.images_logo.ilike("%/tcgp/%"))
            | (Set.images_symbol.ilike("%/tcgp/%"))
        )
    ).all()
    if not digital_set_rows:
        return {"sets_marked": 0, "cards_marked": 0}

    sets_marked = 0
    for set_row in digital_set_rows:
        if not set_row.is_digital:
            sets_marked += 1
            set_row.is_digital = True

    digital_pairs = {
        (set_row.tcg_set_id or set_row.id, set_row.lang or "en")
        for set_row in digital_set_rows
    }
    cards_marked = 0
    for set_id, lang in digital_pairs:
        cards_marked += db.query(Card).filter(
            Card.set_id == set_id,
            Card.lang == lang,
            Card.is_digital == False,
        ).update({"is_digital": True}, synchronize_session=False)

    return {"sets_marked": sets_marked, "cards_marked": cards_marked}
