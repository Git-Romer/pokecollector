import datetime
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, Query
from sqlalchemy.orm import Session
from api.auth import get_current_user
from database import get_db
from models import User, ScanHistory

logger = logging.getLogger(__name__)

router = APIRouter()

SCAN_HISTORY_RETENTION_DAYS = 14
RECOGNITION_DISABLED_DETAIL = (
    "Built-in AI recognition is disabled in this local-first release. "
    "Use HoloDex on your phone for scanning and add owned cards manually in John John's PC."
)


def purge_expired_scan_history(db: Session, user_id: int | None = None, now: datetime.datetime | None = None) -> int:
    now = now or datetime.datetime.utcnow()
    query = db.query(ScanHistory).filter(ScanHistory.expires_at < now)
    if user_id is not None:
        query = query.filter(ScanHistory.user_id == user_id)
    return query.delete(synchronize_session=False)


def record_scan_history(
    db: Session,
    *,
    user_id: int,
    source_reference: str | None,
    recognized: dict,
    matches: list[dict],
    now: datetime.datetime | None = None,
) -> ScanHistory:
    now = now or datetime.datetime.utcnow()
    purge_expired_scan_history(db, user_id=user_id, now=now)
    top_match = matches[0] if matches else {}
    entry = ScanHistory(
        user_id=user_id,
        source='external_scanner',
        source_reference=source_reference,
        recognized_name=(recognized.get('name') or recognized.get('name_en') or None),
        recognized_number=recognized.get('number'),
        recognized_language=recognized.get('language'),
        match_count=len(matches),
        top_match_card_id=top_match.get('id'),
        top_match_name=top_match.get('name'),
        created_at=now,
        expires_at=now + datetime.timedelta(days=SCAN_HISTORY_RETENTION_DAYS),
    )
    db.add(entry)
    db.flush()
    return entry


def serialize_scan_history(entry: ScanHistory) -> dict:
    return {
        'id': entry.id,
        'source': entry.source,
        'source_reference': entry.source_reference,
        'recognized_name': entry.recognized_name,
        'recognized_number': entry.recognized_number,
        'recognized_language': entry.recognized_language,
        'match_count': entry.match_count,
        'top_match_card_id': entry.top_match_card_id,
        'top_match_name': entry.top_match_name,
        'created_at': entry.created_at.isoformat() if entry.created_at else None,
        'expires_at': entry.expires_at.isoformat() if entry.expires_at else None,
        'retention_days': SCAN_HISTORY_RETENTION_DAYS,
    }


@router.post("/recognize")
async def recognize_card(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Local-first release boundary.

    John John's PC retains local scan-history support but does not send card
    photos to any external AI recognizer in this release.
    HoloDex remains the user's scanning and AI grading tool; John John's PC is
    the local source of truth where owned cards are added intentionally.
    """
    await file.close()
    raise HTTPException(status_code=501, detail=RECOGNITION_DISABLED_DETAIL)


@router.get("/scan-history")
def get_scan_history(
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    purge_expired_scan_history(db, user_id=current_user.id)
    db.commit()
    entries = (
        db.query(ScanHistory)
        .filter(ScanHistory.user_id == current_user.id)
        .order_by(ScanHistory.created_at.desc(), ScanHistory.id.desc())
        .limit(limit)
        .all()
    )
    return {
        "retention_days": SCAN_HISTORY_RETENTION_DAYS,
        "items": [serialize_scan_history(entry) for entry in entries],
    }
