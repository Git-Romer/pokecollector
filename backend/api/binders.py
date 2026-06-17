from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload
from typing import List
from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, CollectionItem, User, WishlistItem
from schemas import BinderCreate, BinderUpdate, BinderResponse, BinderCardUpdate, BinderCardSwitch, BinderPrintOptimizationApply
from api.collection import ensure_card_exists, _find_card_by_code
from services import pokemon_api
from services.card_fallbacks import apply_cross_language_fallbacks
from services.card_upsert import upsert_card
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_card_filter
from services.binder_csv import BINDER_CSV_DUPLICATE_QUANTITY_ERROR, combine_binder_required_quantity
from services.wishlist_missing import plan_missing_wishlist_additions
from services.tcgdex_languages import SUPPORTED_TCGDEX_LANGUAGES, is_supported_tcgdex_language, normalize_tcgdex_language
import datetime
import csv
import io
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

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


def _collection_binder_usage_counts(db: Session, current_user: User) -> dict[int, int]:
    """Return how often each exact collection item is already used in collection binders."""
    return dict(
        db.query(BinderCard.collection_item_id, func.count(BinderCard.id))
        .join(Binder, Binder.id == BinderCard.binder_id)
        .filter(
            Binder.user_id == current_user.id,
            or_(Binder.binder_type == "collection", Binder.binder_type.is_(None)),
            BinderCard.collection_item_id.isnot(None),
        )
        .group_by(BinderCard.collection_item_id)
        .all()
    )


def _binder_counts(db: Session, binder: Binder) -> tuple[int, int]:
    binder_type = binder.binder_type or "collection"
    base_query = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).filter(
        BinderCard.binder_id == binder.id,
        visible_card_filter(db, binder.user_id, "all"),
    )
    unique_count = base_query.with_entities(func.count(func.distinct(BinderCard.card_id))).scalar() or 0
    if binder_type == "collection":
        total_count = base_query.with_entities(func.count(BinderCard.id)).scalar() or 0
    else:
        total_count = base_query.with_entities(func.coalesce(func.sum(func.coalesce(BinderCard.required_quantity, 1)), 0)).scalar() or 0
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
    price_field: str | None = "price_trend",
) -> list[tuple[CollectionItem, Card, float]]:
    """Return cheaper owned playable-equivalent collection items for collection binders."""
    usage_counts = _collection_binder_usage_counts(db, current_user)
    excluded_collection_item_ids = excluded_collection_item_ids or set()
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
        available_quantity = max(int(item.quantity or 0) - used_quantity, 0)
        if available_quantity < 1:
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
    current_binder_collection_item_ids = {
        bc.collection_item_id for bc in binder_cards if bc.collection_item_id is not None
    }
    used_suggested_collection_item_ids: set[int] = set()
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
            candidates = _collection_optimizer_candidates(
                db,
                current_user,
                source_card,
                source_item.id,
                current_binder_collection_item_ids | used_suggested_collection_item_ids,
                price_field,
            )
            cheaper_candidates = [item for item in candidates if item[2] < current_price]
            if not cheaper_candidates:
                continue
            target_item, candidate, suggested_price = min(
                cheaper_candidates,
                key=lambda item: (item[2], item[1].set_id or "", item[1].number or "", item[0].id),
            )
            used_suggested_collection_item_ids.add(target_item.id)
            required_quantity = 1
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
        requested_type = update.binder_type or "collection"
        current_type = binder.binder_type or "collection"
        if requested_type != current_type:
            has_cards = db.query(BinderCard.id).filter(BinderCard.binder_id == binder_id).first() is not None
            if has_cards:
                raise HTTPException(status_code=400, detail="Binder type cannot be changed after cards are added")
        binder.binder_type = update.binder_type
    if "format" in update.model_fields_set:
        binder.format = _clean_binder_format(update.format)
    if "icon_pokemon_id" in update.model_fields_set:
        binder.icon_pokemon_id = update.icon_pokemon_id

    db.commit()
    db.refresh(binder)
    total_count, unique_count = _binder_counts(db, binder)
    return _binder_response(binder, total_count, unique_count)


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
        col_item = None
        if bc.collection_item_id:
            col_item = bc.collection_item if bc.collection_item and bc.collection_item.user_id == current_user.id else None
        if not col_item:
            col_item = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
                CollectionItem.card_id == bc.card_id,
                CollectionItem.user_id == current_user.id,
                visible_card_filter(db, current_user.id, "all"),
            ).first()
        in_collection = col_item is not None

        # For collection binder, skip cards not in collection
        if binder_type == "collection" and not in_collection:
            continue

        required_quantity = 1 if binder_type == "collection" and bc.collection_item_id else _safe_required_quantity(bc.required_quantity)
        owned_quantity = 1 if binder_type == "collection" and bc.collection_item_id and col_item else int(collection_quantities.get(bc.card_id, 0) or 0)
        fulfilled_quantity = min(owned_quantity, required_quantity)
        missing_quantity = max(required_quantity - owned_quantity, 0)
        price = effective_market_price(bc.card, col_item.variant if col_item else None, price_field) or 0

        total_required_count += required_quantity
        owned_count += fulfilled_quantity
        missing_count += missing_quantity
        binder_value += price * (owned_quantity if binder_type == "collection" else required_quantity)
        current_value += price * (owned_quantity if binder_type == "collection" else fulfilled_quantity)
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
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")

    preview = _build_print_optimization_preview(db, binder, current_user, price_field)
    selected_ids = None
    if update and update.selected_binder_card_ids is not None:
        selected_ids = set(update.selected_binder_card_ids)
    applied = 0
    skipped = 0
    applied_total_savings = 0.0
    binder_type = binder.binder_type or "collection"
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
            target_item = db.query(CollectionItem).filter(
                CollectionItem.id == target_collection_item_id,
                CollectionItem.user_id == current_user.id,
            ).first()
            if not target_item:
                skipped += 1
                continue
            existing = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id,
                BinderCard.collection_item_id == target_item.id,
                BinderCard.id != bc.id,
            ).first()
            if existing:
                skipped += 1
                continue
            usage_count = _collection_binder_usage_counts(db, current_user).get(target_item.id, 0)
            if int(target_item.quantity or 0) < 1 or usage_count >= int(target_item.quantity or 0):
                skipped += 1
                continue
            bc.card_id = target_item.card_id
            bc.collection_item_id = target_item.id
            bc.required_quantity = 1
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
    ).first()
    if not binder:
        raise HTTPException(status_code=404, detail="Binder not found")
    if (binder.binder_type or "collection") == "collection":
        raise HTTPException(status_code=400, detail="Collection binders require an exact owned collection item")

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

    item = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
        CollectionItem.id == collection_item_id,
        CollectionItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Collection item not found")

    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder_id,
        BinderCard.collection_item_id == collection_item_id,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Collection item already in binder")

    usage_count = _collection_binder_usage_counts(db, current_user).get(collection_item_id, 0)
    if usage_count >= (item.quantity or 1):
        raise HTTPException(status_code=400, detail="All owned copies of this card are already used in collection binders")

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

    bc = db.query(BinderCard).join(Card, Card.id == BinderCard.card_id).filter(
        BinderCard.id == binder_card_id,
        BinderCard.binder_id == binder_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not bc:
        raise HTTPException(status_code=404, detail="Binder entry not found")
    if (binder.binder_type or "collection") == "collection":
        raise HTTPException(status_code=400, detail="Collection binder quantities come from owned collection items")

    bc.required_quantity = _safe_required_quantity(update.required_quantity)
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
    ).first()
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
        if target_item.id == bc.collection_item_id:
            return {"message": "Binder entry already uses this print", "binder_card_id": bc.id, "merged": False}

        existing = db.query(BinderCard).filter(
            BinderCard.binder_id == binder_id,
            BinderCard.collection_item_id == target_item.id,
            BinderCard.id != bc.id,
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Selected collection item is already in this binder")

        owned_quantity = int(target_item.quantity or 0)
        usage_count = _collection_binder_usage_counts(db, current_user).get(target_item.id, 0)
        if owned_quantity < 1 or usage_count >= owned_quantity:
            raise HTTPException(status_code=400, detail="All owned copies of this print are already used in collection binders")

        bc.card_id = target_item.card_id
        bc.collection_item_id = target_item.id
        bc.required_quantity = 1
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
        owned_quantities = _user_collection_quantities(db, current_user, [bc.card_id])
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

    owned_quantities = _user_collection_quantities(db, current_user, card_ids)
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
        joinedload(BinderCard.card).joinedload(Card.set_ref)
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
    skipped = 0
    failed = 0
    errors: List[str] = []
    row_count = 0
    binder_type = binder.binder_type or "collection"
    validated_rows = []
    planned_card_rows: dict[str, dict] = {}
    collection_item_usage_counts = _collection_binder_usage_counts(db, current_user)
    current_binder_collection_item_ids = {
        item_id for (item_id,) in db.query(BinderCard.collection_item_id)
        .filter(
            BinderCard.binder_id == binder_id,
            BinderCard.collection_item_id.isnot(None),
        )
        .all()
    }

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
                owned_items = db.query(CollectionItem).filter(
                    CollectionItem.card_id == card.id,
                    CollectionItem.user_id == current_user.id,
                ).order_by(CollectionItem.id.asc()).all()
                if not owned_items:
                    skipped += 1
                    continue
                item_to_add = next(
                    (
                        item for item in owned_items
                        if item.id not in current_binder_collection_item_ids
                        and collection_item_usage_counts.get(item.id, 0) < (item.quantity or 1)
                    ),
                    None,
                )
                if not item_to_add:
                    skipped += 1
                    continue
                current_binder_collection_item_ids.add(item_to_add.id)
                collection_item_usage_counts[item_to_add.id] = collection_item_usage_counts.get(item_to_add.id, 0) + 1
                validated_rows.append({"action": "add_collection_item", "item": item_to_add})
                continue

            planned_row = planned_card_rows.get(card.id)
            if planned_row:
                try:
                    planned_row["required_quantity"] = combine_binder_required_quantity(
                        planned_row["required_quantity"],
                        required_quantity,
                    )
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
                planned_row = {"action": "update", "entry": existing, "required_quantity": required_quantity}
            else:
                planned_row = {"action": "add_card", "card": card, "required_quantity": required_quantity}
            planned_card_rows[card.id] = planned_row
            validated_rows.append(planned_row)
        except Exception:
            db.rollback()
            failed += 1
            logger.exception("Unexpected binder CSV validation error on row %s", row_number)
            errors.append(f"row {row_number}: unexpected import error")

    if failed:
        return {"added": 0, "updated": 0, "skipped": skipped, "failed": failed, "errors": errors}

    try:
        for item in validated_rows:
            action = item["action"]
            if action == "add_collection_item":
                collection_item = item["item"]
                db.add(BinderCard(
                    binder_id=binder_id,
                    card_id=collection_item.card_id,
                    collection_item_id=collection_item.id,
                    required_quantity=1,
                    added_at=datetime.datetime.utcnow(),
                ))
                added += 1
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
