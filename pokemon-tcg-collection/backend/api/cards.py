from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
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
    db: Session, set_code: str, card_number: str, page: int, page_size: int, lang: str = "all"
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

    # 3. Look for card in DB (number may be zero-padded or not)
    card_filters = [Card.set_id == set_obj.id, Card.number == card_number]
    if lang != "all":
        card_filters.append(Card.lang == lang)
    card = db.query(Card).filter(*card_filters).first()

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
        stripped_filters = [Card.set_id == set_obj.id, Card.number == card_number_stripped]
        if lang != "all":
            stripped_filters.append(Card.lang == lang)
        card = db.query(Card).filter(*stripped_filters).first()
        if card:
            return {
                "data": [_card_to_dict(card)],
                "total_count": 1,
                "page": page,
                "page_size": page_size,
            }

    # 4. Not in DB — try the API
    try:
        api_result = pokemon_api.search_cards(set_id=set_obj.id, page=1, page_size=500, lang="de")
        all_cards = api_result.get("data", [])
        matched = [
            c for c in all_cards
            if str(c.get("number") or "").lstrip("0") == card_number_stripped
            or str(c.get("number") or "") == card_number
        ]
        start = (page - 1) * page_size
        return {
            "data": matched[start : start + page_size],
            "total_count": len(matched),
            "page": page,
            "page_size": page_size,
        }
    except Exception:
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


def _do_search_and_cache(
    db, name, set_id, type_filter, rarity, artist, hp_min, hp_max,
    sort_by, sort_order, page, page_size, lang
):
    """Run a search against the TCGdex API for a single language and cache results."""
    effective_name = name
    if set_id and name and re.match(r'^\d+$', name.strip()):
        effective_name = None

    result = pokemon_api.search_cards(
        name=effective_name,
        set_id=set_id,
        type_filter=type_filter,
        rarity=rarity,
        artist=artist,
        hp_min=hp_min,
        hp_max=hp_max,
        sort_by=sort_by,
        sort_order=sort_order,
        page=1,
        page_size=500,  # fetch all to allow dedup/merge when lang="all"
        local_id=name.strip() if set_id and name and re.match(r'^\d+$', name.strip()) else None,
        lang=lang,
    )
    cards_data = result.get("data", [])

    # Add lang tag to each card in the result
    for card in cards_data:
        card["_lang"] = lang

    # Cache brief card data in DB
    for card_data in cards_data:
        try:
            parsed = pokemon_api.parse_card_for_db(card_data)
            if parsed.get("set_id"):
                existing_set = db.query(Set).filter(Set.id == parsed["set_id"]).first()
                if not existing_set:
                    db.add(Set(id=parsed["set_id"], name=parsed["set_id"], total=0))
            existing = db.query(Card).filter(Card.id == parsed["id"]).first()
            if existing:
                for k, v in parsed.items():
                    if k != "id" and v is not None:
                        setattr(existing, k, v)
            else:
                db.add(Card(**parsed))
        except Exception:
            pass

    try:
        db.commit()
    except Exception:
        db.rollback()

    return cards_data


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
    """Search cards via TCGdex API and cache minimal results.

    Special patterns supported:
    - "MEP 022" or "sv08 032" → set abbreviation/id + card number search
    - Pure number with set_id filter → number search within the selected set
    - lang: "de" → only German API, "en" → only English API, "all" → both (merged, dedup by ID)
    """
    search_lang = lang or "all"

    try:
        # ── Code + number pattern: "MEP 022", "SSP 136", "sv08 032" ──────────
        if name:
            m = _CODE_NUMBER_RE.match(name.strip())
            if m:
                set_code = m.group(1)
                card_number = m.group(2)
                return _search_by_code_number(db, set_code, card_number, page, page_size, lang=search_lang)

        if search_lang == "all":
            # Search both languages and merge (dedup by card ID, keeping first occurrence)
            de_cards = _do_search_and_cache(
                db, name, set_id, type_filter, rarity, artist, hp_min, hp_max,
                sort_by, sort_order, page, page_size, "de"
            )
            en_cards = _do_search_and_cache(
                db, name, set_id, type_filter, rarity, artist, hp_min, hp_max,
                sort_by, sort_order, page, page_size, "en"
            )
            # Merge: DE first, then add EN cards not already seen (by ID)
            seen_ids = set()
            merged = []
            for card in de_cards + en_cards:
                cid = card.get("id")
                if cid not in seen_ids:
                    seen_ids.add(cid)
                    merged.append(card)

            total_count = len(merged)
            start = (page - 1) * page_size
            cards_data = merged[start:start + page_size]
        else:
            cards_data = _do_search_and_cache(
                db, name, set_id, type_filter, rarity, artist, hp_min, hp_max,
                sort_by, sort_order, page, page_size, search_lang
            )
            total_count = len(cards_data)
            start = (page - 1) * page_size
            cards_data = cards_data[start:start + page_size]

        return {
            "data": cards_data,
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

        # Try to get the API card info (brief)
        api_card_info = None
        try:
            api_data = pokemon_api.get_card(match.api_card_id, lang="en")
            if api_data:
                parsed = pokemon_api.parse_card_for_db(api_data, lang="en")
                api_card_info = {
                    "id": parsed["id"],
                    "name": parsed["name"],
                    "images_small": parsed.get("images_small"),
                    "images_large": parsed.get("images_large"),
                    "rarity": parsed.get("rarity"),
                    "number": parsed.get("number"),
                    "set_id": parsed.get("set_id"),
                }
        except Exception:
            pass

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
        fetch_lang = "en"
        if not api_data:
            api_data = pokemon_api.get_card(api_card_id, lang="de")
            fetch_lang = "de"
        if not api_data:
            raise HTTPException(status_code=404, detail="API card not found on TCGdex")
        parsed = pokemon_api.parse_card_for_db(api_data, lang=fetch_lang)
        composite_api_card_id = parsed["id"]  # e.g. "sv1-1_en"

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

        # Upsert API card using composite ID
        existing_api_card = db.query(Card).filter(Card.id == composite_api_card_id).first()
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
        ).update({"card_id": composite_api_card_id}, synchronize_session=False)
    except Exception:
        pass  # ignore unique constraint violations (duplicates)

    # 3. Re-assign wishlist items
    try:
        db.query(WishlistItem).filter(
            WishlistItem.card_id == custom_card_id
        ).update({"card_id": composite_api_card_id}, synchronize_session=False)
    except Exception:
        pass

    # 4. Re-assign binder cards
    try:
        db.query(BinderCard).filter(
            BinderCard.card_id == custom_card_id
        ).update({"card_id": composite_api_card_id}, synchronize_session=False)
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

    return {"status": "migrated", "api_card_id": composite_api_card_id}


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
    # strip_lang_suffix handles both composite IDs (sv1-1_de) and legacy IDs (sv1-1)
    tcg_card_id, detected_lang = pokemon_api.strip_lang_suffix(card_id)
    card_lang = lang or detected_lang
    try:
        card_data = pokemon_api.get_card(tcg_card_id, lang=card_lang)
        if not card_data:
            # Try the other language as fallback
            fallback = "de" if card_lang == "en" else "en"
            card_data = pokemon_api.get_card(tcg_card_id, lang=fallback)
            if card_data:
                card_lang = fallback
        if not card_data:
            raise HTTPException(status_code=404, detail="Card not found")

        parsed = pokemon_api.parse_card_for_db(card_data, lang=card_lang)

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
