import datetime
from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import InventoryEvent, StorageLocation, User
from schemas import (
    InventoryEventResponse,
    StorageLocationCreate,
    StorageLocationResponse,
    StorageLocationUpdate,
)
from services.inventory import (
    changed_values,
    get_or_create_default_storage_location,
    record_inventory_event,
)
from services.inventory_workbook import MAX_WORKBOOK_BYTES, review_inventory_workbook


router = APIRouter()


@router.post("/import-xlsx")
async def import_inventory_workbook(
    file: UploadFile = File(...),
    commit: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Review or commit the portable five-sheet collection workbook."""
    filename = (file.filename or "").lower()
    if not filename.endswith(".xlsx"):
        raise HTTPException(status_code=422, detail="Choose an .xlsx collection workbook")
    payload = await file.read(MAX_WORKBOOK_BYTES + 1)
    return review_inventory_workbook(
        db,
        current_user.id,
        payload,
        commit=commit,
    )


@router.get("/locations", response_model=List[StorageLocationResponse])
def get_storage_locations(
    include_inactive: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_or_create_default_storage_location(db, current_user.id)
    db.commit()
    query = db.query(StorageLocation).filter(StorageLocation.user_id == current_user.id)
    if not include_inactive:
        query = query.filter(StorageLocation.is_active.is_(True))
    return query.order_by(StorageLocation.is_default.desc(), StorageLocation.name.asc()).all()


@router.post("/locations", response_model=StorageLocationResponse)
def create_storage_location(
    payload: StorageLocationCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    name = payload.name.strip()
    existing = db.query(StorageLocation).filter(
        StorageLocation.user_id == current_user.id,
        StorageLocation.name == name,
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="A storage location with this name already exists")

    if payload.is_default:
        db.query(StorageLocation).filter(
            StorageLocation.user_id == current_user.id,
            StorageLocation.is_default.is_(True),
        ).update({"is_default": False}, synchronize_session=False)

    location = StorageLocation(
        user_id=current_user.id,
        name=name,
        description=payload.description,
        is_default=payload.is_default,
        is_active=True,
    )
    db.add(location)
    db.flush()
    record_inventory_event(
        db,
        user_id=current_user.id,
        entity_type="storage_location",
        entity_id=location.id,
        entity_uid=location.record_uid,
        action="added",
        changes={"name": {"before": None, "after": name}},
    )
    db.commit()
    db.refresh(location)
    return location


@router.put("/locations/{location_id}", response_model=StorageLocationResponse)
def update_storage_location(
    location_id: int,
    payload: StorageLocationUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    location = db.query(StorageLocation).filter(
        StorageLocation.id == location_id,
        StorageLocation.user_id == current_user.id,
    ).first()
    if not location:
        raise HTTPException(status_code=404, detail="Storage location not found")

    data = payload.model_dump(exclude_unset=True)
    before = {
        "name": location.name,
        "description": location.description,
        "is_default": location.is_default,
        "is_active": location.is_active,
    }
    if "name" in data and data["name"] is not None:
        data["name"] = data["name"].strip()
        duplicate = db.query(StorageLocation).filter(
            StorageLocation.user_id == current_user.id,
            StorageLocation.name == data["name"],
            StorageLocation.id != location.id,
        ).first()
        if duplicate:
            raise HTTPException(status_code=409, detail="A storage location with this name already exists")

    if data.get("is_default"):
        db.query(StorageLocation).filter(
            StorageLocation.user_id == current_user.id,
            StorageLocation.id != location.id,
            StorageLocation.is_default.is_(True),
        ).update({"is_default": False}, synchronize_session=False)
        data["is_active"] = True
    if location.is_default and data.get("is_active") is False:
        raise HTTPException(status_code=409, detail="The default storage location cannot be deactivated")

    for field, value in data.items():
        setattr(location, field, value)
    location.updated_at = datetime.datetime.utcnow()
    after = {
        "name": location.name,
        "description": location.description,
        "is_default": location.is_default,
        "is_active": location.is_active,
    }
    changes = changed_values(before, after)
    if changes:
        record_inventory_event(
            db,
            user_id=current_user.id,
            entity_type="storage_location",
            entity_id=location.id,
            entity_uid=location.record_uid,
            action="updated",
            changes=changes,
        )
    db.commit()
    db.refresh(location)
    return location


@router.get("/history", response_model=List[InventoryEventResponse])
def get_inventory_history(
    entity_type: str | None = Query(default=None),
    entity_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(InventoryEvent).filter(InventoryEvent.user_id == current_user.id)
    if entity_type:
        query = query.filter(InventoryEvent.entity_type == entity_type)
    if entity_id is not None:
        query = query.filter(InventoryEvent.entity_id == entity_id)
    return query.order_by(InventoryEvent.occurred_at.desc(), InventoryEvent.id.desc()).limit(limit).all()
