from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from schemas import ProfileUpdate
from services import public_profile as pp

router = APIRouter()


def _serialize_owner(user: User) -> dict:
    return {
        "public_handle": user.public_handle,
        "is_profile_public": bool(user.is_profile_public),
        "public_show_values": bool(user.public_show_values),
    }


@router.get("/handle-available")
def handle_available(handle: str = Query(...), db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    try:
        normalized = pp.validate_handle(handle)
    except pp.HandleError as exc:
        return {"available": False, "reason": str(exc)}
    available = pp.is_handle_available(db, normalized, exclude_user_id=current_user.id)
    return {"available": available, "reason": None if available else "Handle is taken"}


@router.put("/")
def update_profile(payload: ProfileUpdate, db: Session = Depends(get_db),
                   current_user: User = Depends(get_current_user)):
    if payload.public_handle is not None:
        try:
            normalized = pp.validate_handle(payload.public_handle)
        except pp.HandleError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        if not pp.is_handle_available(db, normalized, exclude_user_id=current_user.id):
            raise HTTPException(status_code=409, detail="Handle is taken")
        current_user.public_handle = normalized
    if payload.is_profile_public is not None:
        current_user.is_profile_public = payload.is_profile_public
    if payload.public_show_values is not None:
        current_user.public_show_values = payload.public_show_values
    db.commit()
    db.refresh(current_user)
    return _serialize_owner(current_user)
