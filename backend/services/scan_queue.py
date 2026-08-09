"""Fair, restart-safe background processing for sanitized card scans."""

from __future__ import annotations

import asyncio
import datetime
import io
import logging
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, UploadFile
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session
from starlette.datastructures import Headers

from models import ScanJob, ScanJobItem, ScanQueueUserState, User
from services.gemini_rate_limit import gemini_priority_scope
from services.scan_storage import (
    ScanUploadError,
    delete_job_directory,
    delete_scan_image,
    resolve_scan_path,
)

logger = logging.getLogger(__name__)

MAX_RECOGNITION_ATTEMPTS = 3
LEASE_SECONDS = 10 * 60
TRANSIENT_BACKOFF_SECONDS = (30, 120, 600, 1800, 3600, 21600)
RECOGNITION_BACKOFF_SECONDS = (2, 10, 30)
TERMINAL_ITEM_STATUSES = {"done", "failed"}


@dataclass(frozen=True)
class ClaimedScanItem:
    item_id: int
    lease_token: str


class TransientScanError(RuntimeError):
    pass


class RecognitionScanError(RuntimeError):
    pass


class PermanentScanError(RuntimeError):
    pass


def _eligible_items(now: datetime.datetime):
    return and_(
        ScanJobItem.status.in_(["pending", "retrying"]),
        or_(ScanJobItem.next_attempt_at.is_(None), ScanJobItem.next_attempt_at <= now),
        ScanJob.expires_at > now,
    )


def recover_expired_leases(db: Session, *, now: datetime.datetime | None = None) -> int:
    """Return work abandoned by a crashed worker to the retry queue."""
    now = now or datetime.datetime.utcnow()
    items = (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.status == "processing",
            ScanJobItem.lease_expires_at.is_not(None),
            ScanJobItem.lease_expires_at <= now,
        )
        .all()
    )
    for item in items:
        item.status = "retrying"
        item.next_attempt_at = now
        item.lease_token = None
        item.lease_expires_at = None
        item.error = "Processing was interrupted and will resume automatically."
        item.updated_at = now
    if items:
        db.commit()
    return len(items)


def claim_next_scan_item(
    db: Session,
    *,
    now: datetime.datetime | None = None,
    lease_seconds: int = LEASE_SECONDS,
) -> ClaimedScanItem | None:
    """Atomically claim one due item using persistent per-user round robin."""
    now = now or datetime.datetime.utcnow()

    state = (
        db.query(ScanQueueUserState)
        .join(ScanJobItem, ScanJobItem.user_id == ScanQueueUserState.user_id)
        .join(ScanJob, ScanJob.id == ScanJobItem.job_id)
        .filter(_eligible_items(now))
        .order_by(
            ScanQueueUserState.last_dispatched_at.asc().nullsfirst(),
            ScanQueueUserState.user_id.asc(),
        )
        .with_for_update(skip_locked=True)
        .first()
    )
    if state is None:
        db.rollback()
        return None

    item = (
        db.query(ScanJobItem)
        .join(ScanJob, ScanJob.id == ScanJobItem.job_id)
        .filter(ScanJobItem.user_id == state.user_id, _eligible_items(now))
        .order_by(ScanJob.created_at.asc(), ScanJobItem.position.asc())
        .with_for_update(skip_locked=True)
        .first()
    )
    if item is None:
        db.rollback()
        return None

    lease_token = uuid.uuid4().hex
    item.status = "processing"
    item.lease_token = lease_token
    item.lease_expires_at = now + datetime.timedelta(seconds=lease_seconds)
    item.updated_at = now
    state.last_dispatched_at = now
    job = item.job
    job.status = "running"
    if not job.started_at:
        job.started_at = now
    job.updated_at = now
    db.commit()
    return ClaimedScanItem(item_id=item.id, lease_token=lease_token)


def _backoff(values: tuple[int, ...], failure_count: int) -> int:
    index = max(0, min(len(values) - 1, failure_count - 1))
    return values[index]


def _leased_item(db: Session, claim: ClaimedScanItem) -> ScanJobItem | None:
    return (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.id == claim.item_id,
            ScanJobItem.status == "processing",
            ScanJobItem.lease_token == claim.lease_token,
        )
        .with_for_update()
        .first()
    )


def _refresh_job_status(db: Session, job: ScanJob, now: datetime.datetime) -> None:
    statuses = [row[0] for row in db.query(ScanJobItem.status).filter(ScanJobItem.job_id == job.id).all()]
    if not statuses:
        job.status = "failed"
        job.error_message = "The scan job contains no photos."
        job.finished_at = now
    elif all(status in TERMINAL_ITEM_STATUSES for status in statuses):
        job.status = "done" if any(status == "done" for status in statuses) else "failed"
        job.finished_at = now
    elif any(status == "processing" for status in statuses):
        job.status = "running"
    else:
        job.status = "pending"
    job.updated_at = now


def complete_claim(db: Session, claim: ClaimedScanItem, result: dict) -> bool:
    now = datetime.datetime.utcnow()
    item = _leased_item(db, claim)
    if item is None:
        db.rollback()
        return False
    item.status = "done"
    item.recognized = result.get("recognized")
    item.matches = result.get("matches")
    item.error = None
    item.lease_token = None
    item.lease_expires_at = None
    item.next_attempt_at = None
    item.updated_at = now
    _refresh_job_status(db, item.job, now)
    db.commit()
    return True


def fail_claim(
    db: Session,
    claim: ClaimedScanItem,
    error: str,
    *,
    transient: bool = False,
    permanent: bool = False,
) -> bool:
    now = datetime.datetime.utcnow()
    item = _leased_item(db, claim)
    if item is None:
        db.rollback()
        return False

    item.error = str(error)
    item.lease_token = None
    item.lease_expires_at = None
    if permanent:
        item.status = "failed"
        item.next_attempt_at = None
    elif transient:
        item.transient_failures += 1
        item.status = "retrying"
        item.next_attempt_at = now + datetime.timedelta(
            seconds=_backoff(TRANSIENT_BACKOFF_SECONDS, item.transient_failures)
        )
    else:
        item.attempts += 1
        if item.attempts >= MAX_RECOGNITION_ATTEMPTS:
            item.status = "failed"
            item.next_attempt_at = None
        else:
            item.status = "retrying"
            item.next_attempt_at = now + datetime.timedelta(
                seconds=_backoff(RECOGNITION_BACKOFF_SECONDS, item.attempts)
            )
    item.updated_at = now
    _refresh_job_status(db, item.job, now)
    db.commit()
    return True


async def default_scan_processor(
    db: Session,
    user_id: int,
    image_bytes: bytes,
    content_type: str,
) -> dict:
    """Reuse the proven single-card scanner path with background priority."""
    from api.recognize import recognize_card

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise PermanentScanError("The scan owner is no longer an active user.")
    upload = UploadFile(
        file=io.BytesIO(image_bytes),
        filename="sanitized-scan.jpg",
        headers=Headers({"content-type": content_type}),
    )
    with gemini_priority_scope("background"):
        return await recognize_card(file=upload, db=db, current_user=user)


def _classify_http_error(error: HTTPException) -> type[RuntimeError]:
    if error.status_code in {429, 502, 503, 504}:
        return TransientScanError
    if error.status_code in {400, 401, 403}:
        return PermanentScanError
    return RecognitionScanError


async def process_claimed_scan_item(
    claim: ClaimedScanItem,
    *,
    processor=default_scan_processor,
) -> None:
    from database import SessionLocal

    db = SessionLocal()
    try:
        try:
            item = _leased_item(db, claim)
            if item is None:
                db.rollback()
                return
            path = resolve_scan_path(item.image_path)
            image_bytes = path.read_bytes()
            user_id = item.user_id
            content_type = item.content_type
            db.rollback()  # Release the row lock during upstream network work.
            result = await processor(db, user_id, image_bytes, content_type)
        except HTTPException as exc:
            db.rollback()
            error_type = _classify_http_error(exc)
            error = error_type(str(exc.detail))
        except (FileNotFoundError, OSError, ScanUploadError) as exc:
            db.rollback()
            error = PermanentScanError(f"Stored scan photo is unavailable: {exc}")
        except (TransientScanError, RecognitionScanError, PermanentScanError) as exc:
            db.rollback()
            error = exc
        except Exception as exc:
            db.rollback()
            logger.exception("Unexpected scan processing error for item %s", claim.item_id)
            error = TransientScanError(str(exc))
        else:
            complete_claim(db, claim, result)
            return

        fail_claim(
            db,
            claim,
            str(error),
            transient=isinstance(error, TransientScanError),
            permanent=isinstance(error, PermanentScanError),
        )
        item = db.get(ScanJobItem, claim.item_id)
        if item and item.status == "failed":
            relative_path = item.image_path
            item.image_path = None
            db.commit()
            delete_scan_image(relative_path)
    finally:
        db.close()


async def drain_scan_queue(*, max_items: int = 50, processor=default_scan_processor) -> int:
    """Process a bounded fair pass; concurrent workers safely skip claimed rows."""
    from database import SessionLocal

    processed = 0
    for _ in range(max_items):
        db = SessionLocal()
        try:
            recover_expired_leases(db)
            claim = claim_next_scan_item(db)
        finally:
            db.close()
        if claim is None:
            break
        await process_claimed_scan_item(claim, processor=processor)
        processed += 1
        await asyncio.sleep(0)
    return processed


def resolve_scan_item(db: Session, item: ScanJobItem) -> ScanJobItem:
    """Mark one review complete and immediately remove its stored photo."""
    relative_path = item.image_path
    item.resolved = True
    item.image_path = None
    item.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(item)
    delete_scan_image(relative_path)
    return item


def purge_expired_scan_jobs(db: Session, *, now: datetime.datetime | None = None) -> int:
    """Delete every job and review photo at its fixed 14-day expiry."""
    now = now or datetime.datetime.utcnow()
    jobs = db.query(ScanJob).filter(ScanJob.expires_at <= now).all()
    job_ids = [job.id for job in jobs]
    for job in jobs:
        db.delete(job)
    db.commit()
    for job_id in job_ids:
        delete_job_directory(job_id)
    return len(job_ids)


def job_progress(db: Session, job: ScanJob) -> dict:
    items = db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).all()
    counts = {status: sum(1 for item in items if item.status == status) for status in {
        "pending", "processing", "retrying", "done", "failed"
    }}
    return {
        "id": job.id,
        "status": job.status,
        "total": len(items),
        **counts,
        "unresolved": sum(1 for item in items if not item.resolved and item.status == "done"),
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
        "error_message": job.error_message,
    }
