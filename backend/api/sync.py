from fastapi import APIRouter, Depends, BackgroundTasks
from sqlalchemy.orm import Session
from database import get_db
from models import SyncLog
from services.sync_service import perform_sync
import datetime

router = APIRouter()

_sync_running = False


def _ensure_utc_z(dt) -> str:
    """Convert a datetime to ISO string with Z suffix (UTC marker)."""
    if dt is None:
        return None
    # If naive (no tzinfo), treat as UTC
    if dt.tzinfo is None:
        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    # If aware, convert to UTC
    utc_dt = dt.astimezone(datetime.timezone.utc)
    return utc_dt.strftime('%Y-%m-%dT%H:%M:%SZ')


@router.post("/")
def trigger_sync(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Manually trigger a sync."""
    global _sync_running
    if _sync_running:
        return {"message": "Sync already running", "status": "running"}

    def run_sync():
        global _sync_running
        _sync_running = True
        from database import SessionLocal
        sync_db = SessionLocal()
        try:
            perform_sync(sync_db)
        except Exception as e:
            pass
        finally:
            _sync_running = False
            sync_db.close()

    background_tasks.add_task(run_sync)
    return {"message": "Sync started", "status": "started"}


@router.get("/status")
def get_sync_status(db: Session = Depends(get_db)):
    """Get sync status and history."""
    global _sync_running

    last_sync = db.query(SyncLog).order_by(SyncLog.started_at.desc()).first()
    recent_syncs = db.query(SyncLog).order_by(SyncLog.started_at.desc()).limit(10).all()

    history = [
        {
            "id": s.id,
            "started_at": _ensure_utc_z(s.started_at),
            "finished_at": _ensure_utc_z(s.finished_at),
            "cards_updated": s.cards_updated,
            "sets_updated": s.sets_updated,
            "status": s.status,
            "error_message": s.error_message,
        }
        for s in recent_syncs
    ]

    return {
        "is_running": _sync_running,
        "last_sync": {
            "status": last_sync.status if last_sync else None,
            "started_at": _ensure_utc_z(last_sync.started_at) if last_sync else None,
            "finished_at": _ensure_utc_z(last_sync.finished_at) if last_sync else None,
            "cards_updated": last_sync.cards_updated if last_sync else 0,
        } if last_sync else None,
        "history": history,
    }
