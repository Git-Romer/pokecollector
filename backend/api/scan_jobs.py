"""Authenticated API for persistent background card-scan jobs."""

from __future__ import annotations

import datetime
import json
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import ScanJob, ScanJobItem, User
from schemas import CollectionItemCreate, CollectionItemResponse
from services.scan_candidate_images import fetch_and_cache_candidate_image
from services.scan_queue import (
    drain_scan_queue,
    job_progress,
    resolve_scan_item,
    retry_scan_item,
)
from services.scan_storage import (
    ScanUploadError,
    create_scan_job,
    delete_scan_image,
    delete_job_directory,
    resolve_scan_path,
)

router = APIRouter()


class ResolveScanItemRequest(BaseModel):
    card_id: str | None = None


class ResolveAndAddScanItemRequest(CollectionItemCreate):
    confirmed_card_id: str


class ResolveAndAddScanItemResponse(BaseModel):
    item: dict
    collection_item: CollectionItemResponse


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
    *,
    for_update: bool = False,
) -> ScanJobItem:
    _get_own_job(db, job_id, current_user)
    query = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.id == item_id, ScanJobItem.job_id == job_id)
    )
    if for_update:
        # A caller may have loaded this row for an authorization/integrity
        # precheck before waiting on the lock. Force the database's current
        # values back into SQLAlchemy's identity-map instance after the wait.
        query = query.with_for_update().populate_existing()
    item = query.first()
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
    """Sanitize a batch, persist it, and return without waiting for its provider."""
    from services.scan_providers import (
        SCANNER_CAPABILITY_DEGRADED,
        get_provider,
        require_scanner_capability_mode,
    )

    provider = get_provider(db, current_user.id)
    capability_mode = require_scanner_capability_mode(
        db, current_user.id, provider.name, provider.model()
    )
    if provider.requires_credential() and not provider.credential(db, current_user.id):
        raise HTTPException(
            status_code=400,
            detail=provider.missing_credential_message(),
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

    # A composite asks the model to read several cards out of one image, which
    # needs the same multi-image capability visual verification does. A model
    # that already failed that probe (or was saved in acknowledged limited
    # mode) cannot do this reliably either, so every photo goes through
    # individually regardless of what the client requested — the client's own
    # UI hides the toggle for the same reason, but the server does not trust
    # that alone.
    individual_set = set(requested_individual)
    batch_modes = [
        len(files) > 1
        and position not in individual_set
        and capability_mode != SCANNER_CAPABILITY_DEGRADED
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
    """Poll progress and read every item for review, resolved ones included.

    Resolved items are kept (not filtered out) so the review page can render
    them as a collapsed, already-handled row instead of them simply vanishing
    once the list refetches — the point of collapsing rather than removing is
    that a reviewer working through a long batch can still see what they just
    confirmed. `GET /recognize/jobs` is the separate "still needs attention"
    inbox listing and keeps filtering resolved items out of *that* count.
    """
    job = _get_own_job(db, job_id, current_user)
    items = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.job_id == job.id)
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


@router.get("/recognize/jobs/{job_id}/items/{item_id}/candidates/{index}/image")
async def get_scan_candidate_image(
    job_id: int,
    item_id: int,
    index: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """A candidate's full-resolution scan, served from our own cache.

    Reviewing means comparing the photo against a candidate at full size, and
    proxying straight to the TCGdex asset CDN on every expand is slow enough
    to read as broken. `services.scan_candidate_images` pre-warms the top
    candidates during recognition, so this is usually a local cache read; a
    miss falls back to fetching (and caching) here.

    The URL is looked up from the item's own stored `matches`, never accepted
    from the caller — taking a client-supplied URL here would make this an
    open image-fetch proxy.
    """
    item = _get_own_item(db, job_id, item_id, current_user)
    matches = item.matches or []
    if not 0 <= index < len(matches):
        raise HTTPException(status_code=404, detail="Candidate image not found.")

    match = matches[index] if isinstance(matches[index], dict) else {}
    url = match.get("image_hd") or match.get("image")
    if not url:
        raise HTTPException(status_code=404, detail="Candidate image not found.")

    result = await fetch_and_cache_candidate_image(db, url)
    if result is None:
        raise HTTPException(status_code=502, detail="Could not load the candidate image.")
    data, content_type = result
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post("/recognize/jobs/{job_id}/items/{item_id}/resolve")
def resolve_scan_job_item(
    job_id: int,
    item_id: int,
    data: ResolveScanItemRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user, for_update=True)
    if item.resolved:
        raise HTTPException(status_code=409, detail="This scan has already been handled.")
    if item.status not in {"done", "failed"}:
        raise HTTPException(status_code=409, detail="This scan is still being processed.")
    card_id = str((data.card_id if data else "") or "").strip() or None
    if card_id:
        allowed_ids = {
            str(match.get("tcg_card_id") or "")
            for match in (item.matches or [])
            if isinstance(match, dict)
        }
        if card_id not in allowed_ids:
            raise HTTPException(status_code=422, detail="Confirmed card is not a scan candidate.")
        from services.scan_trace import record_ground_truth

        record_ground_truth(current_user.id, job_id, item_id, card_id)
    return _item_payload(resolve_scan_item(db, item))


@router.post(
    "/recognize/jobs/{job_id}/items/{item_id}/resolve-and-add",
    response_model=ResolveAndAddScanItemResponse,
)
def resolve_and_add_scan_job_item(
    job_id: int,
    item_id: int,
    data: ResolveAndAddScanItemRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Atomically add a reviewed card and mark its scan handled.

    Locking the scan row makes retries and concurrent tabs idempotent: only
    the first request can increment the collection quantity.
    """
    from api.collection import (
        _annotate_collection_item,
        _collection_item_language,
        _upsert_collection_item,
        ensure_card_exists,
    )
    from services import pokemon_api
    from services.scan_trace import record_ground_truth

    collection_data = CollectionItemCreate(**data.model_dump(exclude={"confirmed_card_id"}))
    confirmed_card_id = str(data.confirmed_card_id or "").strip()
    submitted_tcg_card_id, _ = pokemon_api.strip_lang_suffix(collection_data.card_id)

    def validate_review(row: ScanJobItem) -> None:
        if row.resolved:
            raise HTTPException(status_code=409, detail="This scan has already been handled.")
        if row.status != "done":
            raise HTTPException(status_code=409, detail="This scan is not ready to add.")
        allowed_ids = {
            str(match.get("tcg_card_id") or "")
            for match in (row.matches or [])
            if isinstance(match, dict)
        }
        if not confirmed_card_id or confirmed_card_id not in allowed_ids:
            raise HTTPException(status_code=422, detail="Confirmed card is not a scan candidate.")
        if submitted_tcg_card_id != confirmed_card_id:
            raise HTTPException(status_code=422, detail="Collection card does not match the confirmed candidate.")

    # Check authorization and request integrity before a missing catalogue
    # card is fetched or written.
    validate_review(_get_own_item(db, job_id, item_id, current_user))
    # A candidate normally already exists locally. If it does not, perform
    # the potentially committing catalogue import before taking the scan-row
    # lock; no commit may occur between that lock and the atomic final commit.
    if not collection_data.card_id.startswith("custom-"):
        item_lang = _collection_item_language(collection_data.card_id, collection_data.lang)
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(collection_data.card_id)
        ensure_card_exists(db, f"{tcg_card_id}_{item_lang}", lang=item_lang)

    item = _get_own_item(db, job_id, item_id, current_user, for_update=True)
    # Revalidate under the row lock: another tab may have resolved it between
    # the harmless precheck and this transaction.
    validate_review(item)

    _status, collection_item = _upsert_collection_item(
        db,
        current_user,
        collection_data,
        ensure_catalogue_card=False,
    )
    relative_path = item.image_path
    item.resolved = True
    item.image_path = None
    item.updated_at = datetime.datetime.utcnow()
    record_ground_truth(current_user.id, job_id, item_id, confirmed_card_id)
    db.commit()
    db.refresh(item)
    db.refresh(collection_item)
    delete_scan_image(relative_path)
    return {
        "item": _item_payload(item),
        "collection_item": _annotate_collection_item(db, current_user, collection_item),
    }


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
