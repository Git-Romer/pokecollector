import re
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text, func
from api.auth import get_current_user
from database import get_db
from models import Set, Card, CollectionItem, Setting, User
from schemas import SetBase
from services import pokemon_api
from services.card_fallbacks import (
    apply_cross_language_fallbacks,
    build_missing_language_cards_for_set,
    missing_language_fallback_enabled,
)
from services.card_upsert import upsert_card

router = APIRouter()

_NATURAL_SORT_RE = re.compile(r"(\d+|\D+)")


def _natural_card_number_key(number: Optional[str]) -> tuple:
    """Sort card numbers naturally while preserving alphanumeric formats.

    Examples:
    - 1, 2, 10 instead of 1, 10, 2
    - 001, 002, 010 still sort correctly
    - 74, 74a, 74b and H04 are handled without converting the display value
    """
    if number is None:
        return ((2, ""),)

    parts = []
    for part in _NATURAL_SORT_RE.findall(str(number).strip()):
        if part.isdigit():
            parts.append((0, int(part), len(part), part))
        else:
            parts.append((1, part.casefold()))
    return tuple(parts) or ((2, ""),)


def _get_language(db: Session) -> str:
    """Get display language from settings."""
    row = db.query(Setting).filter(Setting.key == "language").first()
    return row.value if row else "de"


def _refresh_sets(db: Session, display_lang: str):
    """Refresh sets from TCGdex API and store in DB.

    Each language version is stored as a separate row with a composite primary key
    (e.g. "sv1_de" and "sv1_en"). lang field is strictly "en" or "de".
    """
    languages = [display_lang] if display_lang in ("en", "de") else ["en", "de"]
    sets_data = pokemon_api.get_all_sets(languages=languages)

    for set_data in sets_data:
        parsed = pokemon_api.parse_set_for_db(set_data)
        set_lang = set_data.get("_lang", "en")
        parsed["lang"] = set_lang

        existing = db.query(Set).filter(Set.id == parsed["id"]).first()
        if existing:
            for k, v in parsed.items():
                if k != "id" and v is not None:
                    setattr(existing, k, v)
        else:
            db.add(Set(**parsed))
    db.commit()


@router.get("/", response_model=List[SetBase])
def get_sets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    refresh: bool = False,
    lang: Optional[str] = Query("all", description="Language filter: 'de', 'en', or 'all'"),
):
    """Get all sets, optionally refresh from TCGdex API.

    lang: filter by set language — 'de' (German only), 'en' (English only), or 'all' (both).
    Sets are stored separately per language — no 'both' entries.
    """
    lang_filter = lang or "all"

    # Determine display language for API calls
    if lang_filter in ("en", "de"):
        display_lang = lang_filter
    else:
        display_lang = _get_language(db)

    # Always refresh if empty DB or explicitly requested
    if refresh or db.query(Set).count() == 0:
        try:
            _refresh_sets(db, display_lang)
        except Exception as e:
            if db.query(Set).count() == 0:
                raise HTTPException(status_code=500, detail=str(e))

    # Build query with optional lang filter
    query = db.query(Set)
    if lang_filter == "de":
        query = query.filter(Set.lang == "de")
    elif lang_filter == "en":
        query = query.filter(Set.lang == "en")
    # else "all" → no filter

    sets = query.order_by(text("release_date DESC NULLS LAST")).all()

    # If filter returns no results for a specific lang, force a refresh
    if not sets and lang_filter in ("de", "en"):
        try:
            _refresh_sets(db, display_lang)
            query = db.query(Set)
            if lang_filter == "de":
                query = query.filter(Set.lang == "de")
            elif lang_filter == "en":
                query = query.filter(Set.lang == "en")
            sets = query.order_by(text("release_date DESC NULLS LAST")).all()
        except Exception:
            pass

    # Compute owned_count per set, grouped by (set_id, lang) so DE and EN sets are counted separately
    owned_counts = (
        db.query(
            Card.set_id,
            CollectionItem.lang,
            func.count(func.distinct(CollectionItem.card_id)).label('cnt')
        )
        .join(CollectionItem, CollectionItem.card_id == Card.id)
        .group_by(Card.set_id, CollectionItem.lang)
        .all()
    )
    owned_map = {(set_id, item_lang): cnt for set_id, item_lang, cnt in owned_counts}
    for set_obj in sets:
        tcg_id = set_obj.tcg_set_id or set_obj.id
        set_lang = set_obj.lang or 'en'
        set_obj.owned_count = owned_map.get((tcg_id, set_lang), 0)

    return sets


@router.get("/new")
def get_new_sets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get newly detected sets."""
    new_sets = db.query(Set).filter(Set.is_new == True).all()
    return new_sets


@router.post("/mark-seen")
def mark_sets_seen(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark all new sets as seen."""
    db.query(Set).filter(Set.is_new == True).update({"is_new": False})
    db.commit()
    return {"message": "All new sets marked as seen"}


@router.get("/{set_id}", response_model=SetBase)
def get_set(
    set_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single set by DB key (e.g. 'sv1_de' or 'sv1_en')."""
    set_obj = db.query(Set).filter(Set.id == set_id).first()
    if not set_obj:
        raise HTTPException(status_code=404, detail="Set not found")
    return set_obj


@router.get("/{set_id}/checklist")
def get_set_checklist(
    set_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get set checklist - cards with ownership status.

    set_id is the composite DB key (e.g. 'sv1_de').
    Missing local cards are fetched from TCGdex and may use sibling-language
    fallback rows until native language data exists.
    """
    set_obj = db.query(Set).filter(Set.id == set_id).first()
    if not set_obj:
        raise HTTPException(status_code=404, detail="Set not found")

    # Use the original TCGdex set ID for card lookups
    tcg_id = set_obj.tcg_set_id or set_obj.id
    set_lang = set_obj.lang or "en"
    fallback_enabled = missing_language_fallback_enabled(db)

    def query_set_cards():
        query = db.query(Card).filter(
            Card.set_id == tcg_id,
            Card.lang == set_lang,
        )
        if not fallback_enabled:
            query = query.filter(Card.data_source_lang.is_(None))
        return query.all()

    # Query DB for cards matching both set_id and lang
    cards = query_set_cards()

    # If no lang-filtered cards are found, only repair legacy cards that do not
    # already have an explicit language in their DB id. Do not relabel sibling
    # rows like me04-001_en as German cards.
    if not cards:
        legacy_cards = db.query(Card).filter(Card.set_id == tcg_id).all()
        repairable_cards = [
            card for card in legacy_cards
            if not (card.id or "").endswith(("_de", "_en"))
        ]
        if repairable_cards:
            for card in repairable_cards:
                card.lang = set_lang
            db.commit()
            cards = repairable_cards

    # If still no cards, fetch native cards from TCGdex and cache them.
    if not cards:
        try:
            set_data = pokemon_api.get_set_cards(tcg_id, lang=set_lang)
            for card_data in set_data.get("cards", []):
                parsed = pokemon_api.parse_card_for_db(card_data, default_set_id=tcg_id, lang=set_lang)
                parsed = apply_cross_language_fallbacks(db, parsed)
                upsert_card(db, parsed)
            db.commit()
            cards = query_set_cards()
        except Exception:
            db.rollback()

    # Some new sets exist as localized set metadata before localized card data
    # exists. When cross-language fallback is enabled, fill any missing target
    # rows from the sibling language. Do this even if one fallback row already
    # exists, otherwise adding a single card prevents the rest of the set from
    # appearing after fallback is turned on.
    set_total = set_obj.total or 0
    if fallback_enabled and (not cards or (set_total and len(cards) < set_total)):
        try:
            for parsed in build_missing_language_cards_for_set(db, tcg_id, set_lang, expected_total=set_total):
                upsert_card(db, parsed)
            db.commit()
        except Exception:
            db.rollback()
        cards = query_set_cards()

    cards.sort(key=lambda card: _natural_card_number_key(card.number))

    # Get exact owned collection rows so the UI can safely remove/decrement the
    # right variant/condition instead of treating ownership as a single boolean.
    collection_items = db.query(CollectionItem).filter(
        CollectionItem.user_id == current_user.id,
        CollectionItem.card_id.in_([c.id for c in cards])
    ).all()
    owned_by_card: dict[str, list[CollectionItem]] = {}
    for item in collection_items:
        owned_by_card.setdefault(item.card_id, []).append(item)
    owned_card_ids = set(owned_by_card.keys())

    owned_count = len(owned_card_ids)
    total_count = len(cards)

    checklist = []
    for card in cards:
        owned = card.id in owned_card_ids
        owned_items = owned_by_card.get(card.id, [])
        qty = sum(item.quantity or 0 for item in owned_items)

        checklist.append({
            "id": card.id,
            "name": card.name,
            "number": card.number,
            "rarity": card.rarity,
            "images_small": card.images_small,
            "images_large": card.images_large,
            "image_source_lang": getattr(card, "image_source_lang", None),
            "data_source_lang": getattr(card, "data_source_lang", None),
            "price_source_lang": getattr(card, "price_source_lang", None),
            "owned": owned,
            "quantity": qty,
            "owned_items": [
                {
                    "id": item.id,
                    "quantity": item.quantity,
                    "condition": item.condition,
                    "variant": item.variant,
                    "lang": item.lang,
                    "purchase_price": item.purchase_price,
                }
                for item in owned_items
            ],
            "price_market": card.price_market,
            "price_low": card.price_low,
            "price_trend": card.price_trend,
            "price_avg1": card.price_avg1,
            "price_avg7": card.price_avg7,
            "price_avg30": card.price_avg30,
            "price_market_holo": card.price_market_holo,
            "price_low_holo": card.price_low_holo,
            "price_trend_holo": card.price_trend_holo,
            "price_avg1_holo": card.price_avg1_holo,
            "price_avg7_holo": card.price_avg7_holo,
            "price_avg30_holo": card.price_avg30_holo,
        })

    return {
        "set": {
            "id": set_obj.id,
            "name": set_obj.name,
            "series": set_obj.series,
            "total": set_obj.total,
            "images_symbol": set_obj.images_symbol,
            "images_logo": set_obj.images_logo,
            "lang": set_obj.lang or "en",
        },
        "cards": checklist,
        "owned_count": owned_count,
        "total_count": total_count,
        "progress": round((owned_count / total_count * 100) if total_count > 0 else 0, 1),
    }
