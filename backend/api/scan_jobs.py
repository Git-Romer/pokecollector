"""Authenticated API for persistent background card-scan jobs."""

from __future__ import annotations

import json
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import ScanJob, ScanJobItem, User
from services.scan_queue import (
    drain_scan_queue,
    job_progress,
    resolve_scan_item,
    retry_scan_item,
)
from services.scan_storage import (
    ScanUploadError,
    create_scan_job,
    delete_job_directory,
    resolve_scan_path,
)

router = APIRouter()


def _get_own_job(db: Session, job_id: int, current_user: User) -> ScanJob:
    job = (
        db.query(ScanJob)
        .filter(ScanJob.id == job_id, ScanJob.user_id == current_user.id)
        .first()
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Scan job not found.")
    return job


def _get_own_item(
    db: Session,
    job_id: int,
    item_id: int,
    current_user: User,
) -> ScanJobItem:
    _get_own_job(db, job_id, current_user)
    item = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.id == item_id, ScanJobItem.job_id == job_id)
        .first()
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Scan item not found.")
    return item


def _item_payload(item: ScanJobItem) -> dict:
    return {
        "id": item.id,
        "position": item.position,
        "batch_mode": item.batch_mode,
        "status": item.status,
        "resolved": item.resolved,
        "attempts": item.attempts,
        "transient_failures": item.transient_failures,
        "recognized": item.recognized,
        "matches": item.matches,
        "error": item.error,
        "has_image": bool(item.image_path),
        "next_attempt_at": (
            item.next_attempt_at.isoformat() if item.next_attempt_at else None
        ),
        "retry_reason": item.retry_reason,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


@router.post("/recognize/jobs")
async def enqueue_scan_job(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    individual_positions: str | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Sanitize a batch, persist it, and return without waiting for Gemini."""
    from api.recognize import get_gemini_key

    if not get_gemini_key(db, user_id=current_user.id):
        raise HTTPException(
            status_code=400,
            detail="No Gemini API key configured. Add one in Settings first.",
        )
    try:
        requested_individual = json.loads(individual_positions or "[]")
        if (
            not isinstance(requested_individual, list)
            or any(type(position) is not int for position in requested_individual)
            or len(set(requested_individual)) != len(requested_individual)
            or any(position < 0 or position >= len(files) for position in requested_individual)
        ):
            raise ValueError
    except (TypeError, ValueError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Invalid individual scan selection.")

    individual_set = set(requested_individual)
    batch_modes = [
        len(files) > 1 and position not in individual_set
        for position in range(len(files))
    ]
    try:
        job = await create_scan_job(
            db,
            current_user.id,
            files,
            batch_modes=batch_modes,
        )
    except ScanUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    background_tasks.add_task(drain_scan_queue, max_items=len(files))
    return job_progress(db, job)


@router.get("/recognize/jobs")
def list_scan_jobs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return active or actionable jobs for the current user's scan inbox."""
    jobs = (
        db.query(ScanJob)
        .join(ScanJobItem, ScanJobItem.job_id == ScanJob.id)
        .filter(
            ScanJob.user_id == current_user.id,
            ScanJobItem.resolved.is_(False),
        )
        .distinct()
        .order_by(ScanJob.created_at.desc())
        .limit(50)
        .all()
    )
    return {"jobs": [job_progress(db, job) for job in jobs]}


@router.get("/recognize/jobs/{job_id}")
def get_scan_job(
    job_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = _get_own_job(db, job_id, current_user)
    items = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.job_id == job.id, ScanJobItem.resolved.is_(False))
        .order_by(ScanJobItem.position.asc())
        .all()
    )
    return {**job_progress(db, job), "items": [_item_payload(item) for item in items]}


@router.get("/recognize/jobs/{job_id}/items/{item_id}/image")
def get_scan_job_item_image(
    job_id: int,
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user)
    if not item.image_path:
        raise HTTPException(status_code=404, detail="Scan photo not found.")
    try:
        path = resolve_scan_path(item.image_path)
    except ScanUploadError:
        raise HTTPException(status_code=404, detail="Scan photo not found.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Scan photo not found.")
    return FileResponse(path, media_type="image/jpeg", filename="scan.jpg")


@router.post("/recognize/jobs/{job_id}/items/{item_id}/resolve")
def resolve_scan_job_item(
    job_id: int,
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user)
    if item.status not in {"done", "failed"}:
        raise HTTPException(status_code=409, detail="This scan is still being processed.")
    return _item_payload(resolve_scan_item(db, item))


@router.post("/recognize/jobs/{job_id}/items/{item_id}/retry")
async def retry_scan_job_item(
    job_id: int,
    item_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user)
    try:
        retry_scan_item(db, item)
    except (ValueError, ScanUploadError) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    background_tasks.add_task(drain_scan_queue, max_items=1)
    return _item_payload(item)


@router.delete("/recognize/jobs/{job_id}")
def delete_scan_job(
    job_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = _get_own_job(db, job_id, current_user)
    db.delete(job)
    db.commit()
    delete_job_directory(job_id)
    return {"deleted": job_id}
