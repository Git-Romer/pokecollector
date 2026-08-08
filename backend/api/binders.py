from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload
from typing import List
from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, CollectionItem, Set, User, WishlistItem
from schemas import BinderCreate, BinderUpdate, BinderResponse, BinderCardUpdate, BinderCardSwitch, BinderPrintOptimizationApply
from api.collection import ensure_card_exists, _find_card_by_code
from services import pokemon_api
from services.card_fallbacks import apply_cross_language_fallbacks
from services.card_upsert import upsert_card
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_card_filter, visible_set_filter
from services.collection_csv import normalize_collection_variant
from services.binder_csv import BINDER_CSV_DUPLICATE_QUANTITY_ERROR, combine_binder_required_quantity
from services.binder_allocations import (
    collection_binder_allocated_card_counts,
    collection_binder_allocation_counts,
    stored_binder_quantity,
)
from services.wishlist_missing import plan_missing_wishlist_additions
from services.tcgdex_languages import SUPPORTED_TCGDEX_LANGUAGES, is_supported_tcgdex_language, normalize_tcgdex_language
from services.public_profile_feature import public_profiles_enabled
import datetime
import csv
import io
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

ALLOWED_BINDER_FORMATS = {"Standard", "Expanded", "Unlimited", "Casual"}
BINDER_CSV_LEGACY_COLUMNS = ["set_code", "number", "required_quantity", "lang"]
BINDER_CSV_PHYSICAL_COLUMNS = [*BINDER_CSV_LEGACY_COLUMNS, "variant", "condition"]
BINDER_CSV_COLUMNS = [*BINDER_CSV_PHYSICAL_COLUMNS, "collection_item_id"]
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


def _collection_binder_usage_counts(db: Session, current_user: User) -> dict[int, int]:
    """Return allocated copies for each exact item across collection binders."""
    return collection_binder_allocation_counts(db, current_user.id)


def _binder_counts(db: Session, binder: Binder) -> tuple[int, int]:
    base_query = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).filter(
        BinderCard.binder_id == binder.id,
        visible_card_filter(db, binder.user_id, "all"),
    )
    unique_count = base_query.with_entities(func.count(func.distinct(BinderCard.card_id))).scalar() or 0
    total_count = base_query.with_entities(
        func.coalesce(func.sum(func.coalesce(BinderCard.required_quantity, 1)), 0)
    ).scalar() or 0
    return int(total_count), int(unique_count)


def _binder_response(binder: Binder, card_count: int = 0, unique_card_count: int = 0) -> BinderResponse:
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
        unique_card_count=unique_card_count,
        is_public=binder.is_public or False,
    )


def _user_collection_quantities(db: Session, current_user: User, card_ids: list[str] | None = None) -> dict[str, int]:
    query = db.query(CollectionItem.card_id, func.coalesce(func.sum(CollectionItem.quantity), 0)).join(
        Card, Card.id == CollectionItem.card_id
    ).filter(
        CollectionItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    )
    if card_ids is not None:
        if not card_ids:
            return {}
        query = query.filter(CollectionItem.card_id.in_(card_ids))
    return {
        card_id: int(quantity or 0)
        for card_id, quantity in query.group_by(CollectionItem.card_id).all()
    }


def _available_collection_card_quantities(
    db: Session,
    current_user: User,
    card_ids: list[str] | None = None,
    owned_quantities: dict[str, int] | None = None,
) -> dict[str, int]:
    """Return owned copies not currently allocated to collection binders."""
    if owned_quantities is None:
        owned_quantities = _user_collection_quantities(db, current_user, card_ids)
    allocated_quantities = collection_binder_allocated_card_counts(
        db,
        current_user.id,
        list(owned_quantities),
    )
    return {
        card_id: max(int(quantity or 0) - int(allocated_quantities.get(card_id, 0) or 0), 0)
        for card_id, quantity in owned_quantities.items()
    }


def _user_wishlist_quantities(db: Session, current_user: User, card_ids: list[str] | None = None) -> dict[str, int]:
    query = db.query(WishlistItem.card_id, func.coalesce(func.sum(WishlistItem.quantity), 0)).join(
        Card, Card.id == WishlistItem.card_id
    ).filter(
        WishlistItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    )
    if card_ids is not None:
        if not card_ids:
            return {}
        query = query.filter(WishlistItem.card_id.in_(card_ids))
    return {
        card_id: int(quantity or 0)
        for card_id, quantity in query.group_by(WishlistItem.card_id).all()
    }


def _apply_wishlist_additions(db: Session, current_user: User, additions) -> tuple[int, int]:
    """Insert or increment global wishlist rows. Returns touched rows and copies."""
    touched = 0
    added_copies = 0
    for addition in additions:
        existing = db.query(WishlistItem).filter(
            WishlistItem.card_id == addition.card_id,
            WishlistItem.user_id == current_user.id,
        ).first()
        if existing:
            current_quantity = max(int(existing.quantity or 1), 1)
            next_quantity = min(99, current_quantity + addition.quantity)
            actual_added = next_quantity - current_quantity
            if actual_added <= 0:
                continue
            existing.quantity = next_quantity
        else:
            actual_added = min(99, addition.quantity)
            if actual_added <= 0:
                continue
            db.add(WishlistItem(
                card_id=addition.card_id,
                quantity=actual_added,
                user_id=current_user.id,
                created_at=datetime.datetime.utcnow(),
            ))
        touched += 1
        added_copies += actual_added
    return touched, added_copies


def _ensure_card_gameplay_data(db: Session, card: Card | None) -> Card | None:
    """Fetch full TCGdex card data when a local card has no playable fingerprint yet."""
    if not card or card.is_custom or card.playable_fingerprint or not card.tcg_card_id:
        return card

    lang = card.lang or "en"
    try:
        card_data = pokemon_api.get_card(card.tcg_card_id, lang=lang)
        if not card_data:
            return card
        parsed = pokemon_api.parse_card_for_db(card_data, lang=lang)
        parsed = apply_cross_language_fallbacks(db, parsed)
        updated = upsert_card(db, parsed)
        db.commit()
        db.refresh(updated)
        return updated
    except Exception:
        logger.exception("Failed to hydrate gameplay data for card_id=%s lang=%s", card.id, lang)
        db.rollback()
        return db.query(Card).filter(Card.id == card.id).first()


def _cache_same_name_cards_for_equivalents(db: Session, source_card: Card) -> None:
    """Cache full same-name cards so equivalent-print lookup can compare fingerprints."""
    if not source_card.name or not source_card.lang:
        return
    try:
        results = pokemon_api.search_cards(
            name=source_card.name,
            lang=source_card.lang,
            page=1,
            page_size=500,
        ).get("data", [])
    except Exception:
        logger.exception("Failed to search TCGdex same-name cards for %s", source_card.name)
        return

    exact_name = source_card.name.strip().lower()
    fetched = 0
    pending_writes = 0
    for candidate in results:
        if (candidate.get("name") or "").strip().lower() != exact_name:
            continue
        tcg_card_id = candidate.get("id")
        if not tcg_card_id:
            continue
        db_id = f"{tcg_card_id}_{source_card.lang}"
        local = db.query(Card).filter(Card.id == db_id).first()
        if local and local.playable_fingerprint:
            continue
        try:
            detail = pokemon_api.get_card(tcg_card_id, lang=source_card.lang)
            if not detail:
                continue
            parsed = pokemon_api.parse_card_for_db(detail, lang=source_card.lang)
            parsed = apply_cross_language_fallbacks(db, parsed)
            upsert_card(db, parsed)
            pending_writes += 1
            fetched += 1
            if pending_writes >= 20:
                db.commit()
                pending_writes = 0
            if fetched >= 80:
                break
        except Exception:
            logger.exception("Failed to cache equivalent-print candidate %s", tcg_card_id)
            db.rollback()
            pending_writes = 0
    if pending_writes:
        db.commit()


def _relock_binder_for_write(
    db: Session,
    binder_id: int,
    user_id: int,
    expected_type: str,
) -> Binder:
    """Reacquire a binder lock after cache helpers that may commit."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == user_id,
    ).populate_existing().with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != expected_type:
        raise HTTPException(
            status_code=409,
            detail="Binder type changed while processing this request; please try again",
        )
    return binder


def _binder_card_summary(
    card: Card,
    owned_quantity: int,
    is_current: bool = False,
    collection_item: CollectionItem | None = None,
    available_quantity: int | None = None,
    price_field: str | None = "price_trend",
) -> dict:
    price = effective_market_price(card, collection_item.variant if collection_item else None, price_field) or 0
    summary = {
        "id": card.id,
        "name": card.name,
        "set_id": card.set_id,
        "set_name": card.set_ref.name if card.set_ref else None,
        "number": card.number,
        "rarity": card.rarity,
        "images_small": card.images_small,
        "images_large": card.images_large,
        "custom_image_url": card.custom_image_url,
        "lang": card.lang or "en",
        "price_market": price,
        "price_low": card.price_low,
        "price_trend": card.price_trend,
        "owned_quantity": int(owned_quantity or 0),
        "available_quantity": int(available_quantity) if available_quantity is not None else None,
        "owned": bool(owned_quantity),
        "is_current": is_current,
    }
    if collection_item:
        summary.update({
            "collection_item_id": collection_item.id,
            "variant": collection_item.variant,
            "condition": collection_item.condition,
        })
    return summary


def _price_sort_value(card: Card, variant: str | None = None, price_field: str | None = "price_trend") -> float | None:
    price = effective_market_price(card, variant, price_field)
    return float(price) if price and price > 0 else None


def _cheapest_equivalent_candidate(
    db: Session,
    current_user: User,
    source_card: Card,
    price_field: str | None = "price_trend",
) -> Card | None:
    source_card = _ensure_card_gameplay_data(db, source_card)
    if not source_card or not source_card.playable_fingerprint:
        return None

    _cache_same_name_cards_for_equivalents(db, source_card)
    source_card = db.query(Card).filter(Card.id == source_card.id).first()
    if not source_card or not source_card.playable_fingerprint:
        return None

    candidates = db.query(Card).options(joinedload(Card.set_ref)).filter(
        Card.playable_fingerprint == source_card.playable_fingerprint,
        Card.lang == (source_card.lang or "en"),
        Card.is_custom.is_(False),
        visible_card_filter(db, current_user.id, "all"),
    ).all()
    priced_candidates = [(card, _price_sort_value(card, price_field=price_field)) for card in candidates]
    priced_candidates = [(card, price) for card, price in priced_candidates if price is not None]
    if not priced_candidates:
        return None
    return min(priced_candidates, key=lambda item: (item[1], item[0].set_id or "", item[0].number or ""))[0]


def _collection_optimizer_candidates(
    db: Session,
    current_user: User,
    source_card: Card,
    source_item_id: int | None,
    excluded_collection_item_ids: set[int] | None = None,
    required_quantity: int = 1,
    reserved_collection_item_quantities: dict[int, int] | None = None,
    binder_collection_item_quantities: dict[int, int] | None = None,
    price_field: str | None = "price_trend",
) -> list[tuple[CollectionItem, Card, float]]:
    """Return cheaper owned playable-equivalent collection items for collection binders."""
    usage_counts = _collection_binder_usage_counts(db, current_user)
    excluded_collection_item_ids = excluded_collection_item_ids or set()
    reserved_collection_item_quantities = reserved_collection_item_quantities or {}
    binder_collection_item_quantities = binder_collection_item_quantities or {}
    collection_items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(
        CollectionItem.user_id == current_user.id,
        CollectionItem.id != source_item_id,
        ~CollectionItem.id.in_(excluded_collection_item_ids),
        Card.name == source_card.name,
        Card.lang == (source_card.lang or "en"),
        Card.is_custom.is_(False),
        visible_card_filter(db, current_user.id, "all"),
    ).all()

    candidates = []
    for item in collection_items:
        used_quantity = int(usage_counts.get(item.id, 0) or 0)
        reserved_quantity = int(reserved_collection_item_quantities.get(item.id, 0) or 0)
        stock_capacity = int(item.quantity or 0) - used_quantity - reserved_quantity
        row_capacity = 99 - int(binder_collection_item_quantities.get(item.id, 0) or 0) - reserved_quantity
        available_quantity = max(min(stock_capacity, row_capacity), 0)
        if available_quantity < required_quantity:
            continue
        card = _ensure_card_gameplay_data(db, item.card)
        if not card or card.playable_fingerprint != source_card.playable_fingerprint:
            continue
        price = _price_sort_value(card, item.variant, price_field)
        if price is None:
            continue
        candidates.append((item, card, price))
    return candidates


def _build_print_optimization_preview(db: Session, binder: Binder, current_user: User, price_field: str | None = "price_trend") -> dict:
    price_field = normalize_price_field(price_field)
    binder_type = binder.binder_type or "collection"
    if binder_type not in {"collection", "wishlist"}:
        raise HTTPException(status_code=400, detail="Print optimization is available for collection and wishlist binders")

    binder_cards = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).options(
        joinedload(BinderCard.card).joinedload(Card.set_ref),
        joinedload(BinderCard.collection_item),
    ).filter(
        BinderCard.binder_id == binder.id,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(BinderCard.added_at.desc()).all()

    recommendations = []
    candidate_cache: dict[str, Card | None] = {}
    reserved_suggested_quantities: dict[int, int] = {}
    binder_collection_item_quantities = {
        collection_item_id: sum(
            stored_binder_quantity(entry.required_quantity)
            for entry in binder_cards
            if entry.collection_item_id == collection_item_id
        )
        for collection_item_id in {
            entry.collection_item_id for entry in binder_cards if entry.collection_item_id is not None
        }
    }
    for bc in binder_cards:
        if not bc.card:
            continue
        source_card = _ensure_card_gameplay_data(db, bc.card)
        if not source_card or not source_card.playable_fingerprint:
            continue

        if binder_type == "collection":
            source_item = bc.collection_item
            if not source_item or source_item.user_id != current_user.id:
                continue
            current_price = _price_sort_value(source_card, source_item.variant, price_field)
            if current_price is None:
                continue
            required_quantity = stored_binder_quantity(bc.required_quantity)
            candidates = _collection_optimizer_candidates(
                db,
                current_user,
                source_card,
                source_item.id,
                None,
                required_quantity,
                reserved_suggested_quantities,
                binder_collection_item_quantities,
                price_field,
            )
            cheaper_candidates = [item for item in candidates if item[2] < current_price]
            if not cheaper_candidates:
                continue
            target_item, candidate, suggested_price = min(
                cheaper_candidates,
                key=lambda item: (item[2], item[1].set_id or "", item[1].number or "", item[0].id),
            )
            reserved_suggested_quantities[target_item.id] = (
                reserved_suggested_quantities.get(target_item.id, 0) + required_quantity
            )
            savings_per_copy = current_price - suggested_price
            recommendations.append({
                "binder_card_id": bc.id,
                "required_quantity": required_quantity,
                "current": _binder_card_summary(source_card, owned_quantity=source_item.quantity or 0, is_current=True, collection_item=source_item, price_field=price_field),
                "suggested": _binder_card_summary(candidate, owned_quantity=target_item.quantity or 0, is_current=False, collection_item=target_item, price_field=price_field),
                "current_price": current_price,
                "suggested_price": suggested_price,
                "savings_per_copy": round(savings_per_copy, 2),
                "total_savings": round(savings_per_copy * required_quantity, 2),
            })
            continue

        cache_key = f"{source_card.lang or 'en'}:{source_card.playable_fingerprint}"
        if cache_key not in candidate_cache:
            candidate_cache[cache_key] = _cheapest_equivalent_candidate(db, current_user, source_card, price_field)
        candidate = candidate_cache[cache_key]
        if not candidate or candidate.id == bc.card_id:
            continue

        current_price = _price_sort_value(source_card, price_field=price_field)
        suggested_price = _price_sort_value(candidate, price_field=price_field)
        if current_price is None or suggested_price is None:
            continue
        if suggested_price >= current_price:
            continue

        required_quantity = _safe_required_quantity(bc.required_quantity)
        savings_per_copy = current_price - suggested_price
        recommendations.append({
            "binder_card_id": bc.id,
            "required_quantity": required_quantity,
            "current": _binder_card_summary(source_card, owned_quantity=0, is_current=True, price_field=price_field),
            "suggested": _binder_card_summary(candidate, owned_quantity=0, is_current=False, price_field=price_field),
            "current_price": current_price,
            "suggested_price": suggested_price,
            "savings_per_copy": round(savings_per_copy, 2),
            "total_savings": round(savings_per_copy * required_quantity, 2),
        })

    total_savings = sum(item["total_savings"] for item in recommendations)
    return {
        "binder_id": binder.id,
        "mode": "cheapest",
        "scope": binder_type,
        "recommendations": recommendations,
        "change_count": len(recommendations),
        "total_savings": round(total_savings, 2),
    }


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
        total_count, unique_count = _binder_counts(db, binder)
        result.append(_binder_response(binder, total_count, unique_count))
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
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    current_type = binder.binder_type or "collection"
    requested_type = (
        (update.binder_type or "collection")
        if update.binder_type is not None
        else current_type
    )
    type_changed = requested_type != current_type
    if type_changed:
        has_cards = db.query(BinderCard.id).filter(BinderCard.binder_id == binder_id).first() is not None
        if has_cards:
            raise HTTPException(status_code=400, detail="Binder type cannot be changed after cards are added")

    if "is_public" in update.model_fields_set:
        if not public_profiles_enabled(db):
            raise HTTPException(status_code=403, detail="Public profiles are disabled by the administrator")
        if update.is_public is None:
            raise HTTPException(status_code=422, detail="Public sharing must be true or false")
        if update.is_public and requested_type != "collection":
            raise HTTPException(status_code=422, detail="Only collection binders can be shared publicly")

    if update.name is not None:
        binder.name = update.name
    if update.description is not None:
        binder.description = update.description
    if update.color is not None:
        binder.color = update.color
    if update.binder_type is not None:
        binder.binder_type = requested_type
        if type_changed:
            # A type conversion always requires a fresh sharing decision.
            binder.is_public = False
            if requested_type != "collection":
                binder.auto_owned_set_id = None
    if "format" in update.model_fields_set:
        binder.format = _clean_binder_format(update.format)
    if "icon_pokemon_id" in update.model_fields_set:
        binder.icon_pokemon_id = update.icon_pokemon_id
    if "is_public" in update.model_fields_set:
        binder.is_public = update.is_public

    db.commit()
    db.refresh(binder)
    total_count, unique_count = _binder_counts(db, binder)
    return _binder_response(binder, total_count, unique_count)


@router.post("/{binder_id}/convert-to-collection")
def convert_wishlist_binder_to_collection(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atomically replace a complete wishlist with exact owned allocations."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "wishlist":
        raise HTTPException(status_code=400, detail="Only wishlist binders can be converted")

    entries = db.query(BinderCard).options(joinedload(BinderCard.card)).filter(
        BinderCard.binder_id == binder.id,
    ).order_by(BinderCard.id.asc()).with_for_update(of=BinderCard).all()
    if not entries:
        raise HTTPException(status_code=400, detail="An empty wishlist binder cannot be converted")
    if any(entry.collection_item_id is not None for entry in entries):
        raise HTTPException(status_code=409, detail="This wishlist contains invalid exact-copy links and cannot be converted safely")

    card_ids = sorted({entry.card_id for entry in entries if entry.card_id})
    owned_items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
        CollectionItem.user_id == current_user.id,
        CollectionItem.card_id.in_(card_ids),
        CollectionItem.quantity > 0,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()

    usage_counts = _collection_binder_usage_counts(db, current_user)
    items_by_card: dict[str, list[CollectionItem]] = {}
    remaining_by_item: dict[int, int] = {}
    for item in owned_items:
        items_by_card.setdefault(item.card_id, []).append(item)
        remaining_by_item[item.id] = max(
            int(item.quantity or 0) - int(usage_counts.get(item.id, 0) or 0),
            0,
        )

    entries_by_card: dict[str, list[BinderCard]] = {}
    for entry in entries:
        entries_by_card.setdefault(entry.card_id, []).append(entry)

    assignments: dict[str, list[tuple[CollectionItem, int]]] = {}
    shortages: list[str] = []
    for card_id, card_entries in entries_by_card.items():
        required = sum(_safe_required_quantity(entry.required_quantity) for entry in card_entries)
        remaining = required
        planned = []
        for item in items_by_card.get(card_id, []):
            available = remaining_by_item.get(item.id, 0)
            assigned = min(remaining, available, 99)
            if assigned <= 0:
                continue
            planned.append((item, assigned))
            remaining_by_item[item.id] = available - assigned
            remaining -= assigned
            if remaining == 0:
                break
        if remaining > 0:
            representative = card_entries[0]
            card_label = representative.card.name if representative.card and representative.card.name else card_id
            copy_label = "copy" if remaining == 1 else "copies"
            shortages.append(f"{card_label}: {remaining} more unallocated {copy_label} needed")
        assignments[card_id] = planned

    if shortages:
        displayed_shortages = shortages[:10]
        if len(shortages) > len(displayed_shortages):
            displayed_shortages.append(f"and {len(shortages) - len(displayed_shortages)} more card(s)")
        raise HTTPException(
            status_code=409,
            detail="Wishlist is not complete with unallocated copies. " + "; ".join(displayed_shortages),
        )

    allocated_copies = 0
    for card_id, card_entries in entries_by_card.items():
        planned = assignments[card_id]
        entry = card_entries[0]
        first_item, first_quantity = planned[0]
        entry.card_id = first_item.card_id
        entry.collection_item_id = first_item.id
        entry.required_quantity = first_quantity
        allocated_copies += first_quantity
        for duplicate in card_entries[1:]:
            db.delete(duplicate)
        for item, quantity in planned[1:]:
            db.add(BinderCard(
                binder_id=binder.id,
                card_id=item.card_id,
                collection_item_id=item.id,
                required_quantity=quantity,
                added_at=entry.added_at or datetime.datetime.utcnow(),
            ))
            allocated_copies += quantity

    binder.binder_type = "collection"
    binder.is_public = False
    db.commit()
    db.refresh(binder)
    total_count, unique_count = _binder_counts(db, binder)
    return {
        "message": "Wishlist binder converted to a collection binder",
        "binder": _binder_response(binder, total_count, unique_count),
        "allocated_copies": allocated_copies,
    }


@router.post("/{binder_id}/convert-to-wishlist")
def convert_collection_binder_to_wishlist(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Release exact allocations and turn a collection binder into a wishlist."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "collection":
        raise HTTPException(status_code=400, detail="Only collection binders can be converted")

    entries = db.query(BinderCard).filter(
        BinderCard.binder_id == binder.id,
    ).order_by(BinderCard.id.asc()).with_for_update(of=BinderCard).all()

    entries_by_card: dict[str, list[BinderCard]] = {}
    for entry in entries:
        entries_by_card.setdefault(entry.card_id, []).append(entry)

    released_copies = 0
    for card_entries in entries_by_card.values():
        total_quantity = sum(
            _safe_required_quantity(entry.required_quantity)
            for entry in card_entries
        )
        released_copies += sum(
            _safe_required_quantity(entry.required_quantity)
            for entry in card_entries
            if entry.collection_item_id is not None
        )
        chunks = []
        remaining = total_quantity
        while remaining > 0:
            chunk = min(remaining, 99)
            chunks.append(chunk)
            remaining -= chunk

        for entry, quantity in zip(card_entries, chunks):
            entry.collection_item_id = None
            entry.required_quantity = quantity
        for extra_entry in card_entries[len(chunks):]:
            db.delete(extra_entry)

    binder.binder_type = "wishlist"
    binder.is_public = False
    binder.auto_owned_set_id = None
    db.commit()
    db.refresh(binder)
    total_count, unique_count = _binder_counts(db, binder)
    return {
        "message": "Collection binder converted to a wishlist binder",
        "binder": _binder_response(binder, total_count, unique_count),
        "released_copies": released_copies,
    }


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
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    db.delete(binder)
    db.commit()
    return {"message": "Binder deleted"}


@router.get("/{binder_id}/cards")
def get_binder_cards(
    binder_id: int,
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
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
    price_field = normalize_price_field(price_field)

    binder_cards = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).options(
        joinedload(BinderCard.card).joinedload(Card.set_ref),
        joinedload(BinderCard.collection_item),
    ).filter(
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(BinderCard.added_at.desc()).all()

    collection_quantities = dict(
        db.query(CollectionItem.card_id, func.coalesce(func.sum(CollectionItem.quantity), 0))
        .join(Card, Card.id == CollectionItem.card_id)
        .filter(CollectionItem.user_id == current_user.id)
        .filter(visible_card_filter(db, current_user.id, "all"))
        .group_by(CollectionItem.card_id)
        .all()
    )
    available_collection_quantities = (
        _available_collection_card_quantities(
            db,
            current_user,
            list(collection_quantities),
            owned_quantities=collection_quantities,
        )
        if binder_type == "wishlist"
        else collection_quantities
    )
    remaining_available_by_card = dict(available_collection_quantities)
    usage_counts = _collection_binder_usage_counts(db, current_user)
    unavailable_collection_item_ids = []
    if binder_type == "collection":
        owned_items = db.query(CollectionItem.id, CollectionItem.quantity).join(Card, Card.id == CollectionItem.card_id).filter(
            CollectionItem.user_id == current_user.id,
            visible_card_filter(db, current_user.id, "all"),
        ).all()
        unavailable_collection_item_ids = [
            item_id for item_id, quantity in owned_items
            if usage_counts.get(item_id, 0) >= (quantity or 1)
        ]

    cards = []
    owned_count = 0
    total_required_count = 0
    missing_count = 0
    binder_value = 0.0
    current_value = 0.0
    cost_to_complete = 0.0

    for bc in binder_cards:
        if not bc.card:
            continue

        # Check if in collection. New collection binders can point at an exact
        # CollectionItem so variants/conditions are represented correctly.
        exact_col_item = None
        if bc.collection_item_id:
            exact_col_item = bc.collection_item if bc.collection_item and bc.collection_item.user_id == current_user.id else None
        col_item = exact_col_item
        if not col_item and binder_type != "wishlist":
            col_item = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
                CollectionItem.card_id == bc.card_id,
                CollectionItem.user_id == current_user.id,
                visible_card_filter(db, current_user.id, "all"),
            ).first()
        in_collection = (
            int(collection_quantities.get(bc.card_id, 0) or 0) > 0
            if binder_type == "wishlist"
            else col_item is not None
        )

        # For collection binder, skip cards not in collection
        if binder_type == "collection" and not in_collection:
            continue

        required_quantity = _safe_required_quantity(bc.required_quantity)
        collection_quantity = (
            int(collection_quantities.get(bc.card_id, 0) or 0)
            if binder_type == "wishlist"
            else int(col_item.quantity or 0) if col_item else 0
        )
        if binder_type == "collection" and col_item:
            owned_quantity = required_quantity
        elif binder_type == "wishlist":
            available_quantity = int(remaining_available_by_card.get(bc.card_id, 0) or 0)
            owned_quantity = min(required_quantity, available_quantity)
            remaining_available_by_card[bc.card_id] = max(available_quantity - owned_quantity, 0)
        else:
            owned_quantity = int(available_collection_quantities.get(bc.card_id, 0) or 0)
        fulfilled_quantity = min(owned_quantity, required_quantity)
        missing_quantity = max(required_quantity - owned_quantity, 0)
        price = effective_market_price(bc.card, col_item.variant if col_item else None, price_field) or 0

        total_required_count += required_quantity
        owned_count += fulfilled_quantity
        missing_count += missing_quantity
        binder_value += price * required_quantity
        current_value += price * fulfilled_quantity
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
            "price_market": price,
            "in_collection": in_collection,
            "owned": owned_quantity > 0,
            "quantity": owned_quantity,
            "owned_quantity": owned_quantity,
            "collection_quantity": collection_quantity,
            "required_quantity": required_quantity,
            "missing_quantity": missing_quantity,
            "variant": col_item.variant if col_item else None,
            "condition": col_item.condition if col_item else None,
            "lang": col_item.lang if col_item else (bc.card.lang or "en"),
            "collection_item_id": exact_col_item.id if exact_col_item else None,
            "binder_card_id": bc.id,
        }
        if binder_type == "collection" and exact_col_item:
            allocated_elsewhere = max(int(usage_counts.get(exact_col_item.id, 0) or 0) - required_quantity, 0)
            card_dict["available_quantity"] = max(collection_quantity - int(usage_counts.get(exact_col_item.id, 0) or 0), 0)
            card_dict["max_assignable_quantity"] = min(99, max(collection_quantity - allocated_elsewhere, 0))
        if bc.card.set_ref:
            card_dict["set_name"] = bc.card.set_ref.name
        cards.append(card_dict)

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
        "total_count": total_required_count,
        "total_required_count": total_required_count,
        "missing_count": missing_count,
        "unique_count": len({card["id"] for card in cards}),
        "binder_value": round(binder_value, 2),
        "current_value": round(current_value, 2),
        "cost_to_complete": round(cost_to_complete, 2),
        "unavailable_collection_item_ids": unavailable_collection_item_ids,
    }


@router.get("/{binder_id}/optimize-prints")
def preview_binder_print_optimization(
    binder_id: int,
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Preview cheapest playable-equivalent print replacements for a binder."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    return _build_print_optimization_preview(db, binder, current_user, price_field)


@router.post("/{binder_id}/optimize-prints")
def apply_binder_print_optimization(
    binder_id: int,
    update: BinderPrintOptimizationApply | None = None,
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply cheapest playable-equivalent print replacements after preview."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    binder_type = binder.binder_type or "collection"
    preview = _build_print_optimization_preview(db, binder, current_user, price_field)
    binder = _relock_binder_for_write(
        db, binder_id, current_user.id, binder_type
    )
    selected_ids = None
    if update and update.selected_binder_card_ids is not None:
        selected_ids = set(update.selected_binder_card_ids)
    applied = 0
    skipped = 0
    applied_total_savings = 0.0
    for recommendation in preview["recommendations"]:
        binder_card_id = recommendation["binder_card_id"]
        if selected_ids is not None and binder_card_id not in selected_ids:
            continue

        if binder_type == "collection":
            target_collection_item_id = recommendation["suggested"].get("collection_item_id")
            if not target_collection_item_id:
                skipped += 1
                continue
            bc = db.query(BinderCard).options(joinedload(BinderCard.collection_item)).filter(
                BinderCard.id == binder_card_id,
                BinderCard.binder_id == binder_id,
                BinderCard.collection_item_id.isnot(None),
            ).first()
            if not bc or bc.collection_item_id == target_collection_item_id:
                skipped += 1
                continue
            source_item_id = bc.collection_item_id
            locked_items = db.query(CollectionItem).filter(
                CollectionItem.id.in_([source_item_id, target_collection_item_id]),
                CollectionItem.user_id == current_user.id,
            ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()
            locked_by_id = {item.id: item for item in locked_items}
            target_item = locked_by_id.get(target_collection_item_id)
            if not target_item or source_item_id not in locked_by_id:
                skipped += 1
                continue
            db.refresh(bc)
            if bc.collection_item_id != source_item_id:
                skipped += 1
                continue
            existing = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id,
                BinderCard.collection_item_id == target_item.id,
                BinderCard.id != bc.id,
            ).first()
            if existing:
                assigned_quantity = stored_binder_quantity(bc.required_quantity)
                combined_quantity = stored_binder_quantity(existing.required_quantity) + assigned_quantity
                usage_count = _collection_binder_usage_counts(db, current_user).get(target_item.id, 0)
                if combined_quantity > 99 or usage_count + assigned_quantity > int(target_item.quantity or 0):
                    skipped += 1
                    continue
                existing.required_quantity = combined_quantity
                db.delete(bc)
                applied += 1
                applied_total_savings += recommendation["total_savings"]
                continue
            assigned_quantity = stored_binder_quantity(bc.required_quantity)
            usage_count = _collection_binder_usage_counts(db, current_user).get(target_item.id, 0)
            if usage_count + assigned_quantity > int(target_item.quantity or 0):
                skipped += 1
                continue
            bc.card_id = target_item.card_id
            bc.collection_item_id = target_item.id
            bc.required_quantity = assigned_quantity
            applied += 1
            applied_total_savings += recommendation["total_savings"]
            continue

        target_card_id = recommendation["suggested"]["id"]
        bc = db.query(BinderCard).filter(
            BinderCard.id == binder_card_id,
            BinderCard.binder_id == binder_id,
            BinderCard.collection_item_id.is_(None),
        ).first()
        if not bc or bc.card_id == target_card_id:
            skipped += 1
            continue

        existing = db.query(BinderCard).filter(
            BinderCard.binder_id == binder_id,
            BinderCard.card_id == target_card_id,
            BinderCard.collection_item_id.is_(None),
            BinderCard.id != bc.id,
        ).first()
        if existing:
            combined_quantity = (existing.required_quantity or 1) + (bc.required_quantity or 1)
            if combined_quantity > 99:
                skipped += 1
                continue
            existing.required_quantity = combined_quantity
            db.delete(bc)
            applied += 1
            applied_total_savings += recommendation["total_savings"]
            continue

        bc.card_id = target_card_id
        applied += 1
        applied_total_savings += recommendation["total_savings"]

    db.commit()
    return {
        "message": "Print optimization applied",
        "applied": applied,
        "skipped": skipped,
        "total_savings": round(applied_total_savings, 2),
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
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") == "collection":
        raise HTTPException(status_code=400, detail="Collection binders require an exact owned collection item")

    binder_type = binder.binder_type or "collection"
    ensure_card_exists(db, card_id)
    binder = _relock_binder_for_write(
        db, binder_id, current_user.id, binder_type
    )
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
    quantity: int = 1,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add an exact collection item to a binder, preserving variant/condition."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "collection":
        raise HTTPException(status_code=400, detail="Collection items can only be added to collection binders")

    item = (
        db.query(CollectionItem)
        .join(Card, Card.id == CollectionItem.card_id)
        .filter(
            CollectionItem.id == collection_item_id,
            CollectionItem.user_id == current_user.id,
            visible_card_filter(db, current_user.id, "all"),
        )
        .with_for_update(of=CollectionItem)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    quantity = _safe_required_quantity(quantity)
    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.collection_item_id == collection_item_id,
    ).first()
    usage_count = _collection_binder_usage_counts(db, current_user).get(collection_item_id, 0)
    if usage_count + quantity > int(item.quantity or 0):
        available = max(int(item.quantity or 0) - usage_count, 0)
        raise HTTPException(status_code=409, detail=f"Only {available} unallocated copie(s) remain for this collection item")

    if existing:
        next_quantity = stored_binder_quantity(existing.required_quantity) + quantity
        if next_quantity > 99:
            raise HTTPException(status_code=422, detail="Required quantity must be between 1 and 99")
        existing.required_quantity = next_quantity
        db.commit()
        return {
            "message": "Collection binder quantity updated",
            "required_quantity": next_quantity,
            "available_quantity": int(item.quantity or 0) - usage_count - quantity,
        }

    bc = BinderCard(
        binder_id=binder_id,
        card_id=item.card_id,
        collection_item_id=collection_item_id,
        required_quantity=quantity,
        added_at=datetime.datetime.utcnow(),
    )
    db.add(bc)
    db.commit()
    return {
        "message": "Collection item added to binder",
        "required_quantity": quantity,
        "available_quantity": int(item.quantity or 0) - usage_count - quantity,
    }


def _resolve_owned_set(db: Session, current_user: User, set_id: str) -> Set:
    set_obj = db.query(Set).filter(
        Set.id == set_id,
        visible_set_filter(db, current_user.id, "all"),
    ).first()
    if not set_obj:
        raise HTTPException(status_code=404, detail="Set not found")
    return set_obj


def _add_owned_set_entries(
    db: Session,
    current_user: User,
    binder: Binder,
    set_obj: Set,
) -> dict:
    """Add owned set entries while holding collection-item allocation locks."""
    tcg_id = set_obj.tcg_set_id or set_obj.id
    set_lang = set_obj.lang or "en"

    owned_items = (
        db.query(CollectionItem)
        .join(Card, Card.id == CollectionItem.card_id)
        .filter(
            CollectionItem.user_id == current_user.id,
            Card.set_id == tcg_id,
            Card.lang == set_lang,
            CollectionItem.quantity > 0,
            visible_card_filter(db, current_user.id, "all"),
        )
        .order_by(CollectionItem.id.asc())
        .with_for_update(of=CollectionItem)
        .all()
    )

    # The row locks above serialize capacity checks for every exact owned item.
    # A concurrent request will wait, then observe entries committed by the
    # first request before deciding whether another copy is available.
    usage_counts = _collection_binder_usage_counts(db, current_user)
    existing_item_ids = {
        item_id for (item_id,) in db.query(BinderCard.collection_item_id).filter(
            BinderCard.binder_id == binder.id,
            BinderCard.collection_item_id.isnot(None),
        ).all()
    }

    added = 0
    skipped_present = 0
    skipped_no_capacity = 0
    for item in owned_items:
        if item.id in existing_item_ids:
            skipped_present += 1
            continue
        available_quantity = max(int(item.quantity or 0) - int(usage_counts.get(item.id, 0) or 0), 0)
        if available_quantity < 1:
            skipped_no_capacity += 1
            continue
        db.add(BinderCard(
            binder_id=binder.id,
            card_id=item.card_id,
            collection_item_id=item.id,
            required_quantity=min(available_quantity, 99),
            added_at=datetime.datetime.utcnow(),
        ))
        added += 1

    return {
        "added": added,
        "skipped_present": skipped_present,
        "skipped_no_capacity": skipped_no_capacity,
        "owned_total": len(owned_items),
    }


@router.post("/add-owned-set")
def add_owned_set_to_auto_binder(
    set_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atomically create or reuse the set's auto-named collection binder."""
    # Serialize auto-binder creation for this user across tabs/devices.
    db.query(User.id).filter(User.id == current_user.id).with_for_update().one()
    set_obj = _resolve_owned_set(db, current_user, set_id)
    binder_name = f"{set_obj.name or set_id} (owned)"
    binder = db.query(Binder).filter(
        Binder.user_id == current_user.id,
        Binder.auto_owned_set_id == set_obj.id,
        or_(Binder.binder_type == "collection", Binder.binder_type.is_(None)),
    ).order_by(Binder.id.asc()).first()

    created = binder is None
    if created:
        binder = Binder(
            name=binder_name,
            user_id=current_user.id,
            binder_type="collection",
            color="#EE1515",
            auto_owned_set_id=set_obj.id,
            created_at=datetime.datetime.utcnow(),
        )
        db.add(binder)
        db.flush()

    result = _add_owned_set_entries(db, current_user, binder, set_obj)
    db.commit()
    return {**result, "binder_id": binder.id, "binder_created": created}


@router.post("/{binder_id}/add-owned-set")
def add_owned_set_to_binder(
    binder_id: int,
    set_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bulk-add every owned collection item from a set into a collection binder.

    One entry per owned collection item (variant); copies of a variant stack into
    that single entry. Skips items already in this binder, and items whose copies
    are all allocated across collection binders.
    """
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "collection":
        raise HTTPException(status_code=400, detail="Owned cards can only be added to collection binders")

    set_obj = _resolve_owned_set(db, current_user, set_id)
    result = _add_owned_set_entries(db, current_user, binder, set_obj)
    db.commit()
    return result


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
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not bc:
        raise HTTPException(status_code=404, detail="Binder entry not found")
    next_quantity = _safe_required_quantity(update.required_quantity)
    if (binder.binder_type or "collection") == "collection":
        if not bc.collection_item_id:
            raise HTTPException(status_code=409, detail="This legacy binder entry is not linked to an exact collection item")
        item = db.query(CollectionItem).filter(
            CollectionItem.id == bc.collection_item_id,
            CollectionItem.user_id == current_user.id,
        ).with_for_update(of=CollectionItem).first()
        if not item:
            raise HTTPException(status_code=404, detail="Collection item not found")
        db.refresh(bc)
        if bc.collection_item_id != item.id:
            raise HTTPException(status_code=409, detail="Binder entry changed while it was being updated; please try again")
        allocated_elsewhere = _collection_binder_usage_counts(db, current_user).get(item.id, 0) - stored_binder_quantity(bc.required_quantity)
        if allocated_elsewhere + next_quantity > int(item.quantity or 0):
            maximum = max(int(item.quantity or 0) - allocated_elsewhere, 0)
            raise HTTPException(status_code=409, detail=f"At most {maximum} copie(s) can be assigned to this binder")

    bc.required_quantity = next_quantity
    db.commit()
    return {"message": "Binder entry updated"}


@router.get("/{binder_id}/entries/{binder_card_id}/equivalent-prints")
def get_binder_entry_equivalent_prints(
    binder_id: int,
    binder_card_id: int,
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return playable-equivalent prints for one binder entry, owned first then cheapest."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    binder_type = binder.binder_type or "collection"
    price_field = normalize_price_field(price_field)

    bc = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).options(joinedload(BinderCard.card)).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not bc or not bc.card:
        raise HTTPException(status_code=404, detail="Binder entry not found")

    source_card = _ensure_card_gameplay_data(db, bc.card)
    if not source_card or not source_card.playable_fingerprint:
        return {"source_card_id": bc.card_id, "equivalents": [], "message": "No playable fingerprint available"}

    collection_quantities = dict(
        db.query(CollectionItem.card_id, func.coalesce(func.sum(CollectionItem.quantity), 0))
        .filter(CollectionItem.user_id == current_user.id)
        .group_by(CollectionItem.card_id)
        .all()
    )

    if binder_type == "collection":
        usage_counts = _collection_binder_usage_counts(db, current_user)
        collection_items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
            joinedload(CollectionItem.card).joinedload(Card.set_ref)
        ).filter(
            CollectionItem.user_id == current_user.id,
            Card.name == source_card.name,
            Card.lang == (source_card.lang or "en"),
            Card.is_custom.is_(False),
            visible_card_filter(db, current_user.id, "all"),
        ).all()

        summaries = []
        for item in collection_items:
            card = _ensure_card_gameplay_data(db, item.card)
            if not card or card.playable_fingerprint != source_card.playable_fingerprint:
                continue
            is_current = item.id == bc.collection_item_id
            used_quantity = int(usage_counts.get(item.id, 0) or 0)
            available_quantity = max(int(item.quantity or 0) - used_quantity, 0)
            summaries.append(_binder_card_summary(
                card,
                owned_quantity=item.quantity or 0,
                is_current=is_current,
                collection_item=item,
                available_quantity=available_quantity,
                price_field=price_field,
            ))
        summaries.sort(key=lambda item: (
            not item["is_current"],
            item.get("available_quantity", 0) <= 0,
            item["price_market"] <= 0,
            item["price_market"] if item["price_market"] > 0 else 999999,
            item["set_name"] or item["set_id"] or "",
            item["number"] or "",
        ))
        return {"source_card_id": bc.card_id, "scope": "collection", "equivalents": summaries}

    if binder_type != "wishlist":
        raise HTTPException(status_code=400, detail="Equivalent prints are available for collection and wishlist binders")

    collection_quantities = _available_collection_card_quantities(
        db,
        current_user,
        list(collection_quantities),
        owned_quantities=collection_quantities,
    )

    _cache_same_name_cards_for_equivalents(db, source_card)
    source_card = db.query(Card).filter(Card.id == source_card.id).first()
    if not source_card or not source_card.playable_fingerprint:
        return {"source_card_id": bc.card_id, "equivalents": [], "message": "No playable fingerprint available"}

    candidates = db.query(Card).options(joinedload(Card.set_ref)).filter(
        Card.playable_fingerprint == source_card.playable_fingerprint,
        Card.lang == (source_card.lang or "en"),
        Card.is_custom.is_(False),
        visible_card_filter(db, current_user.id, "all"),
    ).all()

    summaries = [
        _binder_card_summary(
            card,
            owned_quantity=collection_quantities.get(card.id, 0),
            is_current=card.id == bc.card_id,
            price_field=price_field,
        )
        for card in candidates
    ]
    summaries.sort(key=lambda item: (
        not item["owned"],
        item["price_market"] <= 0,
        item["price_market"] if item["price_market"] > 0 else 999999,
        item["set_name"] or item["set_id"] or "",
        item["number"] or "",
    ))

    return {"source_card_id": bc.card_id, "scope": "wishlist", "equivalents": summaries}


@router.put("/{binder_id}/entries/{binder_card_id}/card")
def switch_binder_entry_card(
    binder_id: int,
    binder_card_id: int,
    update: BinderCardSwitch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Manually switch a wishlist binder entry to a playable-equivalent print."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).with_for_update(of=Binder).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    binder_type = binder.binder_type or "collection"
    if binder_type not in {"collection", "wishlist"}:
        raise HTTPException(status_code=400, detail="Equivalent print switching is available for collection and wishlist binders")

    bc = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).options(joinedload(BinderCard.card)).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not bc or not bc.card:
        raise HTTPException(status_code=404, detail="Binder entry not found")

    if binder_type == "collection":
        if not update.collection_item_id:
            raise HTTPException(status_code=400, detail="Collection print switching requires a collection item")
        target_item = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(joinedload(CollectionItem.card)).filter(
            CollectionItem.id == update.collection_item_id,
            CollectionItem.user_id == current_user.id,
            visible_card_filter(db, current_user.id, "all"),
        ).first()
        if not target_item or not target_item.card:
            raise HTTPException(status_code=404, detail="Collection item not found")
        if update.card_id and update.card_id != target_item.card_id:
            raise HTTPException(status_code=400, detail="Selected card does not match the collection item")

        source_card = _ensure_card_gameplay_data(db, bc.card)
        target_card = _ensure_card_gameplay_data(db, target_item.card)
        if not source_card or not target_card or not source_card.playable_fingerprint or not target_card.playable_fingerprint:
            raise HTTPException(status_code=400, detail="Playable card data is not available for this switch")
        if source_card.playable_fingerprint != target_card.playable_fingerprint:
            raise HTTPException(status_code=400, detail="Selected card is not a playable-equivalent print")

        binder = _relock_binder_for_write(
            db, binder_id, current_user.id, binder_type
        )
        bc = db.query(BinderCard).filter(
            BinderCard.id == binder_card_id,
            BinderCard.binder_id == binder_id,
            BinderCard.collection_item_id.isnot(None),
        ).populate_existing().first()
        target_item = db.query(CollectionItem).filter(
            CollectionItem.id == update.collection_item_id,
            CollectionItem.user_id == current_user.id,
        ).populate_existing().first()
        if not bc or not target_item:
            raise HTTPException(status_code=409, detail="Binder entry changed while switching prints; please try again")
        if target_item.id == bc.collection_item_id:
            return {"message": "Binder entry already uses this print", "binder_card_id": bc.id, "merged": False}

        source_item_id = bc.collection_item_id
        locked_items = db.query(CollectionItem).filter(
            CollectionItem.id.in_([source_item_id, target_item.id]),
            CollectionItem.user_id == current_user.id,
        ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()
        locked_by_id = {item.id: item for item in locked_items}
        target_item = locked_by_id.get(target_item.id)
        if not target_item or source_item_id not in locked_by_id:
            raise HTTPException(status_code=409, detail="Collection item changed while switching prints")
        db.refresh(bc)
        if bc.collection_item_id != source_item_id:
            raise HTTPException(status_code=409, detail="Binder entry changed while switching prints; please try again")

        assigned_quantity = stored_binder_quantity(bc.required_quantity)
        existing = db.query(BinderCard).filter(
            BinderCard.binder_id == binder_id,
            BinderCard.collection_item_id == target_item.id,
            BinderCard.id != bc.id,
        ).first()
        if existing:
            combined_quantity = stored_binder_quantity(existing.required_quantity) + assigned_quantity
            if combined_quantity > 99:
                raise HTTPException(status_code=422, detail="Required quantity must be between 1 and 99")
            usage_count = _collection_binder_usage_counts(db, current_user).get(target_item.id, 0)
            if usage_count + assigned_quantity > int(target_item.quantity or 0):
                raise HTTPException(status_code=409, detail="Not enough unallocated copies of this print are available")
            existing.required_quantity = combined_quantity
            db.delete(bc)
            db.commit()
            return {"message": "Binder entries merged", "binder_card_id": existing.id, "merged": True}

        owned_quantity = int(target_item.quantity or 0)
        usage_count = _collection_binder_usage_counts(db, current_user).get(target_item.id, 0)
        if usage_count + assigned_quantity > owned_quantity:
            raise HTTPException(status_code=409, detail="Not enough unallocated copies of this print are available")

        bc.card_id = target_item.card_id
        bc.collection_item_id = target_item.id
        bc.required_quantity = assigned_quantity
        db.commit()
        return {"message": "Binder entry switched", "binder_card_id": bc.id, "merged": False}

    if not update.card_id:
        raise HTTPException(status_code=400, detail="Card id is required")

    target_card = db.query(Card).filter(
        Card.id == update.card_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not target_card:
        _, detected_lang = pokemon_api.strip_lang_suffix(update.card_id)
        target_card = ensure_card_exists(db, update.card_id, lang=detected_lang or "en")

    source_card = _ensure_card_gameplay_data(db, bc.card)
    target_card = _ensure_card_gameplay_data(db, target_card)
    if not source_card or not target_card or not source_card.playable_fingerprint or not target_card.playable_fingerprint:
        raise HTTPException(status_code=400, detail="Playable card data is not available for this switch")
    if source_card.playable_fingerprint != target_card.playable_fingerprint:
        raise HTTPException(status_code=400, detail="Selected card is not a playable-equivalent print")

    binder = _relock_binder_for_write(
        db, binder_id, current_user.id, binder_type
    )
    bc = db.query(BinderCard).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
        BinderCard.collection_item_id.is_(None),
    ).populate_existing().first()
    if not bc:
        raise HTTPException(status_code=409, detail="Binder entry changed while switching prints; please try again")
    if target_card.id == bc.card_id:
        return {"message": "Binder entry already uses this print", "binder_card_id": bc.id, "merged": False}

    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.card_id == target_card.id,
        BinderCard.collection_item_id.is_(None),
        BinderCard.id != bc.id,
    ).first()
    if existing:
        combined_quantity = (existing.required_quantity or 1) + (bc.required_quantity or 1)
        if combined_quantity > 99:
            raise HTTPException(status_code=400, detail="Switching would exceed the maximum required quantity of 99")
        existing.required_quantity = combined_quantity
        db.delete(bc)
        db.commit()
        return {"message": "Binder entries merged", "binder_card_id": existing.id, "merged": True}

    bc.card_id = target_card.id
    db.commit()
    return {"message": "Binder entry switched", "binder_card_id": bc.id, "merged": False}


@router.post("/{binder_id}/entries/{binder_card_id}/wishlist")
def add_binder_entry_to_wishlist(
    binder_id: int,
    binder_card_id: int,
    quantity: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a binder card to the user's global wishlist if the user still needs copies."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    bc = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not bc:
        raise HTTPException(status_code=404, detail="Binder entry not found")

    plan = None
    if (binder.binder_type or "collection") == "wishlist":
        required_quantity = _safe_required_quantity(bc.required_quantity)
        owned_quantities = _available_collection_card_quantities(db, current_user, [bc.card_id])
        wishlist_quantities = _user_wishlist_quantities(db, current_user, [bc.card_id])
        plan = plan_missing_wishlist_additions(
            [(bc.card_id, required_quantity)],
            owned_quantities,
            wishlist_quantities,
        )

        if not plan.additions:
            message = "Card already in wishlist" if plan.skipped_existing else "Card already complete in collection"
            return {
                "message": message,
                "added": 0,
                "added_copies": 0,
                "skipped": plan.skipped,
                "skipped_complete": plan.skipped_complete,
                "skipped_existing": plan.skipped_existing,
                "missing_copies": plan.missing_copies,
                "wishlist_copies": plan.wishlist_copies,
            }
    else:
        requested_quantity = _safe_required_quantity(quantity) if quantity is not None else 1
        existing = db.query(WishlistItem).filter(
            WishlistItem.card_id == bc.card_id,
            WishlistItem.user_id == current_user.id,
        ).first()
        if existing:
            current_quantity = max(int(existing.quantity or 1), 1)
            next_quantity = min(99, current_quantity + requested_quantity)
            actual_added = next_quantity - current_quantity
            if actual_added <= 0:
                return {
                    "message": "Card already in wishlist",
                    "added": 0,
                    "added_copies": 0,
                    "skipped": 1,
                    "skipped_complete": 0,
                    "skipped_existing": 1,
                    "missing_copies": 0,
                    "wishlist_copies": current_quantity,
                }
            existing.quantity = next_quantity
            db.commit()
            return {
                "message": "Wishlist quantity updated",
                "added": 1,
                "added_copies": actual_added,
                "skipped": 0,
                "skipped_complete": 0,
                "skipped_existing": 0,
                "missing_copies": 0,
                "wishlist_copies": next_quantity,
            }

    missing_copies = plan.missing_copies if plan else 0
    wishlist_copies = plan.wishlist_copies if plan else 0

    try:
        if plan:
            added, added_copies = _apply_wishlist_additions(db, current_user, plan.additions)
        else:
            db.add(WishlistItem(
                card_id=bc.card_id,
                quantity=requested_quantity,
                user_id=current_user.id,
                created_at=datetime.datetime.utcnow(),
            ))
            added = 1
            added_copies = requested_quantity
        db.commit()
    except IntegrityError:
        db.rollback()
        return {
            "message": "Card already in wishlist",
            "added": 0,
            "added_copies": 0,
            "skipped": 1,
            "skipped_complete": 0,
            "skipped_existing": 1,
            "missing_copies": missing_copies,
            "wishlist_copies": wishlist_copies,
        }
    return {
        "message": "Card added to wishlist",
        "added": added,
        "added_copies": added_copies,
        "skipped": 0,
        "skipped_complete": 0,
        "skipped_existing": 0,
        "missing_copies": missing_copies,
        "wishlist_copies": wishlist_copies,
    }


@router.post("/{binder_id}/wishlist")
def add_binder_cards_to_wishlist(
    binder_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add only missing cards from a wishlist binder to the user's global wishlist."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") != "wishlist":
        raise HTTPException(status_code=400, detail="Bulk wishlist add is only available for wishlist binders")

    binder_cards = db.query(BinderCard.card_id, BinderCard.required_quantity).join(
        Card, Card.id == BinderCard.card_id
    ).filter(
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).all()
    entries = []
    card_ids = []
    seen = set()
    for card_id, required_quantity in binder_cards:
        if not card_id:
            continue
        entries.append((card_id, _safe_required_quantity(required_quantity)))
        if card_id not in seen:
            seen.add(card_id)
            card_ids.append(card_id)

    if not card_ids:
        return {"added": 0, "added_copies": 0, "skipped": 0, "skipped_complete": 0, "skipped_existing": 0, "missing_copies": 0, "wishlist_copies": 0, "checked": 0}

    owned_quantities = _available_collection_card_quantities(db, current_user, card_ids)
    wishlist_quantities = _user_wishlist_quantities(db, current_user, card_ids)
    plan = plan_missing_wishlist_additions(entries, owned_quantities, wishlist_quantities)

    try:
        added, added_copies = _apply_wishlist_additions(db, current_user, plan.additions)
        db.commit()
    except IntegrityError:
        db.rollback()
        wishlist_quantities = _user_wishlist_quantities(db, current_user, card_ids)
        plan = plan_missing_wishlist_additions(entries, owned_quantities, wishlist_quantities)
        added, added_copies = _apply_wishlist_additions(db, current_user, plan.additions)
        db.commit()
    return {
        "added": added,
        "added_copies": added_copies,
        "skipped": plan.skipped,
        "skipped_complete": plan.skipped_complete,
        "skipped_existing": plan.skipped_existing,
        "missing_copies": plan.missing_copies,
        "wishlist_copies": plan.wishlist_copies,
        "checked": plan.checked,
    }


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

    rows = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).options(
        joinedload(BinderCard.card).joinedload(Card.set_ref),
        joinedload(BinderCard.collection_item),
    ).filter(
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(BinderCard.added_at.asc()).all()
    binder_type = binder.binder_type or "collection"

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=BINDER_CSV_COLUMNS)
    writer.writeheader()
    for entry in rows:
        card = entry.card
        if not card:
            continue
        if binder_type == "collection":
            if entry.collection_item_id:
                is_visible = db.query(CollectionItem.id).filter(
                    CollectionItem.id == entry.collection_item_id,
                    CollectionItem.user_id == current_user.id,
                ).first() is not None
            else:
                is_visible = db.query(CollectionItem.id).filter(
                    CollectionItem.card_id == entry.card_id,
                    CollectionItem.user_id == current_user.id,
                ).first() is not None
            if not is_visible:
                continue
        set_ref = card.set_ref
        writer.writerow({
            "set_code": (set_ref.abbreviation if set_ref and set_ref.abbreviation else card.set_id),
            "number": card.number,
            "required_quantity": _safe_required_quantity(entry.required_quantity),
            "lang": card.lang or "en",
            "variant": entry.collection_item.variant if entry.collection_item else "",
            "condition": entry.collection_item.condition if entry.collection_item else "",
            "collection_item_id": entry.collection_item_id or "",
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
    """Import binder entries from CSV, including exact physical metadata when available."""
    binder = db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == current_user.id,
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    binder_type = binder.binder_type or "collection"
    if binder_type == "collection":
        # Keep the same User -> Binder -> CollectionItem lock order used by
        # multi-item collection writes elsewhere.
        db.query(User.id).filter(User.id == current_user.id).with_for_update().one()
    binder = _relock_binder_for_write(
        db, binder_id, current_user.id, binder_type
    )
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
    if reader.fieldnames not in (BINDER_CSV_COLUMNS, BINDER_CSV_PHYSICAL_COLUMNS, BINDER_CSV_LEGACY_COLUMNS):
        raise HTTPException(
            status_code=422,
            detail=(
                "CSV header must be one of: "
                f"{','.join(BINDER_CSV_COLUMNS)}; "
                f"{','.join(BINDER_CSV_PHYSICAL_COLUMNS)}; or "
                f"{','.join(BINDER_CSV_LEGACY_COLUMNS)}"
            ),
        )

    added = 0
    updated = 0
    skipped = 0
    failed = 0
    errors: List[str] = []
    row_count = 0
    validated_rows = []
    planned_card_rows: dict[str, dict] = {}
    planned_collection_rows: dict[int, dict] = {}
    collection_item_usage_counts = _collection_binder_usage_counts(db, current_user)
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
            lang = normalize_tcgdex_language(row.get("lang") or "en")
            if not is_supported_tcgdex_language(lang):
                failed += 1
                errors.append(f"row {row_number}: lang must be one of: {', '.join(SUPPORTED_TCGDEX_LANGUAGES)}")
                continue
            if not set_code or not number:
                failed += 1
                errors.append(f"row {row_number}: set_code and number are required")
                continue
            try:
                required_quantity = _safe_required_quantity(row.get("required_quantity"))
            except HTTPException:
                failed += 1
                errors.append(f"row {row_number}: required_quantity must be a number between 1 and 99")
                continue
            try:
                card = _find_card_by_code(db, set_code, number, lang)
            except ValueError:
                failed += 1
                errors.append(f"row {row_number}: card was not found")
                continue

            if binder_type == "collection":
                owned_query = db.query(CollectionItem).filter(
                    CollectionItem.card_id == card.id,
                    CollectionItem.user_id == current_user.id,
                )
                requested_variant = (row.get("variant") or "").strip()
                requested_condition = (row.get("condition") or "").strip()
                requested_item_id = (row.get("collection_item_id") or "").strip()
                if requested_item_id:
                    try:
                        requested_item_id = int(requested_item_id)
                    except ValueError:
                        failed += 1
                        errors.append(f"row {row_number}: collection_item_id must be a positive integer")
                        continue
                    if requested_item_id < 1:
                        failed += 1
                        errors.append(f"row {row_number}: collection_item_id must be a positive integer")
                        continue
                    owned_query = owned_query.filter(CollectionItem.id == requested_item_id)
                if requested_variant:
                    owned_query = owned_query.filter(
                        CollectionItem.variant == normalize_collection_variant(requested_variant)
                    )
                if requested_condition:
                    owned_query = owned_query.filter(CollectionItem.condition == requested_condition)
                owned_items = owned_query.order_by(CollectionItem.id.asc()).all()
                if not owned_items:
                    skipped += 1
                    continue
                locked_usage = collection_binder_allocation_counts(
                    db,
                    current_user.id,
                    [item.id for item in owned_items],
                )
                collection_item_usage_counts.update(locked_usage)
                item_to_add = None
                for item in owned_items:
                    planned = planned_collection_rows.get(item.id)
                    planned_increment = int(planned.get("increment", 0)) if planned else 0
                    remaining = int(item.quantity or 0) - int(collection_item_usage_counts.get(item.id, 0) or 0) - planned_increment
                    if remaining >= required_quantity:
                        item_to_add = item
                        break
                if not item_to_add:
                    skipped += 1
                    continue
                planned = planned_collection_rows.get(item_to_add.id)
                if planned:
                    next_increment = planned["increment"] + required_quantity
                    next_quantity = planned["required_quantity"] + required_quantity
                    if next_quantity > 99:
                        failed += 1
                        errors.append(f"row {row_number}: {BINDER_CSV_DUPLICATE_QUANTITY_ERROR}")
                    else:
                        planned["increment"] = next_increment
                        planned["required_quantity"] = next_quantity
                    continue
                existing_entry = db.query(BinderCard).filter(
                    BinderCard.binder_id == binder_id,
                    BinderCard.collection_item_id == item_to_add.id,
                ).first()
                base_quantity = stored_binder_quantity(existing_entry.required_quantity) if existing_entry else 0
                next_quantity = base_quantity + required_quantity
                if next_quantity > 99:
                    failed += 1
                    errors.append(f"row {row_number}: {BINDER_CSV_DUPLICATE_QUANTITY_ERROR}")
                    continue
                planned = {
                    "action": "update_collection_item" if existing_entry else "add_collection_item",
                    "item": item_to_add,
                    "entry": existing_entry,
                    "increment": required_quantity,
                    "required_quantity": next_quantity,
                }
                planned_collection_rows[item_to_add.id] = planned
                validated_rows.append(planned)
                continue

            planned_row = planned_card_rows.get(card.id)
            if planned_row:
                try:
                    planned_row["required_quantity"] = combine_binder_required_quantity(
                        planned_row["required_quantity"],
                        required_quantity,
                    )
                    planned_row["increment"] += required_quantity
                except ValueError:
                    failed += 1
                    errors.append(f"row {row_number}: {BINDER_CSV_DUPLICATE_QUANTITY_ERROR}")
                continue

            existing = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id,
                BinderCard.card_id == card.id,
                BinderCard.collection_item_id.is_(None),
            ).first()
            if existing:
                try:
                    required_quantity = combine_binder_required_quantity(
                        _safe_required_quantity(existing.required_quantity),
                        required_quantity,
                    )
                except ValueError:
                    failed += 1
                    errors.append(f"row {row_number}: {BINDER_CSV_DUPLICATE_QUANTITY_ERROR}")
                    continue
                planned_row = {
                    "action": "update",
                    "entry": existing,
                    "increment": required_quantity - _safe_required_quantity(existing.required_quantity),
                    "required_quantity": required_quantity,
                }
            else:
                planned_row = {
                    "action": "add_card",
                    "card": card,
                    "increment": required_quantity,
                    "required_quantity": required_quantity,
                }
            planned_card_rows[card.id] = planned_row
            validated_rows.append(planned_row)
        except Exception:
            db.rollback()
            failed += 1
            logger.exception("Unexpected binder CSV validation error on row %s", row_number)
            errors.append(f"row {row_number}: unexpected import error")

    if failed:
        db.rollback()
        return {"added": 0, "updated": 0, "skipped": skipped, "failed": failed, "errors": errors}

    # Cache helpers used while parsing may commit. Start a clean final
    # transaction, then lock and revalidate every write in one stable order.
    db.rollback()
    if binder_type == "collection":
        db.query(User.id).filter(User.id == current_user.id).with_for_update().one()
    binder = _relock_binder_for_write(
        db, binder_id, current_user.id, binder_type
    )

    validated_rows = []
    if binder_type == "collection":
        item_ids = sorted(planned_collection_rows)
        locked_items = db.query(CollectionItem).filter(
            CollectionItem.id.in_(item_ids),
            CollectionItem.user_id == current_user.id,
        ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all() if item_ids else []
        locked_by_id = {item.id: item for item in locked_items}
        locked_usage = collection_binder_allocation_counts(
            db, current_user.id, item_ids
        )
        for item_id in item_ids:
            item = locked_by_id.get(item_id)
            planned = planned_collection_rows[item_id]
            increment = int(planned["increment"])
            existing = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id,
                BinderCard.collection_item_id == item_id,
            ).first()
            base_quantity = stored_binder_quantity(existing.required_quantity) if existing else 0
            next_quantity = base_quantity + increment
            available_quantity = int(item.quantity or 0) - int(locked_usage.get(item_id, 0) or 0) if item else 0
            if not item or increment > available_quantity or next_quantity > 99:
                db.rollback()
                return {
                    "added": 0,
                    "updated": 0,
                    "skipped": skipped,
                    "failed": 1,
                    "errors": ["collection availability changed during import; please try again"],
                }
            planned.update({
                "action": "update_collection_item" if existing else "add_collection_item",
                "item": item,
                "entry": existing,
                "required_quantity": next_quantity,
            })
            validated_rows.append(planned)
    else:
        for card_id, planned in planned_card_rows.items():
            increment = int(planned["increment"])
            existing = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id,
                BinderCard.card_id == card_id,
                BinderCard.collection_item_id.is_(None),
            ).first()
            base_quantity = _safe_required_quantity(existing.required_quantity) if existing else 0
            try:
                next_quantity = combine_binder_required_quantity(base_quantity, increment)
            except ValueError:
                db.rollback()
                return {
                    "added": 0,
                    "updated": 0,
                    "skipped": skipped,
                    "failed": 1,
                    "errors": [BINDER_CSV_DUPLICATE_QUANTITY_ERROR],
                }
            planned.update({
                "action": "update" if existing else "add_card",
                "entry": existing,
                "card": db.query(Card).filter(Card.id == card_id).one(),
                "required_quantity": next_quantity,
            })
            validated_rows.append(planned)

    try:
        for item in validated_rows:
            action = item["action"]
            if action == "add_collection_item":
                collection_item = item["item"]
                db.add(BinderCard(
                    binder_id=binder_id,
                    card_id=collection_item.card_id,
                    collection_item_id=collection_item.id,
                    required_quantity=item["required_quantity"],
                    added_at=datetime.datetime.utcnow(),
                ))
                added += 1
            elif action == "update_collection_item":
                item["entry"].required_quantity = item["required_quantity"]
                updated += 1
            elif action == "update":
                item["entry"].required_quantity = item["required_quantity"]
                updated += 1
            elif action == "add_card":
                card = item["card"]
                db.add(BinderCard(
                    binder_id=binder_id,
                    card_id=card.id,
                    required_quantity=item["required_quantity"],
                    added_at=datetime.datetime.utcnow(),
                ))
                added += 1
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Unexpected binder CSV write error")
        return {"added": 0, "updated": 0, "skipped": skipped, "failed": 1, "errors": ["write failed"]}

    return {"added": added, "updated": updated, "skipped": skipped, "failed": failed, "errors": errors}


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
    ).with_for_update(of=Binder).first()
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
    ).with_for_update(of=Binder).first()
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
