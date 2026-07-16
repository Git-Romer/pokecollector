from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services.pokemon_center_queue import (
    check_pokemon_center_queue,
    get_queue_status,
)

router = APIRouter()


def _require_admin(current_user: User) -> None:
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


@router.get("/queue-status")
def pokemon_center_queue_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)
    return get_queue_status(db)


@router.post("/queue-check")
def pokemon_center_queue_check(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)
    return check_pokemon_center_queue(db, force=True)
