from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from api.auth import get_current_user
from database import get_db
from models import CollectionItem, Card, Set, User
from schemas import CollectionItemCreate, CollectionItemUpdate, CollectionItemResponse, BulkCollectionAddRequest, BulkCollectionAddResponse
from services import pokemon_api
from services.card_fallbacks import apply_cross_language_fallbacks
from services.card_values import effective_market_price
import datetime

router = APIRouter()

def _get_item_price(item):
    """Return the correct market price for a collection item, respecting holo variant."""
    return effective_market_price(item.card, item.variant)


def ensure_card_exists(db: Session, card_id: str, lang: str = "en") -> Card:
    """Ensure card exists in DB. If not found locally, try to fetch from TCGdex."""
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(card_id)
        card_data = pokemon_api.get_card(tcg_card_id, lang=lang)
        if not card_data:
            raise HTTPException(
                status_code=404,
                detail=f"Card {card_id} not found in local database. Please run a Sync first."
            )
        parsed = pokemon_api.parse_card_for_db(card_data, lang=lang)
        parsed = apply_cross_language_fallbacks(db, parsed)
        if parsed.get("set_id"):
            set_data = card_data.get("set", {})
            if set_data:
                set_parsed = pokemon_api.parse_set_for_db(set_data)
                set_parsed["lang"] = set_data.get("_lang", lang)
                existing_set = db.query(Set).filter(Set.id == set_parsed["id"]).first()
                if not existing_set:
                    db.add(Set(**set_parsed))
        card = Card(**parsed)
        db.add(card)
        try:
            db.commit()
            db.refresh(card)
        except Exception:
            db.rollback()
            card = db.query(Card).filter(Card.id == card_id).first()
            if not card:
                raise HTTPException(
                    status_code=404,
                    detail=f"Card {card_id} not found in local database. Please run a Sync first."
                )
    return card


@router.get("/user/{user_id}", response_model=List[CollectionItemResponse])
def get_user_collection(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """View another user's collection (read-only). Requires authentication."""
    target_user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    query = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(CollectionItem.user_id == user_id)
    return query.all()


@router.get("/", response_model=List[CollectionItemResponse])
def get_collection(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    sort_by: Optional[str] = "added_at",
    order: Optional[str] = "desc",
):
    """Get all collection items."""
    query = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(CollectionItem.user_id == current_user.id)

    sort_col = {
        "added_at": CollectionItem.added_at,
        "quantity": CollectionItem.quantity,
        "purchase_price": CollectionItem.purchase_price,
    }.get(sort_by, CollectionItem.added_at)

    if order == "desc":
        query = query.order_by(sort_col.desc())
    else:
        query = query.order_by(sort_col.asc())

    items = query.all()
    return items


@router.post("/", response_model=CollectionItemResponse)
def add_to_collection(
    item: CollectionItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a card to the collection. Cards with identical card_id+variant+lang+condition+purchase_price are grouped."""
    item_lang = item.lang or "en"

    # Resolve the correct language-variant card_id
    if item.card_id.startswith("custom-"):
        # Custom cards keep their original ID (no language suffix)
        effective_card_id = item.card_id
        # Always derive lang from the custom card record itself
        custom_card = db.query(Card).filter(Card.id == item.card_id).first()
        if custom_card and custom_card.lang:
            item_lang = custom_card.lang
    else:
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
        effective_card_id = f"{tcg_card_id}_{item_lang}"
        ensure_card_exists(db, effective_card_id, lang=item_lang)

    # Find existing entry for same card + variant + lang + condition + purchase_price combination
    existing = db.query(CollectionItem).filter(
        CollectionItem.card_id == effective_card_id,
        CollectionItem.variant == item.variant,
        CollectionItem.lang == item_lang,
        CollectionItem.condition == item.condition,
        CollectionItem.purchase_price == item.purchase_price,
        CollectionItem.user_id == current_user.id,
    ).first()

    if existing:
        existing.quantity += item.quantity or 1
        db.commit()
        db.refresh(existing)
        return existing
    else:
        db_item = CollectionItem(
            card_id=effective_card_id,
            quantity=item.quantity,
            condition=item.condition,
            variant=item.variant,
            purchase_price=item.purchase_price,
            lang=item_lang,
            user_id=current_user.id,
            added_at=datetime.datetime.utcnow(),
        )
        db.add(db_item)
        db.commit()
        db.refresh(db_item)
        return db_item


@router.post("/bulk-add", response_model=BulkCollectionAddResponse)
def bulk_add_to_collection(
    request: BulkCollectionAddRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add multiple cards to the collection in a single request.

    Each item is committed independently so one invalid card does not roll back
    the whole batch. Existing rows are matched by the database uniqueness model
    (card_id+variant+lang) plus the current user where possible, then quantity
    is incremented.
    """
    added = 0
    updated = 0
    failed = 0
    errors: List[str] = []

    for item in request.items:
        try:
            item_lang = item.lang or "en"

            if item.card_id.startswith("custom-"):
                effective_card_id = item.card_id
                custom_card = db.query(Card).filter(Card.id == item.card_id).first()
                if custom_card and custom_card.lang:
                    item_lang = custom_card.lang
            else:
                tcg_card_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
                effective_card_id = f"{tcg_card_id}_{item_lang}"
                ensure_card_exists(db, effective_card_id, lang=item_lang)

            existing = db.query(CollectionItem).filter(
                CollectionItem.card_id == effective_card_id,
                CollectionItem.variant == item.variant,
                CollectionItem.lang == item_lang,
                CollectionItem.user_id == current_user.id,
            ).first()

            if existing:
                existing.quantity += item.quantity or 1
                db.commit()
                updated += 1
            else:
                db.add(CollectionItem(
                    card_id=effective_card_id,
                    quantity=item.quantity,
                    condition=item.condition,
                    variant=item.variant,
                    purchase_price=item.purchase_price,
                    lang=item_lang,
                    user_id=current_user.id,
                    added_at=datetime.datetime.utcnow(),
                ))
                db.commit()
                added += 1
        except HTTPException as exc:
            db.rollback()
            failed += 1
            errors.append(f"{item.card_id}: {exc.detail}")
        except Exception as exc:
            db.rollback()
            failed += 1
            errors.append(f"{item.card_id}: {str(exc)}")

    return BulkCollectionAddResponse(added=added, updated=updated, failed=failed, errors=errors)

@router.put("/{item_id}", response_model=CollectionItemResponse)
def update_collection_item(
    item_id: int,
    update: CollectionItemUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a collection item."""
    item = db.query(CollectionItem).filter(
        CollectionItem.id == item_id,
        CollectionItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    # Use exclude_unset so only fields explicitly sent in the request are updated.
    # This allows null values (e.g. clearing variant or purchase_price) to be saved.
    update_data = update.model_dump(exclude_unset=True)

    # If lang is being changed, also update card_id to the correct language variant
    new_lang = update_data.get("lang")
    if new_lang and new_lang != item.lang:
        card = db.query(Card).filter(Card.id == item.card_id).first()
        if card and not card.is_custom:
            tcg_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
            new_card_id = f"{tcg_id}_{new_lang}"
            ensure_card_exists(db, new_card_id, lang=new_lang)
            update_data["card_id"] = new_card_id

    for field, value in update_data.items():
        setattr(item, field, value)

    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}")
def remove_from_collection(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a card from collection."""
    item = db.query(CollectionItem).filter(
        CollectionItem.id == item_id,
        CollectionItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    db.delete(item)
    db.commit()
    return {"message": "Removed from collection"}


@router.get("/stats/summary")
def get_collection_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get collection statistics."""
    items = db.query(CollectionItem).options(
        joinedload(CollectionItem.card)
    ).filter(CollectionItem.user_id == current_user.id).all()

    total_cards = sum(item.quantity for item in items)
    unique_cards = len(set(item.card_id for item in items))
    total_value = sum(
        _get_item_price(item) * item.quantity
        for item in items
        if item.card
    )
    total_cost = sum(
        (item.purchase_price or 0) * item.quantity
        for item in items
    )

    return {
        "total_cards": total_cards,
        "unique_cards": unique_cards,
        "total_value": round(total_value, 2),
        "total_cost": round(total_cost, 2),
        "pnl": round(total_value - total_cost, 2),
    }
