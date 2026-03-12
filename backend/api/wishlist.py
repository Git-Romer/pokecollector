from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from typing import List
from api.auth import get_current_user
from database import get_db
from models import WishlistItem, Card, Set, User
from schemas import WishlistItemCreate, WishlistItemUpdate, WishlistItemResponse
from api.collection import ensure_card_exists
import datetime

router = APIRouter()


@router.get("/", response_model=List[WishlistItemResponse])
def get_wishlist(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all wishlist items."""
    items = db.query(WishlistItem).options(
        joinedload(WishlistItem.card).joinedload(Card.set_ref)
    ).filter(
        WishlistItem.user_id == current_user.id
    ).order_by(WishlistItem.created_at.desc()).all()
    return items


@router.post("/", response_model=WishlistItemResponse)
def add_to_wishlist(
    item: WishlistItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a card to the wishlist."""
    ensure_card_exists(db, item.card_id)

    existing = db.query(WishlistItem).filter(
        WishlistItem.card_id == item.card_id,
        WishlistItem.user_id == current_user.id,
    ).first()

    if existing:
        if item.price_alert_above is not None:
            existing.price_alert_above = item.price_alert_above
        if item.price_alert_below is not None:
            existing.price_alert_below = item.price_alert_below
        db.commit()
        db.refresh(existing)
        return existing

    db_item = WishlistItem(
        card_id=item.card_id,
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
    """Update price alerts for a wishlist item."""
    item = db.query(WishlistItem).filter(
        WishlistItem.id == item_id,
        WishlistItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Wishlist item not found")

    if update.price_alert_above is not None:
        item.price_alert_above = update.price_alert_above
    if update.price_alert_below is not None:
        item.price_alert_below = update.price_alert_below

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
