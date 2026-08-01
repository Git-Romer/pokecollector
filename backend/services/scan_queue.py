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
# How long to wait out an exhausted quota before retrying, and how many times,
# before leaving the job for the scheduled resume rather than holding the drain
# loop open indefinitely.
RATE_LIMIT_PAUSE_SECONDS = 45
MAX_RATE_LIMIT_PAUSES = 8

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
        # Anything still needing the user's attention: recognized but not yet
        # reviewed, or not recognized yet. Drives the nav badge, so it must not
        # count items the user already actioned.
        "unresolved": sum(1 for i in items if not i.resolved and i.status != "failed"),
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


async def _process_item_group(db: Session, api_key: str, gemini_url: str, items: list[ScanJobItem], *, batched: bool) -> bool:
    """Recognize one group: a composite chunk or a single photo.

    Returns True when the group failed transiently (rate limited), so the caller
    can stop the pass instead of burning the remaining groups against an
    exhausted quota.
    """
    from api.recognize import (
        _recognize_composite_chunk, _recognize_single_image, _match_card_info, get_gemini_model,
    )
    from services.scan_trace import ScanTrace
    import base64
    import httpx
    from fastapi import HTTPException

    model = get_gemini_model()
    traces = [
        ScanTrace(mode="batch" if batched else "single", job_id=item.job_id,
                  item_id=item.id, filename=item.filename, model=model)
        for item in items
    ]
    for tr, item in zip(traces, items):
        tr.set_image(item.image_data)

    for item in items:
        item.attempts = (item.attempts or 0) + 1

    transient = False
    if batched:
        chunk = [
            {"filename": item.filename, "bytes": item.image_data, "mime_type": item.content_type}
            for item in items
        ]
        results = await _recognize_composite_chunk(db, api_key, gemini_url, chunk, traces=traces)
        for item, result in zip(items, results):
            transient |= _apply_result(item, result)
    else:
        item = items[0]
        image_b64 = base64.b64encode(item.image_data).decode()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                card_info = await _recognize_single_image(
                    client, gemini_url, api_key, image_b64, item.content_type, trace=traces[0]
                )
            result = await _match_card_info(
                db, api_key, gemini_url, card_info, image_b64, item.content_type, trace=traces[0]
            )
            transient = _apply_result(item, result)
        except HTTPException as exc:
            traces[0].record_error(str(exc.detail))
            transient = _apply_result(item, {"error": str(exc.detail)})
        except Exception as exc:
            traces[0].record_error(str(exc))
            transient = _apply_result(item, {"error": f"Erkennung fehlgeschlagen: {exc}"})

    # Traces are written even for transient failures: a rate-limited attempt is
    # still evidence about pacing, and a later retry writes its own trace.
    for tr in traces:
        tr.save()
    return transient


# Errors that mean "come back later", not "this photo is bad". Being rate
# limited is the normal cost of a large batch, so it must never consume an
# item's retry budget — otherwise a busy quota permanently fails a job the
# queue exists specifically to carry through.
_TRANSIENT_MARKERS = ("rate limit", "429", "überlastet", "nicht erreicht", "temporarily")


def _is_transient(message: str) -> bool:
    lowered = str(message or "").casefold()
    return any(marker in lowered for marker in _TRANSIENT_MARKERS)


def _apply_result(item: ScanJobItem, result: dict) -> bool:
    """Record an outcome. Returns True when the failure was transient."""
    if result.get("error"):
        item.error = str(result["error"])
        if _is_transient(item.error):
            # Hand back the attempt — this was the quota's fault, not the card's.
            item.attempts = max(0, (item.attempts or 1) - 1)
            item.status = "pending"
            item.updated_at = datetime.datetime.utcnow()
            return True
        item.status = "pending" if (item.attempts or 0) < MAX_ATTEMPTS else "failed"
    else:
        item.recognized = result.get("recognized")
        item.matches = result.get("matches")
        item.error = None
        item.status = "done"
    item.updated_at = datetime.datetime.utcnow()
    return False


async def _process_job(db: Session, job: ScanJob) -> bool:
    from api.recognize import build_gemini_generate_url, get_gemini_key
    from services.card_composite import chunk_for_composite, GRID_SIZE

    api_key = get_gemini_key(db, user_id=job.user_id)
    if not api_key:
        job.status = "failed"
        job.error_message = "Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        job.finished_at = datetime.datetime.utcnow()
        db.commit()
        return False

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

    groups = [([item], False) for item in singles]
    groups += [(chunk, True) for chunk in chunk_for_composite(batchable, size=GRID_SIZE)]

    for group, batched in groups:
        transient = await _process_item_group(db, api_key, gemini_url, group, batched=batched)
        db.commit()
        if transient:
            # Stop the pass rather than marching through the rest — the quota is
            # exhausted, so every remaining group would fail too and the limiter
            # would make each one wait out its penalty first.
            logger.info("Scan job %s paused: upstream rate limited", job.id)
            job.status = "pending"
            db.commit()
            return True

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
    return False


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

    rate_limit_pauses = 0
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
                paused = await _process_job(db, job)
                after = _pending_count(db, job)

                if paused:
                    # Rate limited. Nothing is wrong with the job — wait for the
                    # quota to recover and try again. Bounded so a persistently
                    # exhausted quota hands off to the scheduled resume instead
                    # of spinning here forever.
                    rate_limit_pauses += 1
                    if rate_limit_pauses > MAX_RATE_LIMIT_PAUSES:
                        logger.info(
                            "Scan queue still rate limited after %s pauses; leaving job %s "
                            "pending for the scheduled resume",
                            rate_limit_pauses, job.id,
                        )
                        return
                    await asyncio.sleep(RATE_LIMIT_PAUSE_SECONDS)
                    continue

                if job.status == "pending" and after >= before:
                    # No forward progress and it was not a rate limit — the items
                    # are genuinely stuck, so fail rather than spin.
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
