from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, cast, Integer
from sqlalchemy.exc import IntegrityError
from typing import Optional, List
from api.auth import get_current_user
from database import get_db
from models import Card, Set, PriceHistory, CustomCardMatch, CollectionItem, WishlistItem, BinderCard, Setting, User
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
    set_ref = getattr(card, 'set_ref', None)
    set_ref_dict = {"id": set_ref.id, "name": set_ref.name} if set_ref else None
    return {
        "id": card.id,
        "name": card.name,
        "number": card.number,
        "localId": card.number,
        "set_id": card.set_id,
        "set_ref": set_ref_dict,
        "rarity": card.rarity,
        "types": card.types,
        "supertype": card.supertype,
        "hp": card.hp,
        "artist": card.artist,
        "images_small": card.images_small,
        "images_large": card.images_large,
        "is_custom": card.is_custom or False,
        "lang": card.lang or "en",
        "price_market": card.price_market,
        "price_low": card.price_low,
        "price_trend": card.price_trend,
        "price_avg1": card.price_avg1,
        "price_avg7": card.price_avg7,
        "price_avg30": card.price_avg30,
        # Holo prices (may be None if not yet synced)
        "price_market_holo": getattr(card, 'price_market_holo', None),
        "price_low_holo": getattr(card, 'price_low_holo', None),
        "price_trend_holo": getattr(card, 'price_trend_holo', None),
        "price_avg1_holo": getattr(card, 'price_avg1_holo', None),
        "price_avg7_holo": getattr(card, 'price_avg7_holo', None),
        "price_avg30_holo": getattr(card, 'price_avg30_holo', None),
        # TCGPlayer
        "price_tcg_normal_market": getattr(card, 'price_tcg_normal_market', None),
        "price_tcg_reverse_market": getattr(card, 'price_tcg_reverse_market', None),
        "price_tcg_holo_market": getattr(card, 'price_tcg_holo_market', None),
    }


def _search_by_code_number(
    db: Session, set_code: str, card_number: str, page: int, page_size: int, lang: str = "all"
) -> dict:
    """Search for a card by set abbreviation/id + card number (localId).
    Returns cards for ALL languages unless lang is specified.
    """
    set_code_upper = set_code.upper()

    # 1. Find all matching set objects (may have sv1_de AND sv1_en)
    set_objs = db.query(Set).filter(
        (func.upper(Set.abbreviation) == set_code_upper) |
        (func.upper(Set.id) == set_code_upper) |
        (func.upper(Set.tcg_set_id) == set_code_upper)
    ).all()

    if not set_objs:
        # Fall back to live TCGdex API to find the set by abbreviation
        try:
            api_sets = pokemon_api.get_all_sets()
            for api_set in api_sets:
                abbr_obj = api_set.get("abbreviation") or {}
                official = (
                    abbr_obj.get("official") if isinstance(abbr_obj, dict) else None
                )
                if official and official.upper() == set_code_upper:
                    parsed_set = pokemon_api.parse_set_for_db(api_set)
                    parsed_set["lang"] = api_set.get("_lang", "en")
                    existing_set = db.query(Set).filter(Set.id == parsed_set["id"]).first()
                    if existing_set:
                        for k, v in parsed_set.items():
                            if k != "id" and v is not None:
                                setattr(existing_set, k, v)
                        set_obj = existing_set
                    else:
                        set_obj = Set(**parsed_set)
                        db.add(set_obj)
                    db.commit()
                    db.refresh(set_obj)
            set_objs = db.query(Set).filter(
                (func.upper(Set.abbreviation) == set_code_upper) |
                (func.upper(Set.id) == set_code_upper) |
                (func.upper(Set.tcg_set_id) == set_code_upper)
            ).all()
        except Exception:
            pass

    if not set_objs:
        return {"data": [], "total_count": 0, "page": page, "page_size": page_size}

    # Collect unique TCGdex set IDs
    tcg_set_ids = list({s.tcg_set_id or s.id for s in set_objs})

    # 2. Look for cards in DB matching any of those set IDs and the given number
    lang_filters = [Card.set_id.in_(tcg_set_ids), Card.number == card_number]
    if lang != "all":
        lang_filters.append(Card.lang == lang)
    cards = db.query(Card).filter(*lang_filters).all()

    # Also try without leading zeros (e.g. "022" → "22")
    if not cards:
        card_number_stripped = card_number.lstrip("0") or "0"
        if card_number_stripped != card_number:
            stripped_filters = [Card.set_id.in_(tcg_set_ids), Card.number == card_number_stripped]
            if lang != "all":
                stripped_filters.append(Card.lang == lang)
            cards = db.query(Card).filter(*stripped_filters).all()

    # 3. Card not in DB — fetch from TCGdex and cache
    if not cards:
        for set_obj in set_objs:
            tcg_set_id = set_obj.tcg_set_id or set_obj.id
            set_lang = set_obj.lang or "en"
            try:
                set_data = pokemon_api.get_set_cards(tcg_set_id, lang=set_lang)
                for card_data in set_data.get("cards", []):
                    parsed = pokemon_api.parse_card_for_db(card_data, default_set_id=tcg_set_id, lang=set_lang)
                    existing = db.query(Card).filter(Card.id == parsed["id"]).first()
                    if not existing:
                        db.add(Card(**parsed))
                db.commit()
            except Exception:
                pass

        lang_filters = [Card.set_id.in_(tcg_set_ids), Card.number == card_number]
        if lang != "all":
            lang_filters.append(Card.lang == lang)
        cards = db.query(Card).filter(*lang_filters).all()
        if not cards:
            card_number_stripped = card_number.lstrip("0") or "0"
            if card_number_stripped != card_number:
                stripped_filters = [Card.set_id.in_(tcg_set_ids), Card.number == card_number_stripped]
                if lang != "all":
                    stripped_filters.append(Card.lang == lang)
                cards = db.query(Card).filter(*stripped_filters).all()

    if not cards:
        return {"data": [], "total_count": 0, "page": page, "page_size": page_size}

    start = (page - 1) * page_size
    page_cards = cards[start:start + page_size]
    return {
        "data": [_card_to_dict(c) for c in page_cards],
        "total_count": len(cards),
        "page": page,
        "page_size": page_size,
    }


@router.post("/custom")
def create_custom_card(
    data: CardCustomCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a card manually (not from TCGdex API)."""
    # Generate card ID
    if data.set_id and data.number:
        card_id = f"custom-{data.set_id}-{data.number}"
    else:
        card_id = f"custom-{uuid4().hex[:8]}"

    # Check for duplicate ID
    existing = db.query(Card).filter(Card.id == card_id).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Eine Karte mit der ID '{card_id}' existiert bereits."
        )

    # Derive language from the set if not explicitly provided
    card_lang = data.lang
    if not card_lang and data.set_id:
        existing_set = db.query(Set).filter(
            (Set.tcg_set_id == data.set_id) | (Set.id == data.set_id)
        ).first()
        if existing_set:
            card_lang = existing_set.lang
    card_lang = card_lang or "en"

    # Ensure set record exists if set_id given
    if data.set_id:
        existing_set = db.query(Set).filter(
            (Set.tcg_set_id == data.set_id) | (Set.id == data.set_id)
        ).first()
        if not existing_set:
            db.add(Set(id=data.set_id, name=data.set_id, total=0, tcg_set_id=data.set_id, lang=card_lang))

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
        lang=card_lang,
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
def update_custom_card(
    card_id: str,
    update: CustomCardUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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


@router.delete("/custom/{card_id}")
def delete_custom_card(
    card_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a custom card and all related records."""
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    if not card.is_custom:
        raise HTTPException(status_code=400, detail="Card is not custom")

    try:
        db.query(CollectionItem).filter(CollectionItem.card_id == card_id).delete(synchronize_session=False)
        db.query(WishlistItem).filter(WishlistItem.card_id == card_id).delete(synchronize_session=False)
        db.query(BinderCard).filter(BinderCard.card_id == card_id).delete(synchronize_session=False)
        db.query(PriceHistory).filter(PriceHistory.card_id == card_id).delete(synchronize_session=False)
        db.query(CustomCardMatch).filter(CustomCardMatch.custom_card_id == card_id).delete(synchronize_session=False)
        db.delete(card)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"message": "Custom card deleted"}


@router.get("/custom", response_model=List[CardBase])
def list_custom_cards(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all manually created custom cards."""
    cards = db.query(Card).filter(Card.is_custom == True).order_by(Card.id.desc()).all()
    return [_card_to_dict(c) for c in cards]


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
    current_user: User = Depends(get_current_user),
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
                return _search_by_code_number(db, set_code, card_number, page, page_size, lang=search_lang)

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
def get_custom_matches(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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

        # Try to get the API card info from the local DB (look up by tcg_card_id since DB id is composite)
        api_card_info = None
        api_card = db.query(Card).filter(Card.tcg_card_id == match.api_card_id).first()
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
def migrate_custom_card(
    match_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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

    # Determine the language of the custom card for language-aware migration
    custom_card_obj = db.query(Card).filter(Card.id == custom_card_id).first()
    custom_lang = (custom_card_obj.lang or "en") if custom_card_obj else "en"

    # 1. Fetch API card and upsert in DB
    try:
        api_data = pokemon_api.get_card(api_card_id, lang=custom_lang)
        fetch_lang = custom_lang
        if not api_data:
            fallback_lang = "de" if custom_lang == "en" else "en"
            api_data = pokemon_api.get_card(api_card_id, lang=fallback_lang)
            fetch_lang = fallback_lang
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
        ).update({"card_id": composite_api_card_id, "lang": custom_lang}, synchronize_session=False)
        db.flush()
    except IntegrityError:
        db.rollback()
        # If the API card already exists in collection with same variant/lang,
        # merge quantities onto the existing row and remove old custom rows.
        custom_items = db.query(CollectionItem).filter(
            CollectionItem.card_id == custom_card_id
        ).all()
        for item in custom_items:
            existing_item = db.query(CollectionItem).filter(
                CollectionItem.card_id == composite_api_card_id,
                CollectionItem.variant == item.variant,
                CollectionItem.lang == custom_lang,
            ).first()
            if existing_item:
                existing_item.quantity = (existing_item.quantity or 0) + (item.quantity or 0)
                if existing_item.purchase_price is None:
                    existing_item.purchase_price = item.purchase_price
                db.delete(item)
            else:
                item.card_id = composite_api_card_id
                item.lang = custom_lang
        db.flush()

    # 3. Re-assign wishlist items
    try:
        db.query(WishlistItem).filter(
            WishlistItem.card_id == custom_card_id
        ).update({"card_id": composite_api_card_id}, synchronize_session=False)
        db.flush()
    except IntegrityError:
        db.rollback()
        custom_wishlist = db.query(WishlistItem).filter(
            WishlistItem.card_id == custom_card_id
        ).first()
        existing_wishlist = db.query(WishlistItem).filter(
            WishlistItem.card_id == composite_api_card_id
        ).first()
        if custom_wishlist:
            if existing_wishlist:
                if existing_wishlist.price_alert_above is None:
                    existing_wishlist.price_alert_above = custom_wishlist.price_alert_above
                if existing_wishlist.price_alert_below is None:
                    existing_wishlist.price_alert_below = custom_wishlist.price_alert_below
                if existing_wishlist.notified_at is None:
                    existing_wishlist.notified_at = custom_wishlist.notified_at
                db.delete(custom_wishlist)
            else:
                custom_wishlist.card_id = composite_api_card_id
        db.flush()

    # 4. Re-assign binder cards
    try:
        db.query(BinderCard).filter(
            BinderCard.card_id == custom_card_id
        ).update({"card_id": composite_api_card_id}, synchronize_session=False)
        db.flush()
    except IntegrityError:
        db.rollback()
        custom_binder_cards = db.query(BinderCard).filter(
            BinderCard.card_id == custom_card_id
        ).all()
        for binder_card in custom_binder_cards:
            existing_binder_card = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_card.binder_id,
                BinderCard.card_id == composite_api_card_id,
            ).first()
            if existing_binder_card:
                db.delete(binder_card)
            else:
                binder_card.card_id = composite_api_card_id
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
def dismiss_custom_match(
    match_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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


@router.get("/{card_id}/lang/{lang}")
def get_card_in_lang(
    card_id: str,
    lang: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Given a card_id (any language variant), find the equivalent card in the requested language.

    Strategy:
    1. Load the source card.
    2. Determine its original TCGdex set_id and number.
    3. Query for a card with the same set_id + number but lang = requested lang.
    4. If found, return it. If not, return the original card (fallback).
    """
    source = db.query(Card).filter(Card.id == card_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Card not found")

    # Look for sibling card with same set_id + number but requested lang
    sibling = db.query(Card).filter(
        Card.set_id == source.set_id,
        Card.number == source.number,
        Card.lang == lang,
        Card.is_custom == False,
    ).first()

    if sibling:
        return _card_to_dict(sibling)

    # Fallback: return original card
    return _card_to_dict(source)


@router.get("/{card_id}/price-history", response_model=List[PriceHistoryResponse])
def get_price_history(
    card_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get price history for a specific card."""
    history = (
        db.query(PriceHistory)
        .filter(PriceHistory.card_id == card_id)
        .order_by(PriceHistory.date.asc())
        .all()
    )
    return history


@router.get("/{card_id}", response_model=CardBase)
def get_card(
    card_id: str,
    lang: Optional[str] = Query("en"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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
