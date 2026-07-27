from fastapi import APIRouter, Depends, HTTPException
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


def _serialize_owner(db: Session, user: User, feature_enabled: bool) -> dict:
    handle = None
    handle_error = None
    try:
        handle = pp.public_handle_from_trainer_name(user.username)
        if not pp.is_handle_available(db, handle, exclude_user_id=user.id):
            handle_error = "Another public profile already uses this trainer name"
            handle = None
    except pp.HandleError as exc:
        handle_error = str(exc)
    return {
        "trainer_name": user.username,
        "public_handle": handle,
        "public_handle_error": handle_error,
        "is_profile_public": bool(user.is_profile_public),
        "public_show_values": bool(user.public_show_values),
        "feature_enabled": feature_enabled,
    }


@router.get("/")
def get_profile(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _serialize_owner(db, current_user, public_profiles_enabled(db))


def _require_public_profiles_enabled(db: Session) -> None:
    if not public_profiles_enabled(db):
        raise HTTPException(status_code=403, detail="Public profiles are disabled by the administrator")


@router.put("/")
def update_profile(payload: ProfileUpdate, db: Session = Depends(get_db),
                   current_user: User = Depends(get_current_user)):
    _require_public_profiles_enabled(db)
    if payload.is_profile_public is not None:
        current_user.is_profile_public = payload.is_profile_public
    if current_user.is_profile_public:
        try:
            pp.assign_public_handle(db, current_user)
        except pp.HandleConflictError as exc:
            db.rollback()
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except pp.HandleError as exc:
            db.rollback()
            raise HTTPException(status_code=422, detail=str(exc)) from None
    else:
        current_user.public_handle = None
    if payload.public_show_values is not None:
        current_user.public_show_values = payload.public_show_values
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if not _is_public_handle_conflict(exc):
            raise
        raise HTTPException(status_code=409, detail="Another public profile already uses this trainer name") from None
    db.refresh(current_user)
    return _serialize_owner(db, current_user, public_profiles_enabled(db))
