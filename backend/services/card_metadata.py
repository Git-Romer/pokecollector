"""Card detail metadata enrichment shared by sync and search."""

from __future__ import annotations

import datetime
import logging
from typing import Iterable

from sqlalchemy import JSON, and_, func, or_
from sqlalchemy.orm import Session

from models import Card, Set
from services import pokemon_api
from services.card_fallbacks import apply_cross_language_fallbacks
from services.card_upsert import upsert_card

logger = logging.getLogger(__name__)

DEFAULT_METADATA_ENRICHMENT_PER_FULL_SYNC = 500
METADATA_ENRICHMENT_PER_SEARCH_PAGE = 20
METADATA_ENRICHMENT_COOLDOWN = datetime.timedelta(days=7)
POKEMON_SUPERTYPE_VALUES = ("pokemon", "pokémon")
ELEMENTAL_SUPERTYPE_VALUES = (*POKEMON_SUPERTYPE_VALUES, "energy")


def _json_value_missing(column):
    """Match both SQL NULL and legacy JSON literal null values.

    SQLAlchemy JSON/JSONB columns historically persisted Python ``None`` as
    JSON ``null`` unless ``none_as_null`` was enabled. ``IS NULL`` alone does
    not match those rows, so metadata backfills must handle both forms.
    """
    return or_(column.is_(None), column == JSON.NULL)

_ANY_METADATA_FIELDS = (
    "rarity",
    "types",
    "supertype",
    "subtypes",
    "hp",
    "artist",
    "stage",
    "trainer_type",
    "energy_type",
    "regulation_mark",
)

_KEY_METADATA_FIELDS = (
    "rarity",
    "supertype",
    "subtypes",
)


def _has_value(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict, tuple, set)):
        return bool(value)
    return True


def _card_missing_key_metadata(card: Card) -> bool:
    if not any(_has_value(getattr(card, field, None)) for field in _ANY_METADATA_FIELDS):
        return True
    if any(not _has_value(getattr(card, field, None)) for field in _KEY_METADATA_FIELDS):
        return True
    supertype = (card.supertype or "").strip().casefold()
    if supertype in ELEMENTAL_SUPERTYPE_VALUES and not _has_value(card.types):
        return True
    if supertype in POKEMON_SUPERTYPE_VALUES and (
        card.dex_ids is None or card.cardmarket_products is None
    ):
        return True
    return False


def card_needs_metadata_enrichment(card: Card, *, now: datetime.datetime | None = None) -> bool:
    """Return true for brief or partially populated rows missing important base metadata.

    Cards still missing fields but attempted within METADATA_ENRICHMENT_COOLDOWN are
    skipped: `updated_at` is already bumped on every attempt (success, missing, or
    failed), so a card TCGdex genuinely has nothing more for would otherwise be
    re-fetched on every search request that surfaces it, forever.
    """
    if not card or card.is_custom or not (card.tcg_card_id or card.id):
        return False
    if not _card_missing_key_metadata(card):
        return False
    if card.updated_at is None:
        return True
    return (now or datetime.datetime.utcnow()) - card.updated_at >= METADATA_ENRICHMENT_COOLDOWN


def _card_detail_id(card: Card) -> str | None:
    if card.tcg_card_id:
        return card.tcg_card_id
    if not card.id:
        return None
    tcg_id, _lang = pokemon_api.strip_lang_suffix(card.id)
    return tcg_id


def _clear_missing_set_reference(db: Session, parsed: dict) -> None:
    set_id = parsed.get("set_id")
    if not set_id:
        return
    set_exists = db.query(Set.id).filter((Set.tcg_set_id == set_id) | (Set.id == set_id)).first()
    if not set_exists:
        parsed["set_id"] = None


def enrich_card_metadata(db: Session, card: Card) -> Card | None:
    """Fetch full TCGdex detail for one card and upsert enriched metadata."""
    detail_id = _card_detail_id(card)
    if not detail_id:
        return None
    card_lang = card.lang or "en"
    card_data = pokemon_api.get_card(detail_id, lang=card_lang)
    if not card_data:
        return None

    parsed = pokemon_api.parse_card_for_db(card_data, lang=card_lang)
    parsed = apply_cross_language_fallbacks(db, parsed)
    _clear_missing_set_reference(db, parsed)
    return upsert_card(db, parsed)


def enrich_cards_metadata(
    db: Session,
    cards: Iterable[Card],
    *,
    limit: int,
    commit_every: int = 50,
    force: bool = False,
) -> dict:
    """Enrich up to limit cards, isolating failures so one bad card does not abort the batch."""
    result = {"attempted": 0, "updated": 0, "missing": 0, "failed": 0, "ids": []}
    selected = []
    for card in cards:
        if len(selected) >= limit:
            break
        if force or card_needs_metadata_enrichment(card):
            selected.append(card)

    for card in selected:
        result["attempted"] += 1
        try:
            with db.begin_nested():
                enriched = enrich_card_metadata(db, card)
                if enriched:
                    result["updated"] += 1
                    result["ids"].append(enriched.id)
                else:
                    result["missing"] += 1
                    card.updated_at = datetime.datetime.utcnow()
                    db.add(card)
        except Exception as exc:
            result["failed"] += 1
            logger.warning("Failed to enrich card metadata for %s: %s", card.id, exc)
            card.updated_at = datetime.datetime.utcnow()
            db.add(card)

        if commit_every > 0 and result["attempted"] % commit_every == 0:
            db.commit()

    if commit_every <= 0 or result["attempted"] % commit_every:
        db.commit()

    return result


def enrich_missing_card_metadata(
    db: Session,
    *,
    limit: int = DEFAULT_METADATA_ENRICHMENT_PER_FULL_SYNC,
) -> dict:
    """Enrich a bounded batch of catalogue cards that still only have brief set-list data."""
    candidates = (
        db.query(Card)
        .filter(
            Card.is_custom == False,
            Card.tcg_card_id.isnot(None),
            or_(
                Card.rarity.is_(None),
                Card.supertype.is_(None),
                Card.subtypes.is_(None),
                and_(Card.types.is_(None), func.lower(Card.supertype).in_(ELEMENTAL_SUPERTYPE_VALUES)),
                and_(
                    or_(_json_value_missing(Card.dex_ids), _json_value_missing(Card.cardmarket_products)),
                    func.lower(Card.supertype).in_(POKEMON_SUPERTYPE_VALUES),
                ),
            ),
        )
        .order_by(Card.updated_at.asc(), Card.id.asc())
        .limit(limit)
        .all()
    )
    return enrich_cards_metadata(db, candidates, limit=limit, force=True)
