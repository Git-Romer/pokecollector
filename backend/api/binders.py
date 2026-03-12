from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from typing import List
from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, CollectionItem, User
from schemas import BinderCreate, BinderUpdate, BinderResponse
from api.collection import ensure_card_exists
import datetime

router = APIRouter()


@router.get("/", response_model=List[BinderResponse])
def get_binders(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all binders."""
    binders = db.query(Binder).filter(
        Binder.user_id == current_user.id
    ).order_by(Binder.created_at.desc()).all()
    result = []
    for binder in binders:
        count = db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count()
        result.append(BinderResponse(
            id=binder.id,
            name=binder.name,
            description=binder.description,
            color=binder.color,
            binder_type=binder.binder_type or "collection",
            created_at=binder.created_at,
            card_count=count,
        ))
    return result


@router.post("/", response_model=BinderResponse)
def create_binder(
    binder: BinderCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new binder."""
    db_binder = Binder(
        name=binder.name,
        description=binder.description,
        color=binder.color,
        binder_type=binder.binder_type,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_binder)
    db.commit()
    db.refresh(db_binder)
    return BinderResponse(
        id=db_binder.id,
        name=db_binder.name,
        description=db_binder.description,
        color=db_binder.color,
        binder_type=db_binder.binder_type or "collection",
        created_at=db_binder.created_at,
        card_count=0,
    )


@router.put("/{binder_id}", response_model=BinderResponse)
def update_binder(
    binder_id: int,
    update: BinderUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    if update.name is not None:
        binder.name = update.name
    if update.description is not None:
        binder.description = update.description
    if update.color is not None:
        binder.color = update.color
    if update.binder_type is not None:
        binder.binder_type = update.binder_type

    db.commit()
    db.refresh(binder)
    count = db.query(BinderCard).filter(BinderCard.binder_id == binder_id).count()
    return BinderResponse(
        id=binder.id,
        name=binder.name,
        description=binder.description,
        color=binder.color,
        binder_type=binder.binder_type or "collection",
        created_at=binder.created_at,
        card_count=count,
    )


@router.delete("/{binder_id}")
def delete_binder(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    db.delete(binder)
    db.commit()
    return {"message": "Binder deleted"}


@router.get("/{binder_id}/cards")
def get_binder_cards(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all cards in a binder.
    
    - collection binder: only returns cards that are in the collection
    - wishlist binder: returns all cards with an `owned` flag
    """
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    binder_type = binder.binder_type or "collection"

    binder_cards = db.query(BinderCard).options(
        joinedload(BinderCard.card).joinedload(Card.set_ref)
    ).filter(BinderCard.binder_id == binder_id).all()

    cards = []
    owned_count = 0

    for bc in binder_cards:
        if not bc.card:
            continue

        # Check if in collection
        col_item = db.query(CollectionItem).filter(
            CollectionItem.card_id == bc.card_id,
            CollectionItem.user_id == current_user.id,
        ).first()
        in_collection = col_item is not None

        # For collection binder, skip cards not in collection
        if binder_type == "collection" and not in_collection:
            continue

        if in_collection:
            owned_count += 1

        card_dict = {
            "id": bc.card.id,
            "name": bc.card.name,
            "set_id": bc.card.set_id,
            "number": bc.card.number,
            "rarity": bc.card.rarity,
            "images_small": bc.card.images_small,
            "images_large": bc.card.images_large,
            "price_market": bc.card.price_market,
            "in_collection": in_collection,
            "owned": in_collection,
            "quantity": col_item.quantity if col_item else 0,
            "binder_card_id": bc.id,
        }
        if bc.card.set_ref:
            card_dict["set_name"] = bc.card.set_ref.name
        cards.append(card_dict)

    total_cards = len(binder_cards)

    return {
        "binder": {
            "id": binder.id,
            "name": binder.name,
            "description": binder.description,
            "color": binder.color,
            "binder_type": binder_type,
        },
        "cards": cards,
        "owned_count": owned_count,
        "total_count": total_cards,
    }


@router.post("/{binder_id}/cards")
def add_card_to_binder(
    binder_id: int,
    card_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a card to a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    ensure_card_exists(db, card_id)

    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.card_id == card_id,
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="Card already in binder")

    bc = BinderCard(
        binder_id=binder_id,
        card_id=card_id,
        added_at=datetime.datetime.utcnow(),
    )
    db.add(bc)
    db.commit()
    return {"message": "Card added to binder"}


@router.delete("/{binder_id}/cards/{card_id}")
def remove_card_from_binder(
    binder_id: int,
    card_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a card from a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.card_id == card_id,
    ).first()

    if not bc:
        raise HTTPException(status_code=404, detail="Card not in binder")

    db.delete(bc)
    db.commit()
    return {"message": "Card removed from binder"}
