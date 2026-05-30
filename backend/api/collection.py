from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from api.auth import get_current_user
from database import get_db
from models import CollectionItem, Card, ProductCard, Set, User
from schemas import CollectionItemCreate, CollectionItemUpdate, CollectionItemResponse, BulkCollectionAddRequest, BulkCollectionAddResponse
from services import pokemon_api
from services.card_fallbacks import apply_cross_language_fallbacks, build_missing_language_card
from services.card_numbers import card_number_matches
from services.card_values import effective_market_price, normalize_price_field
from services.collection_csv import collection_import_key, is_valid_collection_purchase_price, merge_collection_import_item, normalize_collection_variant
import datetime
import csv
import io
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

CSV_IMPORT_COLUMNS = ["set_code", "number", "quantity", "condition", "variant", "lang", "purchase_price"]
CSV_IMPORT_MAX_BYTES = 256 * 1024
CSV_IMPORT_MAX_ROWS = 1000
ALLOWED_CONDITIONS = {"Mint", "NM", "LP", "MP", "HP"}
ALLOWED_VARIANTS = {"Normal", "Holo", "Reverse Holo", "First Edition"}
ALLOWED_LANGS = {"en", "de"}


def _normalize_collection_variant(variant: Optional[str]) -> str:
    return normalize_collection_variant(variant)

_SET_CODE_API_CACHE: Optional[dict[str, List[dict]]] = None

def _get_item_price(item, price_field="price_trend"):
    """Return the selected market price for a collection item, respecting holo variant."""
    return effective_market_price(item.card, item.variant, price_field)


def _active_product_link_quantity(db: Session, current_user: User, collection_item_id: int) -> int:
    return int(db.query(func.coalesce(func.sum(ProductCard.active_quantity), 0)).filter(
        ProductCard.user_id == current_user.id,
        ProductCard.collection_item_id == collection_item_id,
    ).scalar() or 0)


def _ensure_set_exists_for_card(db: Session, parsed: dict, lang: str, card_data: Optional[dict] = None) -> None:
    set_id = parsed.get("set_id")
    if not set_id:
        return

    existing_set = db.query(Set).filter(
        or_(Set.id == set_id, Set.id == f"{set_id}_{lang}", Set.tcg_set_id == set_id),
        Set.lang == lang,
    ).first()
    if existing_set:
        return

    set_data = card_data.get("set") if card_data else None
    if set_data:
        set_parsed = pokemon_api.parse_set_for_db(set_data)
        set_parsed["lang"] = set_data.get("_lang", lang)
        if not set_parsed["id"].endswith(("_de", "_en")):
            set_parsed["id"] = f"{set_id}_{lang}"
        set_parsed["tcg_set_id"] = set_id
        db.add(Set(**set_parsed))
    else:
        db.add(Set(id=f"{set_id}_{lang}", tcg_set_id=set_id, name=set_id, total=0, lang=lang))


def ensure_card_exists(db: Session, card_id: str, lang: str = "en") -> Card:
    """Ensure card exists in DB. If not found locally, try to fetch from TCGdex."""
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(card_id)
        card_data = pokemon_api.get_card(tcg_card_id, lang=lang)
        if card_data:
            parsed = pokemon_api.parse_card_for_db(card_data, lang=lang)
            parsed = apply_cross_language_fallbacks(db, parsed)
        else:
            parsed = build_missing_language_card(db, tcg_card_id, lang)
            if not parsed:
                raise HTTPException(
                    status_code=404,
                    detail=f"Card {card_id} is not available locally, from TCGdex, or from a sibling-language fallback yet. Please try again after the source data is available or run Sync later."
                )
        _ensure_set_exists_for_card(db, parsed, lang, card_data)
        card = Card(**parsed)
        db.add(card)
        try:
            db.commit()
            db.refresh(card)
        except Exception:
            db.rollback()
            card = db.query(Card).filter(Card.id == card_id).first()
            if not card:
                raise HTTPException(
                    status_code=404,
                    detail=f"Card {card_id} is not available locally, from TCGdex, or from a sibling-language fallback yet. Please try again after the source data is available or run Sync later."
                )
    return card


def _add_collection_item(db: Session, current_user: User, item: CollectionItemCreate, commit: bool = True) -> str:
    """Add one item and return "added" or "updated"."""
    _, detected_lang = pokemon_api.strip_lang_suffix(item.card_id)
    item_lang = item.lang or detected_lang or "en"
    item_variant = _normalize_collection_variant(item.variant)

    if item.card_id.startswith("custom-"):
        effective_card_id = item.card_id
        custom_card = db.query(Card).filter(Card.id == item.card_id).first()
        if custom_card and custom_card.lang:
            item_lang = custom_card.lang
    else:
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
        effective_card_id = f"{tcg_card_id}_{item_lang}"
        ensure_card_exists(db, effective_card_id, lang=item_lang)

    existing = db.query(CollectionItem).filter(
        CollectionItem.card_id == effective_card_id,
        CollectionItem.variant == item_variant,
        CollectionItem.lang == item_lang,
        CollectionItem.condition == item.condition,
        CollectionItem.purchase_price == item.purchase_price,
        CollectionItem.user_id == current_user.id,
    ).first()

    if existing:
        existing.quantity += item.quantity or 1
        if commit:
            db.commit()
        return "updated"

    db.add(CollectionItem(
        card_id=effective_card_id,
        quantity=item.quantity,
        condition=item.condition,
        variant=item_variant,
        purchase_price=item.purchase_price,
        lang=item_lang,
        user_id=current_user.id,
        added_at=datetime.datetime.utcnow(),
    ))
    if commit:
        db.commit()
    return "added"


def _get_api_sets_by_code() -> dict[str, List[dict]]:
    global _SET_CODE_API_CACHE
    if _SET_CODE_API_CACHE is not None:
        return _SET_CODE_API_CACHE

    index: dict[str, List[dict]] = {}
    for api_set in pokemon_api.get_all_sets():
        abbr_obj = api_set.get("abbreviation") or {}
        official = abbr_obj.get("official") if isinstance(abbr_obj, dict) else None
        api_id = api_set.get("id")
        for code in {str(v).upper() for v in (official, api_id) if v}:
            index.setdefault(code, []).append(api_set)
    _SET_CODE_API_CACHE = index
    return index


def _cache_set_by_code(db: Session, set_code_upper: str) -> None:
    try:
        for api_set in _get_api_sets_by_code().get(set_code_upper, []):
            parsed_set = pokemon_api.parse_set_for_db(api_set)
            parsed_set["lang"] = api_set.get("_lang", parsed_set.get("lang") or "en")
            existing_set = db.query(Set).filter(Set.id == parsed_set["id"]).first()
            if existing_set:
                for key, value in parsed_set.items():
                    if key != "id" and value is not None:
                        setattr(existing_set, key, value)
            else:
                db.add(Set(**parsed_set))
        db.commit()
    except Exception:
        logger.exception("Failed to cache set metadata for CSV import set_code=%s", set_code_upper)
        db.rollback()


def _matching_sets(db: Session, set_code: str) -> List[Set]:
    set_code_upper = set_code.strip().upper()
    set_objs = db.query(Set).filter(
        (func.upper(Set.abbreviation) == set_code_upper) |
        (func.upper(Set.id) == set_code_upper) |
        (func.upper(Set.tcg_set_id) == set_code_upper)
    ).all()
    if not set_objs:
        _cache_set_by_code(db, set_code_upper)
        set_objs = db.query(Set).filter(
            (func.upper(Set.abbreviation) == set_code_upper) |
            (func.upper(Set.id) == set_code_upper) |
            (func.upper(Set.tcg_set_id) == set_code_upper)
        ).all()
    return set_objs


def _find_card_by_code(db: Session, set_code: str, card_number: str, lang: str) -> Card:
    set_objs = _matching_sets(db, set_code)
    if not set_objs:
        raise ValueError(f"set_code '{set_code}' was not found")

    tcg_set_ids = list({s.tcg_set_id or s.id for s in set_objs})

    def query_card() -> Optional[Card]:
        candidates = db.query(Card).filter(
            Card.set_id.in_(tcg_set_ids),
            Card.lang == lang,
            Card.is_custom.is_(False),
        ).order_by(Card.id.asc()).all()
        return next((card for card in candidates if card_number_matches(card.number, card_number)), None)

    card = query_card()
    if card:
        return card

    for tcg_set_id in tcg_set_ids:
        try:
            set_data = pokemon_api.get_set_cards(tcg_set_id, lang=lang)
            for card_data in set_data.get("cards", []):
                parsed = pokemon_api.parse_card_for_db(card_data, default_set_id=tcg_set_id, lang=lang)
                parsed = apply_cross_language_fallbacks(db, parsed)
                existing = db.query(Card).filter(Card.id == parsed["id"]).first()
                if existing:
                    for key, value in parsed.items():
                        if key != "id":
                            setattr(existing, key, value)
                else:
                    db.add(Card(**parsed))
            db.commit()
        except Exception:
            logger.exception("Failed to cache cards for CSV import set_id=%s lang=%s", tcg_set_id, lang)
            db.rollback()

    card = query_card()
    if not card:
        raise ValueError(f"card '{set_code} {card_number}' was not found for lang '{lang}'")
    return card


def _parse_import_row(row: dict, row_number: int) -> CollectionItemCreate:
    set_code = (row.get("set_code") or "").strip()
    number = (row.get("number") or "").strip()
    if not set_code or not number:
        raise ValueError("set_code and number are required")

    quantity_raw = (row.get("quantity") or "1").strip() or "1"
    try:
        quantity = int(quantity_raw)
    except ValueError as exc:
        raise ValueError("quantity must be a whole number") from exc
    if quantity < 1 or quantity > 999:
        raise ValueError("quantity must be between 1 and 999")

    condition = (row.get("condition") or "NM").strip() or "NM"
    if condition not in ALLOWED_CONDITIONS:
        raise ValueError(f"condition must be one of: {', '.join(sorted(ALLOWED_CONDITIONS))}")

    variant = _normalize_collection_variant(row.get("variant"))
    if variant not in ALLOWED_VARIANTS:
        raise ValueError(f"variant must be blank or one of: {', '.join(sorted(ALLOWED_VARIANTS))}")

    lang = (row.get("lang") or "en").strip().lower() or "en"
    if lang not in ALLOWED_LANGS:
        raise ValueError("lang must be 'en' or 'de'")

    purchase_price_raw = (row.get("purchase_price") or "").strip().replace(",", ".")
    purchase_price = None
    if purchase_price_raw:
        try:
            purchase_price = float(purchase_price_raw)
        except ValueError as exc:
            raise ValueError("purchase_price must be a number") from exc
        if not is_valid_collection_purchase_price(purchase_price):
            raise ValueError("purchase_price must be a finite, non-negative number")

    return CollectionItemCreate(
        card_id=f"{set_code} {number}",
        quantity=quantity,
        condition=condition,
        variant=variant,
        purchase_price=purchase_price,
        lang=lang,
    )


@router.get("/user/{user_id}", response_model=List[CollectionItemResponse])
def get_user_collection(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """View another user's collection (read-only). Requires authentication."""
    target_user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    query = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(CollectionItem.user_id == user_id)
    return query.all()


@router.get("/", response_model=List[CollectionItemResponse])
def get_collection(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    sort_by: Optional[str] = "added_at",
    order: Optional[str] = "desc",
):
    """Get all collection items."""
    query = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(CollectionItem.user_id == current_user.id)

    sort_col = {
        "added_at": CollectionItem.added_at,
        "quantity": CollectionItem.quantity,
        "purchase_price": CollectionItem.purchase_price,
    }.get(sort_by, CollectionItem.added_at)

    if order == "desc":
        query = query.order_by(sort_col.desc())
    else:
        query = query.order_by(sort_col.asc())

    items = query.all()
    return items


@router.post("/", response_model=CollectionItemResponse)
def add_to_collection(
    item: CollectionItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a card to the collection. Cards with identical card_id+variant+lang+condition+purchase_price are grouped."""
    _, detected_lang = pokemon_api.strip_lang_suffix(item.card_id)
    item_lang = item.lang or detected_lang or "en"
    item_variant = _normalize_collection_variant(item.variant)

    # Resolve the correct language-variant card_id
    if item.card_id.startswith("custom-"):
        # Custom cards keep their original ID (no language suffix)
        effective_card_id = item.card_id
        # Always derive lang from the custom card record itself
        custom_card = db.query(Card).filter(Card.id == item.card_id).first()
        if custom_card and custom_card.lang:
            item_lang = custom_card.lang
    else:
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
        effective_card_id = f"{tcg_card_id}_{item_lang}"
        ensure_card_exists(db, effective_card_id, lang=item_lang)

    # Find existing entry for same card + variant + lang + condition + purchase_price combination
    existing = db.query(CollectionItem).filter(
        CollectionItem.card_id == effective_card_id,
        CollectionItem.variant == item_variant,
        CollectionItem.lang == item_lang,
        CollectionItem.condition == item.condition,
        CollectionItem.purchase_price == item.purchase_price,
        CollectionItem.user_id == current_user.id,
    ).first()

    if existing:
        existing.quantity += item.quantity or 1
        db.commit()
        db.refresh(existing)
        return existing
    else:
        db_item = CollectionItem(
            card_id=effective_card_id,
            quantity=item.quantity,
            condition=item.condition,
            variant=item_variant,
            purchase_price=item.purchase_price,
            lang=item_lang,
            user_id=current_user.id,
            added_at=datetime.datetime.utcnow(),
        )
        db.add(db_item)
        db.commit()
        db.refresh(db_item)
        return db_item


@router.post("/bulk-add", response_model=BulkCollectionAddResponse)
def bulk_add_to_collection(
    request: BulkCollectionAddRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add multiple cards to the collection in a single request.

    Each item is committed independently so one invalid card does not roll back
    the whole batch. Existing rows are matched by card, normalized variant,
    language, condition, purchase price, and current user, then quantity is
    incremented.
    """
    added = 0
    updated = 0
    failed = 0
    errors: List[str] = []

    for item in request.items:
        try:
            _, detected_lang = pokemon_api.strip_lang_suffix(item.card_id)
            item_lang = item.lang or detected_lang or "en"
            item_variant = _normalize_collection_variant(item.variant)

            if item.card_id.startswith("custom-"):
                effective_card_id = item.card_id
                custom_card = db.query(Card).filter(Card.id == item.card_id).first()
                if custom_card and custom_card.lang:
                    item_lang = custom_card.lang
            else:
                tcg_card_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
                effective_card_id = f"{tcg_card_id}_{item_lang}"
                ensure_card_exists(db, effective_card_id, lang=item_lang)

            existing = db.query(CollectionItem).filter(
                CollectionItem.card_id == effective_card_id,
                CollectionItem.variant == item_variant,
                CollectionItem.lang == item_lang,
                CollectionItem.condition == item.condition,
                CollectionItem.purchase_price == item.purchase_price,
                CollectionItem.user_id == current_user.id,
            ).first()

            if existing:
                existing.quantity += item.quantity or 1
                db.commit()
                updated += 1
            else:
                db.add(CollectionItem(
                    card_id=effective_card_id,
                    quantity=item.quantity,
                    condition=item.condition,
                    variant=item_variant,
                    purchase_price=item.purchase_price,
                    lang=item_lang,
                    user_id=current_user.id,
                    added_at=datetime.datetime.utcnow(),
                ))
                db.commit()
                added += 1
        except HTTPException as exc:
            db.rollback()
            failed += 1
            errors.append(f"{item.card_id}: {exc.detail}")
        except Exception as exc:
            db.rollback()
            failed += 1
            errors.append(f"{item.card_id}: {str(exc)}")

    return BulkCollectionAddResponse(added=added, updated=updated, failed=failed, errors=errors)


@router.post("/import-csv", response_model=BulkCollectionAddResponse)
async def import_collection_csv(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Import collection rows from a strict CSV format.

    Required header, in this exact order:
    set_code,number,quantity,condition,variant,lang,purchase_price
    """
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=422, detail="Please upload a .csv file")

    raw = await file.read(CSV_IMPORT_MAX_BYTES + 1)
    if len(raw) > CSV_IMPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="CSV file is too large")

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="CSV file must be UTF-8 encoded") from exc

    reader = csv.DictReader(io.StringIO(text), delimiter=",")
    if reader.fieldnames != CSV_IMPORT_COLUMNS:
        raise HTTPException(
            status_code=422,
            detail=f"CSV header must exactly be: {','.join(CSV_IMPORT_COLUMNS)}",
        )

    added = 0
    updated = 0
    failed = 0
    errors: List[str] = []
    row_count = 0
    validated_items: dict[tuple, CollectionItemCreate] = {}

    for row_number, row in enumerate(reader, start=2):
        if None in row:
            failed += 1
            errors.append(f"row {row_number}: too many columns")
            continue
        if not any(str(value or "").strip() for value in row.values()):
            continue
        row_count += 1
        if row_count > CSV_IMPORT_MAX_ROWS:
            raise HTTPException(status_code=413, detail=f"CSV import is limited to {CSV_IMPORT_MAX_ROWS} rows")

        try:
            item = _parse_import_row(row, row_number)
            set_code, card_number = item.card_id.split(" ", 1)
            card = _find_card_by_code(db, set_code, card_number, item.lang or "en")
            validated_item = item.copy(update={"card_id": card.id})
            item_key = collection_import_key(
                validated_item.card_id,
                validated_item.variant,
                validated_item.lang,
                validated_item.condition,
                validated_item.purchase_price,
            )
            merge_collection_import_item(validated_items, item_key, validated_item)
        except ValueError as exc:
            db.rollback()
            failed += 1
            errors.append(f"row {row_number}: {str(exc)}")
        except HTTPException as exc:
            db.rollback()
            failed += 1
            errors.append(f"row {row_number}: {exc.detail}")
        except Exception:
            logger.exception("Unexpected CSV import validation error at row %s", row_number)
            db.rollback()
            failed += 1
            errors.append(f"row {row_number}: unexpected import error")

    if failed:
        return BulkCollectionAddResponse(added=0, updated=0, failed=failed, errors=errors)

    for item in validated_items.values():
        try:
            status = _add_collection_item(db, current_user, item, commit=False)
            if status == "added":
                added += 1
            else:
                updated += 1
        except HTTPException as exc:
            db.rollback()
            failed += 1
            errors.append(f"{item.card_id}: {exc.detail}")
            return BulkCollectionAddResponse(added=0, updated=0, failed=failed, errors=errors)
        except Exception:
            logger.exception("Unexpected CSV import write error for card_id=%s", item.card_id)
            db.rollback()
            failed += 1
            errors.append(f"{item.card_id}: unexpected import error")
            return BulkCollectionAddResponse(added=0, updated=0, failed=failed, errors=errors)

    db.commit()
    return BulkCollectionAddResponse(added=added, updated=updated, failed=failed, errors=errors)

@router.put("/{item_id}", response_model=CollectionItemResponse)
def update_collection_item(
    item_id: int,
    update: CollectionItemUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a collection item."""
    item = db.query(CollectionItem).filter(
        CollectionItem.id == item_id,
        CollectionItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    # Use exclude_unset so only fields explicitly sent in the request are updated.
    # Null/blank variants are normalized to Normal; purchase_price may still be cleared with null.
    update_data = update.model_dump(exclude_unset=True)
    if "variant" in update_data:
        update_data["variant"] = _normalize_collection_variant(update_data.get("variant"))
    active_linked_quantity = _active_product_link_quantity(db, current_user, item.id)
    if "quantity" in update_data and update_data["quantity"] is not None:
        if update_data["quantity"] < active_linked_quantity:
            raise HTTPException(
                status_code=409,
                detail=f"Collection quantity cannot be lower than {active_linked_quantity} active product-linked copie(s). Sell or unlink those product cards first.",
            )

    protected_changes = {
        field: update_data[field]
        for field in ("condition", "variant", "lang", "purchase_price")
        if field in update_data and update_data[field] != getattr(item, field)
    }
    if active_linked_quantity > 0 and protected_changes:
        raise HTTPException(
            status_code=409,
            detail="This exact collection row is linked to a product. Unlink or sell the product-linked copies before changing variant, condition, language, or purchase price.",
        )

    # If lang is being changed, also update card_id to the correct language variant
    new_lang = update_data.get("lang")
    if new_lang and new_lang != item.lang:
        card = db.query(Card).filter(Card.id == item.card_id).first()
        if card and not card.is_custom:
            tcg_id, _ = pokemon_api.strip_lang_suffix(item.card_id)
            new_card_id = f"{tcg_id}_{new_lang}"
            ensure_card_exists(db, new_card_id, lang=new_lang)
            update_data["card_id"] = new_card_id

    for field, value in update_data.items():
        setattr(item, field, value)

    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}")
def remove_from_collection(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove a card from collection."""
    item = db.query(CollectionItem).filter(
        CollectionItem.id == item_id,
        CollectionItem.user_id == current_user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    active_linked_quantity = _active_product_link_quantity(db, current_user, item.id)
    if active_linked_quantity > 0:
        raise HTTPException(
            status_code=409,
            detail="This collection item is linked to a product. Sell or unlink the product card before removing it from the active collection.",
        )

    db.delete(item)
    db.commit()
    return {"message": "Removed from collection"}


@router.get("/stats/summary")
def get_collection_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
):
    """Get collection statistics."""
    items = db.query(CollectionItem).options(
        joinedload(CollectionItem.card)
    ).filter(CollectionItem.user_id == current_user.id).all()

    total_cards = sum(item.quantity for item in items)
    unique_cards = len(set(item.card_id for item in items))
    price_field = normalize_price_field(price_field)
    total_value = sum(
        _get_item_price(item, price_field) * item.quantity
        for item in items
        if item.card
    )
    total_cost = sum(
        (item.purchase_price or 0) * item.quantity
        for item in items
    )

    return {
        "total_cards": total_cards,
        "unique_cards": unique_cards,
        "total_value": round(total_value, 2),
        "total_cost": round(total_cost, 2),
        "pnl": round(total_value - total_cost, 2),
    }
