from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, cast, Integer
from typing import Optional, List
from database import get_db
from models import Card, Set, PriceHistory, CustomCardMatch, CollectionItem, WishlistItem, BinderCard, Setting
from schemas import CardBase, CardWithSet, PriceHistoryResponse, CardCustomCreate, CustomCardUpdate
from services import pokemon_api
import datetime
import re
from uuid import uuid4

router = APIRouter()

# Pattern: one or more letters, whitespace, one or more digits (e.g. "MEP 022", "SSP 136", "sv08 032")
_CODE_NUMBER_RE = re.compile(r'^([A-Za-z]+\d*)\s+(\d+)$')


def _get_language(db: Session) -> str:
    """Get display language from settings."""
    row = db.query(Setting).filter(Setting.key == "language").first()
    return row.value if row else "de"


def _card_to_dict(card: Card) -> dict:
    """Convert a Card ORM object to a dict matching the search result format."""
    return {
        "id": card.id,
        "name": card.name,
        "number": card.number,
        "localId": card.number,
        "set_id": card.set_id,
        "rarity": card.rarity,
        "types": card.types,
        "supertype": card.supertype,
        "hp": card.hp,
        "artist": card.artist,
        "images_small": card.images_small,
        "images_large": card.images_large,
        "is_custom": card.is_custom or False,
        "price_market": card.price_market,
        "price_low": card.price_low,
        "price_trend": card.price_trend,
    }


def _search_by_code_number(
    db: Session, set_code: str, card_number: str, page: int, page_size: int
) -> dict:
    """Search for a card by set abbreviation/id + card number (localId)."""
    set_code_upper = set_code.upper()

    # 1. Try abbreviation (case-insensitive)
    set_obj = db.query(Set).filter(
        func.upper(Set.abbreviation) == set_code_upper
    ).first()

    # 2. Fall back to set id (case-insensitive)
    if not set_obj:
        set_obj = db.query(Set).filter(
            func.upper(Set.id) == set_code_upper
        ).first()

    if not set_obj:
        return {"data": [], "total_count": 0, "page": page, "page_size": page_size}

    # Use original TCGdex ID (cards.set_id stores this, not the composite DB key)
    tcg_set_id = set_obj.tcg_set_id or set_obj.id

    # 3. Look for card in DB (number may be zero-padded or not)
    card = db.query(Card).filter(
        Card.set_id == tcg_set_id,
        Card.number == card_number,
    ).first()

    if card:
        return {
            "data": [_card_to_dict(card)],
            "total_count": 1,
            "page": page,
            "page_size": page_size,
        }

    # Also try without leading zeros (e.g. "022" → "22")
    card_number_stripped = card_number.lstrip("0") or "0"
    if card_number_stripped != card_number:
        card = db.query(Card).filter(
            Card.set_id == tcg_set_id,
            Card.number == card_number_stripped,
        ).first()
        if card:
            return {
                "data": [_card_to_dict(card)],
                "total_count": 1,
                "page": page,
                "page_size": page_size,
            }

    # Card not in DB — return empty result (will appear after sync)
    return {"data": [], "total_count": 0, "page": page, "page_size": page_size}


@router.post("/custom")
def create_custom_card(data: CardCustomCreate, db: Session = Depends(get_db)):
    """Create a card manually (not from TCGdex API)."""
    # Generate card ID
    if data.set_id and data.number:
        card_id = f"{data.set_id}-{data.number}"
    else:
        card_id = f"custom-{uuid4().hex[:8]}"

    # Check for duplicate ID
    existing = db.query(Card).filter(Card.id == card_id).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Eine Karte mit der ID '{card_id}' existiert bereits."
        )

    # Ensure set record exists if set_id given
    if data.set_id:
        existing_set = db.query(Set).filter(Set.id == data.set_id).first()
        if not existing_set:
            db.add(Set(id=data.set_id, name=data.set_id, total=0))

    # image_url is stored as images_small and images_large (unchanged, not TCGdex)
    card = Card(
        id=card_id,
        name=data.name,
        set_id=data.set_id or None,
        number=data.number or None,
        rarity=data.rarity or None,
        types=data.types or None,
        hp=data.hp or None,
        artist=data.artist or None,
        images_small=data.image_url or None,
        images_large=data.image_url or None,
        is_custom=True,
    )
    db.add(card)
    try:
        db.commit()
        db.refresh(card)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return _card_to_dict(card)


@router.put("/custom/{card_id}", response_model=CardBase)
def update_custom_card(card_id: str, update: CustomCardUpdate, db: Session = Depends(get_db)):
    """Update an existing custom card's fields."""
    card = db.query(Card).filter(Card.id == card_id, Card.is_custom == True).first()
    if not card:
        raise HTTPException(status_code=404, detail="Custom card not found")
    update_data = update.model_dump(exclude_unset=True)
    # image_url maps to images_small and images_large on the model
    if "image_url" in update_data:
        img = update_data.pop("image_url")
        card.images_small = img
        card.images_large = img
    for field, value in update_data.items():
        setattr(card, field, value)
    db.commit()
    db.refresh(card)
    return card


@router.get("/search")
def search_cards(
    name: Optional[str] = None,
    set_id: Optional[str] = None,
    type_filter: Optional[str] = Query(None, alias="type"),
    rarity: Optional[str] = None,
    artist: Optional[str] = None,
    hp_min: Optional[int] = None,
    hp_max: Optional[int] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    page: int = 1,
    page_size: int = 20,
    lang: Optional[str] = Query("all", description="Language filter: 'de', 'en', or 'all'"),
    db: Session = Depends(get_db),
):
    """Search cards from the local DB.

    Special patterns supported:
    - "MEP 022" or "sv08 032" → set abbreviation/id + card number search
    - lang: "de" → German cards only, "en" → English cards only, "all" → all languages
    """
    search_lang = lang or "all"

    try:
        # ── Code + number pattern: "MEP 022", "SSP 136", "sv08 032" ──────────
        if name:
            m = _CODE_NUMBER_RE.match(name.strip())
            if m:
                set_code = m.group(1)
                card_number = m.group(2)
                return _search_by_code_number(db, set_code, card_number, page, page_size)

        # ── Pure DB search ────────────────────────────────────────────────────
        query = db.query(Card).filter(Card.is_custom == False)

        if name:
            query = query.filter(Card.name.ilike(f"%{name}%"))

        if set_id:
            # set_id may be composite DB key (sv1_en) or original tcg id (sv1)
            set_obj = db.query(Set).filter(
                (Set.id == set_id) | (Set.tcg_set_id == set_id)
            ).first()
            if set_obj:
                query = query.filter(Card.set_id == (set_obj.tcg_set_id or set_obj.id))
            else:
                query = query.filter(Card.set_id == set_id)

        if search_lang != "all":
            query = query.filter(Card.lang == search_lang)

        if type_filter:
            query = query.filter(Card.types.contains([type_filter]))

        if rarity:
            query = query.filter(Card.rarity.ilike(f"%{rarity}%"))

        if artist:
            query = query.filter(Card.artist.ilike(f"%{artist}%"))

        if hp_min is not None:
            query = query.filter(cast(Card.hp, Integer) >= hp_min)

        if hp_max is not None:
            query = query.filter(cast(Card.hp, Integer) <= hp_max)

        if sort_by == "name":
            col = Card.name
        elif sort_by == "number":
            col = Card.number
        elif sort_by == "rarity":
            col = Card.rarity
        else:
            col = Card.name

        if sort_order == "desc":
            query = query.order_by(col.desc())
        else:
            query = query.order_by(col.asc())

        total_count = query.count()
        cards = query.offset((page - 1) * page_size).limit(page_size).all()

        return {
            "data": [_card_to_dict(c) for c in cards],
            "total_count": total_count,
            "page": page,
            "page_size": page_size,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/custom/matches")
def get_custom_matches(db: Session = Depends(get_db)):
    """Return all pending custom card matches with details for preview."""
    matches = (
        db.query(CustomCardMatch)
        .filter(CustomCardMatch.status == "pending")
        .order_by(CustomCardMatch.matched_at.desc())
        .all()
    )

    result = []
    for match in matches:
        custom_card = db.query(Card).filter(Card.id == match.custom_card_id).first()

        # Try to get the API card info from the local DB
        api_card_info = None
        api_card = db.query(Card).filter(Card.id == match.api_card_id).first()
        if api_card:
            api_card_info = {
                "id": api_card.id,
                "name": api_card.name,
                "images_small": api_card.images_small,
                "images_large": api_card.images_large,
                "rarity": api_card.rarity,
                "number": api_card.number,
                "set_id": api_card.set_id,
            }

        result.append({
            "match_id": match.id,
            "status": match.status,
            "matched_at": match.matched_at.isoformat() if match.matched_at else None,
            "custom_card": _card_to_dict(custom_card) if custom_card else None,
            "api_card": api_card_info,
        })

    return result


@router.post("/custom/migrate/{match_id}")
def migrate_custom_card(match_id: int, db: Session = Depends(get_db)):
    """Migrate a custom card to its API equivalent.

    Steps:
    1. Load the API card and save/update it in the DB.
    2. Move all CollectionItems, WishlistItems, BinderCards from old custom_card_id → api_card_id.
    3. Delete the old custom Card.
    4. Set match status to 'migrated'.
    """
    match = db.query(CustomCardMatch).filter(CustomCardMatch.id == match_id).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "pending":
        raise HTTPException(status_code=400, detail=f"Match is already {match.status}")

    custom_card_id = match.custom_card_id
    api_card_id = match.api_card_id

    # 1. Fetch API card and upsert in DB
    try:
        api_data = pokemon_api.get_card(api_card_id, lang="en")
        if not api_data:
            api_data = pokemon_api.get_card(api_card_id, lang="de")
        if not api_data:
            raise HTTPException(status_code=404, detail="API card not found on TCGdex")
        parsed = pokemon_api.parse_card_for_db(api_data)

        # Ensure set record exists
        if parsed.get("set_id"):
            set_obj = db.query(Set).filter(Set.id == parsed["set_id"]).first()
            if not set_obj:
                set_data = api_data.get("set") or {}
                if set_data:
                    set_parsed = pokemon_api.parse_set_for_db(set_data)
                    db.add(Set(**set_parsed))
                else:
                    db.add(Set(id=parsed["set_id"], name=parsed["set_id"], total=0))

        # Upsert API card
        existing_api_card = db.query(Card).filter(Card.id == api_card_id).first()
        if existing_api_card:
            for k, v in parsed.items():
                if k != "id" and v is not None:
                    setattr(existing_api_card, k, v)
            existing_api_card.is_custom = False
        else:
            parsed["is_custom"] = False
            db.add(Card(**parsed))

        db.flush()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to load API card: {e}")

    # 2. Re-assign collection items
    try:
        db.query(CollectionItem).filter(
            CollectionItem.card_id == custom_card_id
        ).update({"card_id": api_card_id}, synchronize_session=False)
    except Exception:
        pass  # ignore unique constraint violations (duplicates)

    # 3. Re-assign wishlist items
    try:
        db.query(WishlistItem).filter(
            WishlistItem.card_id == custom_card_id
        ).update({"card_id": api_card_id}, synchronize_session=False)
    except Exception:
        pass

    # 4. Re-assign binder cards
    try:
        db.query(BinderCard).filter(
            BinderCard.card_id == custom_card_id
        ).update({"card_id": api_card_id}, synchronize_session=False)
    except Exception:
        pass

    db.flush()

    # 5. Delete the old custom card
    old_card = db.query(Card).filter(Card.id == custom_card_id).first()
    if old_card:
        db.delete(old_card)

    # 6. Mark match as migrated
    match.status = "migrated"

    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Migration failed: {e}")

    return {"status": "migrated", "api_card_id": api_card_id}


@router.post("/custom/dismiss/{match_id}")
def dismiss_custom_match(match_id: int, db: Session = Depends(get_db)):
    """Dismiss a custom card match (keep the manual card, ignore the API version)."""
    match = db.query(CustomCardMatch).filter(CustomCardMatch.id == match_id).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "pending":
        raise HTTPException(status_code=400, detail=f"Match is already {match.status}")

    match.status = "dismissed"
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "dismissed"}


@router.get("/{card_id}/price-history", response_model=List[PriceHistoryResponse])
def get_price_history(card_id: str, db: Session = Depends(get_db)):
    """Get price history for a specific card."""
    history = (
        db.query(PriceHistory)
        .filter(PriceHistory.card_id == card_id)
        .order_by(PriceHistory.date.asc())
        .all()
    )
    return history


@router.get("/{card_id}", response_model=CardBase)
def get_card(card_id: str, lang: Optional[str] = Query("en"), db: Session = Depends(get_db)):
    """Get a single card from DB or fetch full detail from TCGdex.

    lang: the language to fetch from (defaults to "en"). The card's stored language
    is always used if available; this parameter only affects new fetches.
    """
    card = db.query(Card).filter(Card.id == card_id).first()
    if card:
        return card

    # Fetch full card detail from TCGdex (includes pricing)
    card_lang = lang or "en"
    try:
        card_data = pokemon_api.get_card(card_id, lang=card_lang)
        if not card_data:
            # Try the other language as fallback
            fallback = "de" if card_lang == "en" else "en"
            card_data = pokemon_api.get_card(card_id, lang=fallback)
        if not card_data:
            raise HTTPException(status_code=404, detail="Card not found")

        parsed = pokemon_api.parse_card_for_db(card_data)

        # Ensure set exists
        if parsed.get("set_id"):
            set_obj = db.query(Set).filter(Set.id == parsed["set_id"]).first()
            if not set_obj:
                # Create minimal set record
                set_data = card_data.get("set") or {}
                if set_data:
                    set_parsed = pokemon_api.parse_set_for_db(set_data)
                    db.add(Set(**set_parsed))
                else:
                    db.add(Set(id=parsed["set_id"], name=parsed["set_id"], total=0))

        card = Card(**parsed)
        db.add(card)
        db.commit()
        db.refresh(card)
        return card
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
