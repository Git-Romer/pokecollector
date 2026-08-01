"""Background queue that recognizes uploaded card photos.

Why a queue rather than recognizing inside the upload request: a large upload
needs several Gemini calls, and those calls have to be paced against a rate
limit (~6/min on the free tier). Doing that inline would hold an HTTP request
open for minutes and hit proxy timeouts, and would lose everything if the tab
closed. Instead the upload stores photos and returns a job id immediately; this
module drains the queue and the user reviews finished items whenever.

One drain loop runs at a time process-wide, so pacing is simply whatever the
shared limiter in services.gemini_rate_limit allows.
"""

from __future__ import annotations

import asyncio
import datetime
import logging

from sqlalchemy.orm import Session

from models import ScanJob, ScanJobItem

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
# Items whose Gemini call failed transiently go back to pending; this bounds how
# many times the drain loop will pick the same job up again before giving up.
_drain_lock = asyncio.Lock()
_draining = False


def enqueue_scan_job(db: Session, user_id: int, uploads: list[dict]) -> ScanJob:
    """Persist an upload batch as a pending job. `uploads` items are
    {filename, bytes, content_type, batch_mode}."""
    job = ScanJob(user_id=user_id, status="pending")
    db.add(job)
    db.flush()  # assign job.id

    for position, upload in enumerate(uploads):
        db.add(ScanJobItem(
            job_id=job.id,
            position=position,
            filename=upload.get("filename"),
            content_type=upload.get("content_type") or "image/jpeg",
            image_data=upload["bytes"],
            batch_mode=bool(upload.get("batch_mode", True)),
            status="pending",
        ))

    db.commit()
    db.refresh(job)
    return job


def job_progress(db: Session, job: ScanJob) -> dict:
    items = db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).all()
    done = sum(1 for i in items if i.status == "done")
    failed = sum(1 for i in items if i.status == "failed")
    return {
        "id": job.id,
        "status": job.status,
        "total": len(items),
        "done": done,
        "failed": failed,
        "pending": len(items) - done - failed,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "error_message": job.error_message,
    }


def resolve_item(db: Session, item: ScanJobItem) -> ScanJobItem:
    """Mark a reviewed item done and drop its stored photo.

    Clearing image_data here is what keeps scan_job_items from growing the way
    image_cache does — the bytes only live as long as the review needs them.
    """
    item.resolved = True
    item.image_data = None
    item.updated_at = datetime.datetime.utcnow()
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


async def _process_item_group(db: Session, api_key: str, gemini_url: str, items: list[ScanJobItem], *, batched: bool) -> None:
    """Recognize one group: either a composite chunk or a single photo."""
    from api.recognize import _recognize_composite_chunk, _recognize_single_image, _match_card_info
    import base64
    import httpx

    for item in items:
        item.attempts = (item.attempts or 0) + 1

    if batched:
        chunk = [
            {"filename": item.filename, "bytes": item.image_data, "mime_type": item.content_type}
            for item in items
        ]
        results = await _recognize_composite_chunk(db, api_key, gemini_url, chunk)
        for item, result in zip(items, results):
            _apply_result(item, result)
    else:
        item = items[0]
        image_b64 = base64.b64encode(item.image_data).decode()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                card_info = await _recognize_single_image(client, gemini_url, api_key, image_b64, item.content_type)
            result = await _match_card_info(db, api_key, gemini_url, card_info, image_b64, item.content_type)
            _apply_result(item, result)
        except Exception as exc:
            _apply_result(item, {"error": f"Erkennung fehlgeschlagen: {exc}"})


def _apply_result(item: ScanJobItem, result: dict) -> None:
    if result.get("error"):
        # Leave it pending for another pass while attempts remain — most failures
        # here are rate limiting or transient upstream errors, not bad photos.
        item.error = str(result["error"])
        item.status = "pending" if (item.attempts or 0) < MAX_ATTEMPTS else "failed"
    else:
        item.recognized = result.get("recognized")
        item.matches = result.get("matches")
        item.error = None
        item.status = "done"
    item.updated_at = datetime.datetime.utcnow()


async def _process_job(db: Session, job: ScanJob) -> None:
    from api.recognize import build_gemini_generate_url, get_gemini_key
    from services.card_composite import chunk_for_composite, GRID_SIZE

    api_key = get_gemini_key(db, user_id=job.user_id)
    if not api_key:
        job.status = "failed"
        job.error_message = "Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        job.finished_at = datetime.datetime.utcnow()
        db.commit()
        return

    gemini_url = build_gemini_generate_url()
    job.status = "running"
    if not job.started_at:
        job.started_at = datetime.datetime.utcnow()
    db.commit()

    pending = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.job_id == job.id, ScanJobItem.status == "pending")
        .order_by(ScanJobItem.position.asc())
        .all()
    )

    singles = [i for i in pending if not i.batch_mode]
    batchable = [i for i in pending if i.batch_mode]

    for item in singles:
        await _process_item_group(db, api_key, gemini_url, [item], batched=False)
        db.commit()

    for chunk in chunk_for_composite(batchable, size=GRID_SIZE):
        await _process_item_group(db, api_key, gemini_url, chunk, batched=True)
        db.commit()

    remaining = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.job_id == job.id, ScanJobItem.status == "pending")
        .count()
    )
    if remaining:
        # Items still retryable — leave the job pending so the next drain picks it up.
        job.status = "pending"
    else:
        job.status = "done"
        job.finished_at = datetime.datetime.utcnow()
    db.commit()


async def drain_scan_queue() -> None:
    """Process every pending job, one at a time, until none are left.

    Guarded so only one drain runs process-wide; a second caller returns
    immediately and lets the in-flight drain pick up its work.
    """
    global _draining
    async with _drain_lock:
        if _draining:
            return
        _draining = True

    from database import SessionLocal

    try:
        while True:
            db = SessionLocal()
            try:
                job = (
                    db.query(ScanJob)
                    .filter(ScanJob.status.in_(["pending", "running"]))
                    .order_by(ScanJob.created_at.asc())
                    .first()
                )
                if not job:
                    return
                before = _pending_count(db, job)
                await _process_job(db, job)
                after = _pending_count(db, job)
                if job.status == "pending" and after >= before:
                    # No forward progress (e.g. every item exhausted its attempts
                    # but was left pending) — fail the job instead of spinning.
                    logger.warning("Scan job %s made no progress, marking failed", job.id)
                    _fail_stalled_job(db, job)
            except Exception:
                logger.exception("Scan queue drain failed")
                return
            finally:
                db.close()
    finally:
        _draining = False


def _pending_count(db: Session, job: ScanJob) -> int:
    return (
        db.query(ScanJobItem)
        .filter(ScanJobItem.job_id == job.id, ScanJobItem.status == "pending")
        .count()
    )


def _fail_stalled_job(db: Session, job: ScanJob) -> None:
    db.query(ScanJobItem).filter(
        ScanJobItem.job_id == job.id, ScanJobItem.status == "pending"
    ).update({"status": "failed"}, synchronize_session=False)
    job.status = "failed"
    job.finished_at = datetime.datetime.utcnow()
    db.commit()


def purge_old_scan_jobs(db: Session, *, older_than_days: int = 7) -> int:
    """Delete finished jobs past the retention window.

    Without this, stored photos accumulate exactly like the known-unbounded
    image_cache table. Items normally shed their bytes on resolve; this catches
    jobs the user never came back to review.
    """
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=older_than_days)
    stale = (
        db.query(ScanJob)
        .filter(ScanJob.status.in_(["done", "failed"]), ScanJob.created_at < cutoff)
        .all()
    )
    for job in stale:
        db.delete(job)  # cascade removes items and their image bytes
    db.commit()
    return len(stale)
