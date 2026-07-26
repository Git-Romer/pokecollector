from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from schemas import ProfileUpdate
from services import public_profile as pp
from services.public_profile_feature import public_profiles_enabled

router = APIRouter()


def _is_public_handle_conflict(exc: IntegrityError) -> bool:
    original = getattr(exc, "orig", None)
    constraint = getattr(getattr(original, "diag", None), "constraint_name", None)
    if constraint in {"ix_users_public_handle", "users_public_handle_key"}:
        return True
    return "public_handle" in str(original).lower()


def _serialize_owner(user: User, feature_enabled: bool) -> dict:
    return {
        "public_handle": user.public_handle,
        "is_profile_public": bool(user.is_profile_public),
        "public_show_values": bool(user.public_show_values),
        "feature_enabled": feature_enabled,
    }


@router.get("/")
def get_profile(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _serialize_owner(current_user, public_profiles_enabled(db))


def _require_public_profiles_enabled(db: Session) -> None:
    if not public_profiles_enabled(db):
        raise HTTPException(status_code=403, detail="Public profiles are disabled by the administrator")


@router.get("/handle-available")
def handle_available(handle: str = Query(...), db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    _require_public_profiles_enabled(db)
    try:
        normalized = pp.validate_handle(handle)
    except pp.HandleError as exc:
        return {"available": False, "reason": str(exc)}
    available = pp.is_handle_available(db, normalized, exclude_user_id=current_user.id)
    return {"available": available, "reason": None if available else "Handle is taken"}


@router.put("/")
def update_profile(payload: ProfileUpdate, db: Session = Depends(get_db),
                   current_user: User = Depends(get_current_user)):
    _require_public_profiles_enabled(db)
    if "public_handle" in payload.model_fields_set:
        if payload.public_handle is None or not payload.public_handle.strip():
            current_user.public_handle = None
            current_user.is_profile_public = False
        else:
            try:
                normalized = pp.validate_handle(payload.public_handle)
            except pp.HandleError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None
            if not pp.is_handle_available(db, normalized, exclude_user_id=current_user.id):
                raise HTTPException(status_code=409, detail="Handle is taken")
            current_user.public_handle = normalized
    if payload.is_profile_public is not None:
        if payload.is_profile_public and not current_user.public_handle:
            raise HTTPException(status_code=422, detail="A public handle is required before publishing the profile")
        current_user.is_profile_public = payload.is_profile_public
    if payload.public_show_values is not None:
        current_user.public_show_values = payload.public_show_values
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if not _is_public_handle_conflict(exc):
            raise
        raise HTTPException(status_code=409, detail="Handle is taken") from None
    db.refresh(current_user)
    return _serialize_owner(current_user, public_profiles_enabled(db))
