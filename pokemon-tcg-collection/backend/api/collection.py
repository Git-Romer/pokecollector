from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from database import get_db
from models import CollectionItem, Card, Set
from schemas import CollectionItemCreate, CollectionItemUpdate, CollectionItemResponse
from services import pokemon_api
import datetime

router = APIRouter()


def ensure_card_exists(db: Session, card_id: str, lang: str = "en") -> Card:
    """Ensure card exists in DB, fetch from API if not."""
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        card_data = pokemon_api.get_card(card_id, lang=lang)
        if not card_data:
            # Try fallback language
            fallback = "de" if lang == "en" else "en"
            card_data = pokemon_api.get_card(card_id, lang=fallback)
        if not card_data:
            raise HTTPException(status_code=404, detail=f"Card {card_id} not found")
        parsed = pokemon_api.parse_card_for_db(card_data)
        # Ensure set exists
        if parsed.get("set_id"):
            set_data = card_data.get("set", {})
            if set_data:
                set_parsed = pokemon_api.parse_set_for_db(set_data)
                existing_set = db.query(Set).filter(Set.id == set_parsed["id"]).first()
                if not existing_set:
                    db.add(Set(**set_parsed))
        card = Card(**parsed)
        db.add(card)
        db.commit()
        db.refresh(card)
    return card


@router.get("/", response_model=List[CollectionItemResponse])
def get_collection(
    db: Session = Depends(get_db),
    sort_by: Optional[str] = "added_at",
    order: Optional[str] = "desc",
):
    """Get all collection items."""
    query = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    )

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
def add_to_collection(item: CollectionItemCreate, db: Session = Depends(get_db)):
    """Add a card to the collection. Cards with identical card_id+variant+lang+condition+purchase_price are grouped."""
    item_lang = item.lang or "en"

    # Resolve the correct language-variant card_id
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
            grade=item.grade if hasattr(item, 'grade') else 'raw',
            added_at=datetime.datetime.utcnow(),
        )
        db.add(db_item)
        db.commit()
        db.refresh(db_item)
        return db_item


@router.put("/{item_id}", response_model=CollectionItemResponse)
def update_collection_item(
    item_id: int,
    update: CollectionItemUpdate,
    db: Session = Depends(get_db),
):
    """Update a collection item."""
    item = db.query(CollectionItem).filter(CollectionItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    # Use exclude_unset so only fields explicitly sent in the request are updated.
    # This allows null values (e.g. clearing variant or purchase_price) to be saved.
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)

    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}")
def remove_from_collection(item_id: int, db: Session = Depends(get_db)):
    """Remove a card from collection."""
    item = db.query(CollectionItem).filter(CollectionItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    db.delete(item)
    db.commit()
    return {"message": "Removed from collection"}


@router.get("/stats/summary")
def get_collection_stats(db: Session = Depends(get_db)):
    """Get collection statistics."""
    items = db.query(CollectionItem).options(joinedload(CollectionItem.card)).all()

    total_cards = sum(item.quantity for item in items)
    unique_cards = len(set(item.card_id for item in items))
    total_value = sum(
        (item.card.price_market or 0) * item.quantity
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
