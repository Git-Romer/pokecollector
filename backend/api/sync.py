from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from api.auth import get_current_user
from sqlalchemy.orm import Session
from database import get_db
from models import SyncLog, User
from services.sync_service import perform_sync, perform_price_sync
import datetime

router = APIRouter()

_sync_running = False
_price_sync_running = False


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
def trigger_sync(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Manually trigger a full sync. Admin only."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
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


@router.post("/prices")
def trigger_price_sync(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    """Trigger a price-only sync."""
    global _price_sync_running
    if _price_sync_running:
        return {"message": "Price sync already running", "status": "running"}

    def run_price_sync():
        global _price_sync_running
        _price_sync_running = True
        from database import SessionLocal
        sync_db = SessionLocal()
        try:
            perform_price_sync(sync_db)
        except Exception as e:
            pass
        finally:
            _price_sync_running = False
            sync_db.close()

    background_tasks.add_task(run_price_sync)
    return {"message": "Price sync started", "status": "started"}


@router.post("/reschedule-full")
def reschedule_full_sync(
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reschedule the full sync job. Body: {"interval_days": 5}"""
    from models import Setting
    from services.scheduler import reschedule_full_sync as _reschedule_full

    interval_days = int(body.get("interval_days", 5))
    # Save setting
    row = db.query(Setting).filter(Setting.key == "full_sync_interval_days").first()
    if row:
        row.value = str(interval_days)
    else:
        db.add(Setting(key="full_sync_interval_days", value=str(interval_days)))
    db.commit()
    # Reschedule
    try:
        _reschedule_full(interval_days)
    except Exception as e:
        pass  # Scheduler may not be running in all contexts
    return {"message": f"Full sync rescheduled to every {interval_days} days"}


@router.post("/reschedule-prices")
def reschedule_price_sync(
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reschedule the price sync job. Body: {"interval_minutes": 30}"""
    from models import Setting
    from services.scheduler import reschedule_price_sync as _reschedule_price

    interval_minutes = int(body.get("interval_minutes", 30))
    # Save setting
    row = db.query(Setting).filter(Setting.key == "price_sync_interval_minutes").first()
    if row:
        row.value = str(interval_minutes)
    else:
        db.add(Setting(key="price_sync_interval_minutes", value=str(interval_minutes)))
    db.commit()
    # Reschedule
    try:
        _reschedule_price(interval_minutes)
    except Exception as e:
        pass  # Scheduler may not be running in all contexts
    return {"message": f"Price sync rescheduled to every {interval_minutes} minutes"}


@router.get("/status")
def get_sync_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get sync status and history."""
    global _sync_running, _price_sync_running

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
            "sync_type": s.sync_type,
        }
        for s in recent_syncs
    ]

    return {
        "is_running": _sync_running,
        "is_price_sync_running": _price_sync_running,
        "last_sync": {
            "status": last_sync.status if last_sync else None,
            "started_at": _ensure_utc_z(last_sync.started_at) if last_sync else None,
            "finished_at": _ensure_utc_z(last_sync.finished_at) if last_sync else None,
            "cards_updated": last_sync.cards_updated if last_sync else 0,
            "sync_type": last_sync.sync_type if last_sync else None,
        } if last_sync else None,
        "history": history,
    }
