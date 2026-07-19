from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from database import get_db
from services import public_profile as pp

router = APIRouter()


class PublicCard(BaseModel):
    id: str
    name: str
    image: Optional[str] = None
    set_name: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    quantity: int
    market_value: Optional[float] = None


class PublicBinderSummary(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    icon_pokemon_id: Optional[int] = None
    card_count: int
    unique_card_count: int
    total_value: Optional[float] = None


class PublicProfile(BaseModel):
    handle: str
    trainer_name: str
    avatar_id: Optional[int] = None
    show_values: bool
    binders: List[PublicBinderSummary]


class PublicBinderDetail(PublicBinderSummary):
    cards: List[PublicCard]


@router.get("/profiles/{handle}", response_model=PublicProfile)
def get_public_profile(handle: str, db: Session = Depends(get_db)):
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise HTTPException(status_code=404, detail="Profile not found")
    return pp.serialize_profile(db, user)


@router.get("/profiles/{handle}/binders/{binder_id}", response_model=PublicBinderDetail)
def get_public_binder(handle: str, binder_id: int, db: Session = Depends(get_db)):
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise HTTPException(status_code=404, detail="Profile not found")
    binder = next((b for b in pp.public_collection_binders(db, user) if b.id == binder_id), None)
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    return pp.serialize_binder_detail(db, binder, show_values=bool(user.public_show_values))
