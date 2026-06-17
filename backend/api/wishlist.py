from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from typing import List
from api.auth import get_current_user
from database import get_db
from models import WishlistItem, Card, Set, User
from schemas import WishlistItemCreate, WishlistItemUpdate, WishlistItemResponse
from api.collection import ensure_card_exists
from services.card_visibility import visible_card_filter
import datetime

router = APIRouter()

WISHLIST_MIN_QUANTITY = 1
WISHLIST_MAX_QUANTITY = 99


def _add_wishlist_quantity(current: int | None, increment: int) -> int:
    current_quantity = max(int(current or WISHLIST_MIN_QUANTITY), WISHLIST_MIN_QUANTITY)
    next_quantity = current_quantity + increment
    if next_quantity > WISHLIST_MAX_QUANTITY:
        raise HTTPException(status_code=400, detail="Wishlist quantity cannot exceed 99")
    return next_quantity


@router.get("/", response_model=List[WishlistItemResponse])
def get_wishlist(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all wishlist items."""
    items = db.query(WishlistItem).join(Card, Card.id == WishlistItem.card_id).options(
        joinedload(WishlistItem.card).joinedload(Card.set_ref)
    ).filter(
        WishlistItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(WishlistItem.created_at.desc()).all()
    return items


@router.post("/", response_model=WishlistItemResponse)
def add_to_wishlist(
    item: WishlistItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a card to the wishlist, incrementing quantity when it already exists."""
    ensure_card_exists(db, item.card_id)

    existing = db.query(WishlistItem).filter(
        WishlistItem.card_id == item.card_id,
        WishlistItem.user_id == current_user.id,
    ).first()

    if existing:
        existing.quantity = _add_wishlist_quantity(existing.quantity, item.quantity)
        if item.price_alert_above is not None:
            existing.price_alert_above = item.price_alert_above
        if item.price_alert_below is not None:
            existing.price_alert_below = item.price_alert_below
        db.commit()
        db.refresh(existing)
        return existing

    db_item = WishlistItem(
        card_id=item.card_id,
        quantity=item.quantity,
        price_alert_above=item.price_alert_above,
        price_alert_below=item.price_alert_below,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return db_item


@router.put("/{item_id}", response_model=WishlistItemResponse)
def update_wishlist_item(
    item_id: int,
    update: WishlistItemUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update quantity and price alerts for a wishlist item."""
    item = db.query(WishlistItem).filter(
        WishlistItem.id == item_id,
        WishlistItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Wishlist item not found")

    update_data = update.model_dump(exclude_unset=True)
    if "quantity" in update_data:
        item.quantity = update_data["quantity"]
    if "price_alert_above" in update_data:
        item.price_alert_above = update_data["price_alert_above"]
    if "price_alert_below" in update_data:
        item.price_alert_below = update_data["price_alert_below"]

    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}")
def remove_from_wishlist(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a card from the wishlist."""
    item = db.query(WishlistItem).filter(
        WishlistItem.id == item_id,
        WishlistItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Wishlist item not found")

    db.delete(item)
    db.commit()
    return {"message": "Removed from wishlist"}
