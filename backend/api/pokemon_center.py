from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services.pokemon_center_queue import (
    check_pokemon_center_queue,
    get_or_create_browser_report_token,
    get_queue_status,
    record_queue_observation_with_token,
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


@router.get("/queue-browser-report-config")
def pokemon_center_queue_browser_report_config(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)
    token = get_or_create_browser_report_token(db)
    origin = str(request.base_url).rstrip("/")
    return {
        "token": token,
        "report_url": f"{origin}/api/pokemon-center/queue-browser-report",
    }


@router.get("/queue-browser-report")
def pokemon_center_queue_browser_report(
    token: str = Query(""),
    position: int | None = Query(None),
    source: str = Query("browser_report"),
    note: str | None = Query(None),
    db: Session = Depends(get_db),
):
    result = record_queue_observation_with_token(
        db,
        token=token,
        source=source[:80] if source else "browser_report",
        position=position,
        note=note,
    )
    if result is None:
        raise HTTPException(status_code=403, detail="Invalid queue report token")
    return result
