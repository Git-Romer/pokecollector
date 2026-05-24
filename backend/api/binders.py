from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from typing import List
from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, CollectionItem, User, WishlistItem
from schemas import BinderCreate, BinderUpdate, BinderResponse, BinderCardUpdate
from api.collection import ensure_card_exists, _find_card_by_code
from services.card_values import effective_market_price
import datetime
import csv
import io

router = APIRouter()

ALLOWED_BINDER_FORMATS = {"Standard", "Expanded", "Unlimited", "Casual"}
BINDER_CSV_COLUMNS = ["set_code", "number", "required_quantity", "lang"]
BINDER_CSV_MAX_BYTES = 256 * 1024
BINDER_CSV_MAX_ROWS = 1000


def _clean_binder_format(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    for allowed in ALLOWED_BINDER_FORMATS:
        if allowed.lower() == normalized.lower():
            return allowed
    raise HTTPException(status_code=422, detail="Format must be Standard, Expanded, Unlimited, or Casual")


def _safe_required_quantity(value: int | None) -> int:
    try:
        if value is None or value == "":
            qty = 1
        else:
            qty = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Required quantity must be a number")
    if qty < 1 or qty > 99:
        raise HTTPException(status_code=422, detail="Required quantity must be between 1 and 99")
    return qty


def _binder_response(binder: Binder, card_count: int = 0) -> BinderResponse:
    return BinderResponse(
        id=binder.id,
        name=binder.name,
        description=binder.description,
        color=binder.color,
        binder_type=binder.binder_type or "collection",
        format=binder.format,
        icon_pokemon_id=binder.icon_pokemon_id,
        created_at=binder.created_at,
        card_count=card_count,
    )


@router.get("/", response_model=List[BinderResponse])
def get_binders(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all binders."""
    binders = db.query(Binder).filter(
        Binder.user_id == current_user.id
    ).order_by(Binder.created_at.desc()).all()
    result = []
    for binder in binders:
        count = db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count()
        result.append(_binder_response(binder, count))
    return result


@router.post("/", response_model=BinderResponse)
def create_binder(
    binder: BinderCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new binder."""
    db_binder = Binder(
        name=binder.name,
        description=binder.description,
        color=binder.color,
        binder_type=binder.binder_type,
        format=_clean_binder_format(binder.format),
        icon_pokemon_id=binder.icon_pokemon_id,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_binder)
    db.commit()
    db.refresh(db_binder)
    return _binder_response(db_binder, 0)


@router.put("/{binder_id}", response_model=BinderResponse)
def update_binder(
    binder_id: int,
    update: BinderUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    if update.name is not None:
        binder.name = update.name
    if update.description is not None:
        binder.description = update.description
    if update.color is not None:
        binder.color = update.color
    if update.binder_type is not None:
        binder.binder_type = update.binder_type
    if "format" in update.model_fields_set:
        binder.format = _clean_binder_format(update.format)
    if "icon_pokemon_id" in update.model_fields_set:
        binder.icon_pokemon_id = update.icon_pokemon_id

    db.commit()
    db.refresh(binder)
    count = db.query(BinderCard).filter(BinderCard.binder_id == binder_id).count()
    return _binder_response(binder, count)


@router.delete("/{binder_id}")
def delete_binder(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    db.delete(binder)
    db.commit()
    return {"message": "Binder deleted"}


@router.get("/{binder_id}/cards")
def get_binder_cards(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all cards in a binder.
    
    - collection binder: only returns cards that are in the collection
    - wishlist binder: returns all cards with an `owned` flag
    """
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    binder_type = binder.binder_type or "collection"

    binder_cards = db.query(BinderCard).options(
        joinedload(BinderCard.card).joinedload(Card.set_ref),
        joinedload(BinderCard.collection_item),
    ).filter(BinderCard.binder_id == binder_id).order_by(BinderCard.added_at.desc()).all()

    collection_quantities = dict(
        db.query(CollectionItem.card_id, func.coalesce(func.sum(CollectionItem.quantity), 0))
        .filter(CollectionItem.user_id == current_user.id)
        .group_by(CollectionItem.card_id)
        .all()
    )

    cards = []
    owned_count = 0
    total_required_count = 0
    missing_count = 0
    binder_value = 0.0
    cost_to_complete = 0.0

    for bc in binder_cards:
        if not bc.card:
            continue

        # Check if in collection. New collection binders can point at an exact
        # CollectionItem so variants/conditions are represented correctly.
        col_item = None
        if bc.collection_item_id:
            col_item = bc.collection_item if bc.collection_item and bc.collection_item.user_id == current_user.id else None
        if not col_item:
            col_item = db.query(CollectionItem).filter(
                CollectionItem.card_id == bc.card_id,
                CollectionItem.user_id == current_user.id,
            ).first()
        in_collection = col_item is not None

        # For collection binder, skip cards not in collection
        if binder_type == "collection" and not in_collection:
            continue

        required_quantity = _safe_required_quantity(bc.required_quantity)
        owned_quantity = col_item.quantity if bc.collection_item_id and col_item else int(collection_quantities.get(bc.card_id, 0) or 0)
        fulfilled_quantity = min(owned_quantity, required_quantity)
        missing_quantity = max(required_quantity - owned_quantity, 0)
        price = effective_market_price(bc.card, col_item.variant if col_item else None) or 0

        total_required_count += required_quantity
        owned_count += fulfilled_quantity
        missing_count += missing_quantity
        binder_value += price * (owned_quantity if binder_type == "collection" else required_quantity)
        if binder_type == "wishlist":
            cost_to_complete += price * missing_quantity

        card_dict = {
            "id": bc.card.id,
            "name": bc.card.name,
            "set_id": bc.card.set_id,
            "number": bc.card.number,
            "rarity": bc.card.rarity,
            "images_small": bc.card.images_small,
            "images_large": bc.card.images_large,
            "price_market": bc.card.price_market,
            "in_collection": in_collection,
            "owned": in_collection,
            "quantity": owned_quantity,
            "owned_quantity": owned_quantity,
            "required_quantity": required_quantity,
            "missing_quantity": missing_quantity,
            "variant": col_item.variant if col_item else None,
            "condition": col_item.condition if col_item else None,
            "lang": col_item.lang if col_item else (bc.card.lang or "en"),
            "collection_item_id": col_item.id if col_item else None,
            "binder_card_id": bc.id,
        }
        if bc.card.set_ref:
            card_dict["set_name"] = bc.card.set_ref.name
        cards.append(card_dict)

    total_cards = len(binder_cards)

    return {
        "binder": {
            "id": binder.id,
            "name": binder.name,
            "description": binder.description,
            "color": binder.color,
            "binder_type": binder_type,
            "format": binder.format,
            "icon_pokemon_id": binder.icon_pokemon_id,
        },
        "cards": cards,
        "owned_count": owned_count,
        "total_count": len(cards) if binder_type == "collection" else total_cards,
        "total_required_count": total_required_count,
        "missing_count": missing_count,
        "binder_value": round(binder_value, 2),
        "cost_to_complete": round(cost_to_complete, 2),
    }


@router.post("/{binder_id}/cards")
def add_card_to_binder(
    binder_id: int,
    card_id: str,
    required_quantity: int = 1,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a card to a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    ensure_card_exists(db, card_id)
    required_quantity = _safe_required_quantity(required_quantity)

    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.card_id == card_id,
        BinderCard.collection_item_id.is_(None),
    ).first()

    if existing:
        existing.required_quantity = required_quantity
        db.commit()
        return {"message": "Binder quantity updated"}

    bc = BinderCard(
        binder_id=binder_id,
        card_id=card_id,
        required_quantity=required_quantity,
        added_at=datetime.datetime.utcnow(),
    )
    db.add(bc)
    db.commit()
    return {"message": "Card added to binder"}


@router.post("/{binder_id}/collection-items")
def add_collection_item_to_binder(
    binder_id: int,
    collection_item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add an exact collection item to a binder, preserving variant/condition."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "collection":
        raise HTTPException(status_code=400, detail="Collection items can only be added to collection binders")

    item = db.query(CollectionItem).filter(
        CollectionItem.id == collection_item_id,
        CollectionItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.collection_item_id == collection_item_id,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Collection item already in binder")

    bc = BinderCard(
        binder_id=binder_id,
        card_id=item.card_id,
        collection_item_id=collection_item_id,
        required_quantity=1,
        added_at=datetime.datetime.utcnow(),
    )
    db.add(bc)
    db.commit()
    return {"message": "Collection item added to binder"}


@router.put("/{binder_id}/entries/{binder_card_id}")
def update_binder_entry(
    binder_id: int,
    binder_card_id: int,
    update: BinderCardUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update one exact binder entry."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
    ).first()
    if not bc:
        raise HTTPException(status_code=404, detail="Binder entry not found")

    bc.required_quantity = _safe_required_quantity(update.required_quantity)
    db.commit()
    return {"message": "Binder entry updated"}


@router.post("/{binder_id}/entries/{binder_card_id}/wishlist")
def add_binder_entry_to_wishlist(
    binder_id: int,
    binder_card_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a binder card to the user's global wishlist."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
    ).first()
    if not bc:
        raise HTTPException(status_code=404, detail="Binder entry not found")

    existing = db.query(WishlistItem).filter(
        WishlistItem.card_id == bc.card_id,
        WishlistItem.user_id == current_user.id,
    ).first()
    if existing:
        return {"message": "Card already in wishlist"}

    db.add(WishlistItem(
        card_id=bc.card_id,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    ))
    db.commit()
    return {"message": "Card added to wishlist"}


@router.get("/{binder_id}/export-csv")
def export_binder_csv(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export a binder as a small, documented CSV decklist."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    rows = db.query(BinderCard).options(
        joinedload(BinderCard.card).joinedload(Card.set_ref)
    ).filter(BinderCard.binder_id == binder_id).order_by(BinderCard.added_at.asc()).all()

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=BINDER_CSV_COLUMNS)
    writer.writeheader()
    for entry in rows:
        card = entry.card
        if not card:
            continue
        set_ref = card.set_ref
        writer.writerow({
            "set_code": (set_ref.abbreviation if set_ref and set_ref.abbreviation else card.set_id),
            "number": card.number,
            "required_quantity": _safe_required_quantity(entry.required_quantity),
            "lang": card.lang or "en",
        })

    filename = f"binder-{binder_id}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/{binder_id}/import-csv")
async def import_binder_csv(
    binder_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Import binder entries from CSV: set_code,number,required_quantity,lang."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "wishlist":
        raise HTTPException(status_code=400, detail="CSV import is available for wishlist binders")
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=422, detail="Please upload a .csv file")

    raw = await file.read(BINDER_CSV_MAX_BYTES + 1)
    if len(raw) > BINDER_CSV_MAX_BYTES:
        raise HTTPException(status_code=413, detail="CSV file is too large")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="CSV file must be UTF-8 encoded") from exc

    reader = csv.DictReader(io.StringIO(text), delimiter=",")
    if reader.fieldnames != BINDER_CSV_COLUMNS:
        raise HTTPException(status_code=422, detail=f"CSV header must exactly be: {','.join(BINDER_CSV_COLUMNS)}")

    added = 0
    updated = 0
    failed = 0
    errors: List[str] = []
    row_count = 0

    for row_number, row in enumerate(reader, start=2):
        if None in row:
            failed += 1
            errors.append(f"row {row_number}: too many columns")
            continue
        if not any(str(value or "").strip() for value in row.values()):
            continue
        row_count += 1
        if row_count > BINDER_CSV_MAX_ROWS:
            raise HTTPException(status_code=413, detail=f"CSV import is limited to {BINDER_CSV_MAX_ROWS} rows")

        try:
            set_code = (row.get("set_code") or "").strip()
            number = (row.get("number") or "").strip()
            lang = (row.get("lang") or "en").strip().lower()
            if lang not in {"en", "de"}:
                raise ValueError("lang must be en or de")
            if not set_code or not number:
                raise ValueError("set_code and number are required")
            required_quantity = _safe_required_quantity(row.get("required_quantity"))
            card = _find_card_by_code(db, set_code, number, lang)

            existing = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id,
                BinderCard.card_id == card.id,
                BinderCard.collection_item_id.is_(None),
            ).first()
            if existing:
                existing.required_quantity = required_quantity
                updated += 1
            else:
                db.add(BinderCard(
                    binder_id=binder_id,
                    card_id=card.id,
                    required_quantity=required_quantity,
                    added_at=datetime.datetime.utcnow(),
                ))
                added += 1
            db.commit()
        except HTTPException as exc:
            db.rollback()
            failed += 1
            errors.append(f"row {row_number}: {exc.detail}")
        except Exception as exc:
            db.rollback()
            failed += 1
            errors.append(f"row {row_number}: {str(exc)}")

    return {"added": added, "updated": updated, "failed": failed, "errors": errors}


@router.delete("/{binder_id}/entries/{binder_card_id}")
def remove_binder_entry(
    binder_id: int,
    binder_card_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove one exact binder entry."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
    ).first()
    if not bc:
        raise HTTPException(status_code=404, detail="Binder entry not found")

    db.delete(bc)
    db.commit()
    return {"message": "Card removed from binder"}


@router.delete("/{binder_id}/cards/{card_id}")
def remove_card_from_binder(
    binder_id: int,
    card_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a card from a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.card_id == card_id,
    ).first()

    if not bc:
        raise HTTPException(status_code=404, detail="Card not in binder")

    db.delete(bc)
    db.commit()
    return {"message": "Card removed from binder"}
