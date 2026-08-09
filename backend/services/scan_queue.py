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
    item_ids: tuple[int, ...] = ()
    composite: bool = False

    @property
    def all_item_ids(self) -> tuple[int, ...]:
        return self.item_ids or (self.item_id,)


class TransientScanError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: float | None = None,
        retry_reason: str | None = None,
    ):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.retry_reason = retry_reason


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
        item.retry_reason = None
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
    """Atomically claim one individual photo or a two-to-four-photo group."""
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

    items = [item]
    if item.batch_mode:
        siblings = (
            db.query(ScanJobItem)
            .join(ScanJob, ScanJob.id == ScanJobItem.job_id)
            .filter(
                ScanJobItem.job_id == item.job_id,
                ScanJobItem.position > item.position,
                ScanJobItem.batch_mode.is_(True),
                _eligible_items(now),
            )
            .order_by(ScanJobItem.position.asc())
            .limit(3)
            .with_for_update(skip_locked=True)
            .all()
        )
        items.extend(siblings)

    lease_token = uuid.uuid4().hex
    lease_expires_at = now + datetime.timedelta(seconds=lease_seconds)
    for claimed_item in items:
        claimed_item.status = "processing"
        claimed_item.retry_reason = None
        claimed_item.lease_token = lease_token
        claimed_item.lease_expires_at = lease_expires_at
        claimed_item.updated_at = now
    state.last_dispatched_at = now
    job = item.job
    job.status = "running"
    if not job.started_at:
        job.started_at = now
    job.updated_at = now
    db.commit()
    return ClaimedScanItem(
        item_id=item.id,
        item_ids=tuple(claimed_item.id for claimed_item in items),
        lease_token=lease_token,
        composite=len(items) > 1,
    )


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


def _leased_items(db: Session, claim: ClaimedScanItem) -> list[ScanJobItem]:
    return (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.id.in_(claim.all_item_ids),
            ScanJobItem.status == "processing",
            ScanJobItem.lease_token == claim.lease_token,
        )
        .order_by(ScanJobItem.position.asc())
        .with_for_update()
        .all()
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
    item.retry_reason = None
    item.updated_at = now
    _refresh_job_status(db, item.job, now)
    db.commit()
    return True


def complete_claim_group(
    db: Session,
    claim: ClaimedScanItem,
    results: list[dict | None],
) -> bool:
    """Persist confident positions and queue unclear ones as individual scans."""
    now = datetime.datetime.utcnow()
    items = _leased_items(db, claim)
    if len(items) != len(claim.all_item_ids) or len(results) != len(items):
        db.rollback()
        return False
    for item, result in zip(items, results):
        if result is None:
            item.status = "pending"
            item.batch_mode = False
            item.recognized = None
            item.matches = None
            item.next_attempt_at = now
            item.retry_reason = None
        else:
            item.status = "done"
            item.recognized = result.get("recognized")
            item.matches = result.get("matches")
            item.next_attempt_at = None
            item.retry_reason = None
        item.error = None
        item.lease_token = None
        item.lease_expires_at = None
        item.updated_at = now
    _refresh_job_status(db, items[0].job, now)
    db.commit()
    return True


def fail_claim(
    db: Session,
    claim: ClaimedScanItem,
    error: str,
    *,
    transient: bool = False,
    permanent: bool = False,
    retry_after_seconds: float | None = None,
    retry_reason: str | None = None,
) -> bool:
    now = datetime.datetime.utcnow()
    items = _leased_items(db, claim)
    if len(items) != len(claim.all_item_ids):
        db.rollback()
        return False

    for item in items:
        item.error = str(error)
        item.lease_token = None
        item.lease_expires_at = None
        if permanent:
            item.status = "failed"
            item.next_attempt_at = None
            item.retry_reason = None
        elif transient:
            item.transient_failures += 1
            item.status = "retrying"
            delay = (
                max(0.0, float(retry_after_seconds))
                if retry_after_seconds is not None
                else _backoff(TRANSIENT_BACKOFF_SECONDS, item.transient_failures)
            )
            item.next_attempt_at = now + datetime.timedelta(
                seconds=delay
            )
            item.retry_reason = retry_reason
        else:
            item.attempts += 1
            item.retry_reason = None
            if item.attempts >= MAX_RECOGNITION_ATTEMPTS:
                item.status = "failed"
                item.next_attempt_at = None
            else:
                item.status = "retrying"
                item.next_attempt_at = now + datetime.timedelta(
                    seconds=_backoff(RECOGNITION_BACKOFF_SECONDS, item.attempts)
                )
        item.updated_at = now
    _refresh_job_status(db, items[0].job, now)
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


async def default_composite_processor(
    db: Session,
    user_id: int,
    images: list[bytes],
    content_types: list[str],
) -> list[dict | None]:
    """Recognize a small grid and flag unclear positions for individual work."""
    from api.recognize import (
        CompositeRecognitionError,
        get_gemini_key,
        match_composite_card_info,
        recognize_composite_card_info,
    )
    from services.card_composite import build_composite

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise PermanentScanError("The scan owner is no longer an active user.")
    api_key = get_gemini_key(db, user_id=user_id)
    if not api_key:
        raise PermanentScanError("No Gemini API key is configured for the scan owner.")

    with gemini_priority_scope("background"):
        try:
            recognized_by_position = await recognize_composite_card_info(
                api_key,
                build_composite(images),
                len(images),
            )
        except CompositeRecognitionError:
            recognized_by_position = {}

        results: list[dict | None] = []
        for position in range(len(images)):
            card_info = recognized_by_position.get(position)
            has_name = bool(str((card_info or {}).get("name") or "").strip())
            if not has_name:
                results.append(None)
                continue
            result = await match_composite_card_info(db, card_info)
            results.append(
                result
                if bool(result.get("_identity_confident"))
                else None
            )
        return results


def _scan_error_from_http(error: HTTPException) -> RuntimeError:
    if error.status_code in {429, 502, 503, 504}:
        return TransientScanError(
            str(error.detail),
            retry_after_seconds=getattr(error, "retry_after_seconds", None),
            retry_reason=getattr(error, "retry_reason", None),
        )
    if error.status_code in {400, 401, 403}:
        return PermanentScanError(str(error.detail))
    return RecognitionScanError(str(error.detail))


async def process_claimed_scan_item(
    claim: ClaimedScanItem,
    *,
    processor=default_scan_processor,
    composite_processor=default_composite_processor,
) -> None:
    from database import SessionLocal

    db = SessionLocal()
    try:
        try:
            items = _leased_items(db, claim)
            if len(items) != len(claim.all_item_ids):
                db.rollback()
                return
            image_bytes = [resolve_scan_path(item.image_path).read_bytes() for item in items]
            user_id = items[0].user_id
            content_types = [item.content_type for item in items]
            db.rollback()  # Release the row lock during upstream network work.
            if claim.composite:
                results = await composite_processor(db, user_id, image_bytes, content_types)
            else:
                results = [await processor(db, user_id, image_bytes[0], content_types[0])]
        except HTTPException as exc:
            db.rollback()
            error = _scan_error_from_http(exc)
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
            if claim.composite:
                complete_claim_group(db, claim, results)
            else:
                complete_claim(db, claim, results[0])
            return

        fail_claim(
            db,
            claim,
            str(error),
            transient=isinstance(error, TransientScanError),
            permanent=isinstance(error, PermanentScanError),
            retry_after_seconds=getattr(error, "retry_after_seconds", None),
            retry_reason=getattr(error, "retry_reason", None),
        )
    finally:
        db.close()


async def drain_scan_queue(
    *,
    max_items: int = 50,
    processor=default_scan_processor,
    composite_processor=default_composite_processor,
) -> int:
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
        await process_claimed_scan_item(
            claim,
            processor=processor,
            composite_processor=composite_processor,
        )
        processed += len(claim.all_item_ids)
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


def retry_scan_item(db: Session, item: ScanJobItem) -> ScanJobItem:
    """Start a fresh individual recognition cycle for a reviewable item."""
    if item.resolved:
        raise ValueError("This scan has already been handled.")
    if item.status not in {"done", "failed"}:
        raise ValueError("This scan is still being processed.")
    if not item.image_path or not resolve_scan_path(item.image_path).is_file():
        raise ValueError("The stored scan photo is no longer available.")

    now = datetime.datetime.utcnow()
    item.status = "pending"
    item.attempts = 0
    item.transient_failures = 0
    item.next_attempt_at = now
    item.retry_reason = None
    item.lease_token = None
    item.lease_expires_at = None
    item.recognized = None
    item.matches = None
    item.error = None
    item.batch_mode = False
    item.updated_at = now
    item.job.status = "pending"
    item.job.finished_at = None
    item.job.error_message = None
    item.job.updated_at = now
    db.commit()
    db.refresh(item)
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
    active = counts["pending"] + counts["processing"] + counts["retrying"]
    failed_attention = sum(
        1
        for item in items
        if not item.resolved and item.status == "failed"
    )
    attention = sum(
        1
        for item in items
        if not item.resolved and item.status in {"done", "failed"}
    )
    next_retry_item = min(
        (
            item
            for item in items
            if item.status == "retrying" and item.next_attempt_at is not None
        ),
        key=lambda item: item.next_attempt_at,
        default=None,
    )
    return {
        "id": job.id,
        "status": job.status,
        "total": len(items),
        **counts,
        "processed": counts["done"] + counts["failed"],
        "active": active,
        "attention": attention,
        "failed_attention": failed_attention,
        "next_retry_at": (
            next_retry_item.next_attempt_at.isoformat() if next_retry_item else None
        ),
        "retry_reason": next_retry_item.retry_reason if next_retry_item else None,
        # Kept as a stable alias for badge clients built against Lamiskin's
        # original queue payload.
        "unresolved": attention,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
        "error_message": job.error_message,
    }
