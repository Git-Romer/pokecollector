from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text, func
from typing import List, Optional
from database import get_db
from models import Set, Card, CollectionItem, Setting
from schemas import SetBase
from services import pokemon_api

router = APIRouter()


def _get_language(db: Session) -> str:
    """Get display language from settings."""
    row = db.query(Setting).filter(Setting.key == "language").first()
    return row.value if row else "de"


def _refresh_sets(db: Session, display_lang: str):
    """Refresh sets from TCGdex API and store in DB.

    Each language version is stored as a separate row with a composite primary key
    (e.g. "sv1_de" and "sv1_en"). lang field is strictly "en" or "de".
    """
    sets_data = pokemon_api.get_all_sets(display_lang=display_lang)

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

    # Compute owned_count per set (join via tcg_set_id)
    owned_counts = (
        db.query(Card.set_id, func.count(func.distinct(CollectionItem.card_id)).label('cnt'))
        .join(CollectionItem, CollectionItem.card_id == Card.id)
        .group_by(Card.set_id)
        .all()
    )
    owned_map = {row[0]: row[1] for row in owned_counts}
    for set_obj in sets:
        # tcg_set_id is the original ID used in cards.set_id
        set_obj.owned_count = owned_map.get(set_obj.tcg_set_id or set_obj.id, 0)

    return sets


@router.get("/new")
def get_new_sets(db: Session = Depends(get_db)):
    """Get newly detected sets."""
    new_sets = db.query(Set).filter(Set.is_new == True).all()
    return new_sets


@router.post("/mark-seen")
def mark_sets_seen(db: Session = Depends(get_db)):
    """Mark all new sets as seen."""
    db.query(Set).filter(Set.is_new == True).update({"is_new": False})
    db.commit()
    return {"message": "All new sets marked as seen"}


@router.get("/{set_id}", response_model=SetBase)
def get_set(set_id: str, db: Session = Depends(get_db)):
    """Get a single set by DB key (e.g. 'sv1_de' or 'sv1_en')."""
    set_obj = db.query(Set).filter(Set.id == set_id).first()
    if not set_obj:
        raise HTTPException(status_code=404, detail="Set not found")
    return set_obj


@router.get("/{set_id}/checklist")
def get_set_checklist(set_id: str, db: Session = Depends(get_db)):
    """Get set checklist - cards with ownership status.

    set_id is the composite DB key (e.g. 'sv1_de').
    Cards are served exclusively from the local DB — no live API call.
    """
    set_obj = db.query(Set).filter(Set.id == set_id).first()
    if not set_obj:
        raise HTTPException(status_code=404, detail="Set not found")

    # Use the original TCGdex set ID for card lookups
    tcg_id = set_obj.tcg_set_id or set_obj.id
    set_lang = set_obj.lang or "en"

    # Serve ONLY from DB — no live API call; filter by lang to avoid language mix-up
    cards = db.query(Card).filter(
        Card.set_id == tcg_id,
        Card.lang == set_lang,
    ).order_by(Card.number.asc()).all()

    # Get owned card IDs
    owned_card_ids = {
        item.card_id
        for item in db.query(CollectionItem.card_id).filter(
            CollectionItem.card_id.in_([c.id for c in cards])
        ).all()
    }

    owned_count = len(owned_card_ids)
    total_count = len(cards)

    checklist = []
    for card in cards:
        owned = card.id in owned_card_ids
        qty = 0
        if owned:
            item = db.query(CollectionItem).filter(
                CollectionItem.card_id == card.id
            ).first()
            qty = item.quantity if item else 0

        checklist.append({
            "id": card.id,
            "name": card.name,
            "number": card.number,
            "rarity": card.rarity,
            "images_small": card.images_small,
            "images_large": card.images_large,
            "owned": owned,
            "quantity": qty,
            "price_market": card.price_market,
        })

    return {
        "set": {
            "id": set_obj.id,
            "name": set_obj.name,
            "series": set_obj.series,
            "total": set_obj.total,
            "images_symbol": set_obj.images_symbol,
            "images_logo": set_obj.images_logo,
        },
        "cards": checklist,
        "owned_count": owned_count,
        "total_count": total_count,
        "progress": round((owned_count / total_count * 100) if total_count > 0 else 0, 1),
    }
