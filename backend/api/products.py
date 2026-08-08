import datetime
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from database import get_db
from models import Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, User
from schemas import (
    ProductCardBulkLinkCreate,
    ProductCardLinkCreate,
    ProductCardResponse,
    ProductCardSaleCreate,
    ProductLedgerEntryCreate,
    ProductLedgerEntryResponse,
    ProductLifecycleBulkUpdate,
    ProductPurchaseCreate,
    ProductPurchaseResponse,
    ProductPurchaseUpdate,
)
from services.card_values import normalize_price_field
from services.binder_allocations import collection_item_allocated_quantity
from services.product_ledger import (
    entry_live_value,
    entry_realized_value,
    finite_non_negative,
    ledger_totals,
    positive_quantity,
    product_effective_value,
    product_has_completed_sale,
    product_lifecycle_status,
    sale_total_is_valid,
)

router = APIRouter()
logger = logging.getLogger(__name__)

PRODUCT_TYPES = ["Booster Pack", "Booster Box", "Elite Trainer Box", "Tin", "Bundle", "Collection Box", "Blister", "Other"]
PRODUCT_LINK_MAX_QUANTITY = 999


def _validate_money(value, field_name: str, *, required: bool = False) -> None:
    if value is None:
        if required:
            raise HTTPException(status_code=422, detail=f"{field_name} is required")
        return
    if not finite_non_negative(value):
        raise HTTPException(status_code=422, detail=f"{field_name} must be a finite, non-negative number")


def _validate_product_payload(product: ProductPurchaseCreate | ProductPurchaseUpdate) -> None:
    data = product.model_dump(exclude_unset=True)
    if "purchase_price" in data:
        _validate_money(data.get("purchase_price"), "purchase_price", required=True)
    if "current_value" in data:
        _validate_money(data.get("current_value"), "current_value")
    if "sold_price" in data:
        _validate_money(data.get("sold_price"), "sold_price")
    if "product_name" in data and data.get("product_name") is not None and not data.get("product_name", "").strip():
        raise HTTPException(status_code=422, detail="product_name cannot be blank")


def _validate_whole_product_sale(product) -> None:
    if getattr(product, "sold_date", None) is not None and not product_has_completed_sale(product):
        raise HTTPException(status_code=422, detail="sold_price is required when sold_date is set")


def _get_product_or_404(
    db: Session,
    current_user: User,
    product_id: int,
    *,
    lock: bool = False,
) -> ProductPurchase:
    query = db.query(ProductPurchase).filter(
        ProductPurchase.id == product_id,
        ProductPurchase.user_id == current_user.id,
    )
    if lock:
        query = query.with_for_update(of=ProductPurchase)
    product = query.first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


def _load_product_cards(db: Session, current_user: User, product_id: int) -> list[ProductCard]:
    return db.query(ProductCard).options(
        joinedload(ProductCard.card).joinedload(Card.set_ref),
        joinedload(ProductCard.ledger_entries).joinedload(ProductLedgerEntry.card).joinedload(Card.set_ref),
    ).filter(
        ProductCard.product_id == product_id,
        ProductCard.user_id == current_user.id,
    ).order_by(ProductCard.linked_at.asc(), ProductCard.id.asc()).all()


def _load_flat_ledger_entries(db: Session, current_user: User, product_id: int) -> list[ProductLedgerEntry]:
    return db.query(ProductLedgerEntry).options(
        joinedload(ProductLedgerEntry.card).joinedload(Card.set_ref),
    ).filter(
        ProductLedgerEntry.product_id == product_id,
        ProductLedgerEntry.user_id == current_user.id,
        ProductLedgerEntry.product_card_id.is_(None),
    ).order_by(ProductLedgerEntry.event_date.asc(), ProductLedgerEntry.id.asc()).all()


def _product_has_activity(db: Session, current_user: User, product_id: int) -> bool:
    has_cards = db.query(ProductCard.id).filter(
        ProductCard.product_id == product_id,
        ProductCard.user_id == current_user.id,
    ).first()
    if has_cards:
        return True
    return db.query(ProductLedgerEntry.id).filter(
        ProductLedgerEntry.product_id == product_id,
        ProductLedgerEntry.user_id == current_user.id,
    ).first() is not None


def _product_activity_ids(db: Session, current_user: User, product_ids: list[int]) -> set[int]:
    card_product_ids = db.query(ProductCard.product_id).filter(
        ProductCard.user_id == current_user.id,
        ProductCard.product_id.in_(product_ids),
    ).distinct().all()
    ledger_product_ids = db.query(ProductLedgerEntry.product_id).filter(
        ProductLedgerEntry.user_id == current_user.id,
        ProductLedgerEntry.product_id.in_(product_ids),
    ).distinct().all()
    return {row[0] for row in card_product_ids + ledger_product_ids}


def _validate_lifecycle_choice(
    product: ProductPurchase,
    lifecycle_status: str,
    has_activity: bool,
) -> None:
    if lifecycle_status == "sealed" and has_activity:
        raise HTTPException(status_code=409, detail="Products with linked-card or ledger history cannot be marked sealed")
    if product_has_completed_sale(product):
        raise HTTPException(status_code=409, detail="Clear the product sale before changing its lifecycle status")


def _ledger_entry_response(entry: ProductLedgerEntry) -> ProductLedgerEntryResponse:
    return ProductLedgerEntryResponse(
        id=entry.id,
        product_card_id=entry.product_card_id,
        product_id=entry.product_id,
        entry_type=entry.entry_type,
        card_id=entry.card_id,
        original_collection_item_id=entry.original_collection_item_id,
        quantity=entry.quantity,
        amount=round(float(entry.amount or 0), 2),
        event_date=entry.event_date,
        product_name=entry.product_name,
        card_name=entry.card_name,
        set_id=entry.set_id,
        card_number=entry.card_number,
        variant=entry.variant,
        condition=entry.condition,
        lang=entry.lang,
        notes=entry.notes,
        created_at=entry.created_at,
        card=entry.card,
    )


def _product_card_response(entry: ProductCard, price_field: str) -> ProductCardResponse:
    return ProductCardResponse(
        id=entry.id,
        product_id=entry.product_id,
        card_id=entry.card_id,
        collection_item_id=entry.collection_item_id,
        initial_quantity=entry.initial_quantity,
        active_quantity=entry.active_quantity,
        sold_quantity=entry.sold_quantity,
        condition=entry.condition,
        variant=entry.variant,
        lang=entry.lang,
        purchase_price=entry.purchase_price,
        linked_at=entry.linked_at,
        live_value=entry_live_value(entry, price_field),
        realized_gains=entry_realized_value(entry),
        card=entry.card,
        ledger_entries=[_ledger_entry_response(ledger_entry) for ledger_entry in entry.ledger_entries],
    )


def _product_response(
    product: ProductPurchase,
    product_cards: list[ProductCard],
    flat_ledger_entries: list[ProductLedgerEntry],
    price_field: str,
) -> ProductPurchaseResponse:
    effective_value, value_source, totals = product_effective_value(product, product_cards, price_field, flat_ledger_entries)
    pnl = None
    pnl_percent = None
    if effective_value is not None and value_source not in {"opened_unlinked", "needs_review"}:
        pnl = round(effective_value - product.purchase_price, 2)
        pnl_percent = round((pnl / product.purchase_price * 100) if product.purchase_price > 0 else 0, 2)

    return ProductPurchaseResponse(
        id=product.id,
        product_name=product.product_name,
        product_type=product.product_type,
        purchase_price=product.purchase_price,
        current_value=product.current_value,
        sold_price=product.sold_price,
        purchase_date=product.purchase_date,
        sold_date=product.sold_date,
        lifecycle_status=product_lifecycle_status(product, bool(product_cards or flat_ledger_entries)),
        notes=product.notes,
        created_at=product.created_at,
        pnl=pnl,
        pnl_percent=pnl_percent,
        value_source=value_source,
        linked_live_value=totals.live_cards_value,
        realized_gains=totals.realized_gains,
        computed_current_value=effective_value,
        linked_cards_count=totals.linked_cards_count,
        active_linked_cards_count=totals.active_cards_count,
        sold_linked_cards_count=totals.sold_cards_count,
        product_cards=[_product_card_response(entry, price_field) for entry in product_cards],
        ledger_entries=[_ledger_entry_response(entry) for entry in flat_ledger_entries],
    )


def _link_collection_items(
    db: Session,
    current_user: User,
    product: ProductPurchase,
    links: list[ProductCardLinkCreate],
) -> None:
    """Validate and link exact collection rows as one atomic operation."""
    collection_item_ids = [link.collection_item_id for link in links]
    if len(collection_item_ids) != len(set(collection_item_ids)):
        raise HTTPException(status_code=422, detail="Each collection item can only appear once")
    if any(not positive_quantity(link.quantity, PRODUCT_LINK_MAX_QUANTITY) for link in links):
        raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")

    collection_items = db.query(CollectionItem).options(joinedload(CollectionItem.card)).filter(
        CollectionItem.id.in_(collection_item_ids),
        CollectionItem.user_id == current_user.id,
    ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()
    if len(collection_items) != len(collection_item_ids):
        raise HTTPException(status_code=404, detail="One or more collection items were not found")

    linked_totals = dict(db.query(
        ProductCard.collection_item_id,
        func.coalesce(func.sum(ProductCard.active_quantity), 0),
    ).filter(
        ProductCard.user_id == current_user.id,
        ProductCard.collection_item_id.in_(collection_item_ids),
    ).group_by(ProductCard.collection_item_id).all())
    collection_items_by_id = {item.id: item for item in collection_items}
    for link in links:
        collection_item = collection_items_by_id[link.collection_item_id]
        available_quantity = max(
            int(collection_item.quantity or 0) - int(linked_totals.get(collection_item.id, 0) or 0),
            0,
        )
        if link.quantity > available_quantity:
            raise HTTPException(
                status_code=409,
                detail=f"Only {available_quantity} unlinked copies are available for collection item {collection_item.id}",
            )

    existing_rows = db.query(ProductCard).filter(
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
        ProductCard.collection_item_id.in_(collection_item_ids),
        ProductCard.sold_quantity == 0,
    ).all()
    existing_by_key = {
        (
            row.collection_item_id,
            row.card_id,
            row.variant,
            row.condition,
            row.lang,
            row.purchase_price,
        ): row
        for row in existing_rows
    }
    linked_at = datetime.datetime.utcnow()
    for link in links:
        collection_item = collection_items_by_id[link.collection_item_id]
        key = (
            collection_item.id,
            collection_item.card_id,
            collection_item.variant,
            collection_item.condition,
            collection_item.lang,
            collection_item.purchase_price,
        )
        existing = existing_by_key.get(key)
        if existing:
            existing.initial_quantity += link.quantity
            existing.active_quantity += link.quantity
            continue
        db.add(ProductCard(
            product_id=product.id,
            user_id=current_user.id,
            card_id=collection_item.card_id,
            collection_item_id=collection_item.id,
            initial_quantity=link.quantity,
            active_quantity=link.quantity,
            sold_quantity=0,
            condition=collection_item.condition,
            variant=collection_item.variant,
            lang=collection_item.lang,
            purchase_price=collection_item.purchase_price,
            linked_at=linked_at,
        ))

    product.lifecycle_status = "opened"


def _refresh_product_response(db: Session, current_user: User, product: ProductPurchase, price_field: str) -> ProductPurchaseResponse:
    product_cards = _load_product_cards(db, current_user, product.id)
    flat_ledger_entries = _load_flat_ledger_entries(db, current_user, product.id)
    return _product_response(product, product_cards, flat_ledger_entries, price_field)


@router.get("/types")
def get_product_types():
    """Get available product types."""
    return PRODUCT_TYPES


@router.get("/", response_model=List[ProductPurchaseResponse])
def get_products(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Get all product purchases with dynamic linked-card valuation fields."""
    price_field = normalize_price_field(price_field)
    products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == current_user.id
    ).order_by(
        ProductPurchase.purchase_date.desc()
    ).all()

    return [
        _refresh_product_response(db, current_user, product, price_field)
        for product in products
    ]


@router.post("/", response_model=ProductPurchaseResponse)
def create_product(
    product: ProductPurchaseCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Log a new product purchase."""
    _validate_product_payload(product)
    _validate_whole_product_sale(product)
    has_sale = product_has_completed_sale(product)
    if has_sale and product.lifecycle_status == "opened":
        raise HTTPException(status_code=409, detail="An opened product cannot also be sold as a sealed product")
    db_product = ProductPurchase(
        product_name=product.product_name.strip(),
        product_type=product.product_type,
        purchase_price=product.purchase_price,
        current_value=product.current_value,
        sold_price=product.sold_price,
        purchase_date=product.purchase_date,
        sold_date=product.sold_date,
        lifecycle_status=(
            "sold"
            if has_sale
            else product.lifecycle_status
        ),
        notes=product.notes,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_product)
    db.commit()
    db.refresh(db_product)
    return _refresh_product_response(db, current_user, db_product, "price_trend")


@router.put("/lifecycle/bulk")
def bulk_update_product_lifecycle(
    update: ProductLifecycleBulkUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Classify ambiguous legacy products transactionally."""
    product_ids = list(dict.fromkeys(update.product_ids))
    products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == current_user.id,
        ProductPurchase.id.in_(product_ids),
    ).with_for_update().all()
    if len(products) != len(product_ids):
        raise HTTPException(status_code=404, detail="One or more products were not found")

    if any(product.lifecycle_status != "review" for product in products):
        raise HTTPException(
            status_code=409,
            detail="One or more products were already classified. Refresh the page and try again.",
        )
    activity_ids = _product_activity_ids(db, current_user, product_ids)
    for product in products:
        has_activity = product.id in activity_ids
        _validate_whole_product_sale(product)
        _validate_lifecycle_choice(product, update.lifecycle_status, has_activity)
    for product in products:
        product.lifecycle_status = update.lifecycle_status

    db.commit()
    return {"updated": len(products), "lifecycle_status": update.lifecycle_status}


@router.put("/{product_id}", response_model=ProductPurchaseResponse)
def update_product(
    product_id: int,
    update: ProductPurchaseUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a product purchase."""
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    _validate_product_payload(update)

    update_data = update.model_dump(exclude_unset=True)
    requested_lifecycle = update_data.pop("lifecycle_status", None)
    previous_lifecycle = product.lifecycle_status
    for field, value in update_data.items():
        if field == "product_name" and value is not None:
            value = value.strip()
        setattr(product, field, value)

    _validate_whole_product_sale(product)
    has_activity = _product_has_activity(db, current_user, product.id)
    has_sale = product_has_completed_sale(product)
    if has_activity:
        if has_sale:
            raise HTTPException(
                status_code=409,
                detail="Products with linked-card or ledger history cannot also be sold as sealed products",
            )
        if requested_lifecycle == "sealed":
            raise HTTPException(status_code=409, detail="Products with linked-card or ledger history cannot be marked sealed")
        product.lifecycle_status = "opened"
    elif has_sale:
        if requested_lifecycle == "opened" or (
            requested_lifecycle is None and previous_lifecycle == "opened"
        ):
            raise HTTPException(status_code=409, detail="An opened product cannot also be sold as a sealed product")
        product.lifecycle_status = "sold"
    elif requested_lifecycle is not None:
        _validate_lifecycle_choice(product, requested_lifecycle, has_activity)
        product.lifecycle_status = requested_lifecycle
    elif previous_lifecycle == "sold":
        product.lifecycle_status = "review"

    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, "price_trend")


@router.delete("/{product_id}")
def delete_product(
    product_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an empty product purchase.

    Products with linked cards or realized ledger history are protected from
    accidental deletion so sold-card history is not silently erased.
    """
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    linked_count = db.query(ProductCard).filter(
        ProductCard.product_id == product_id,
        ProductCard.user_id == current_user.id,
    ).count()
    ledger_count = db.query(ProductLedgerEntry).filter(
        ProductLedgerEntry.product_id == product_id,
        ProductLedgerEntry.user_id == current_user.id,
    ).count()
    if linked_count or ledger_count:
        raise HTTPException(
            status_code=409,
            detail="Product has linked card or sale history and cannot be deleted. Unlink active cards first; sold history is kept permanently.",
        )

    db.delete(product)
    db.commit()
    return {"message": "Product deleted"}


@router.get("/summary")
def get_products_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Get product investment summary (broker-style P&L)."""
    price_field = normalize_price_field(price_field)
    products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == current_user.id
    ).all()

    product_responses = [
        _refresh_product_response(db, current_user, product, price_field)
        for product in products
    ]

    total_invested = sum(p.purchase_price for p in product_responses)
    total_current_value = sum(
        p.computed_current_value if p.computed_current_value is not None else p.purchase_price
        for p in product_responses
    )
    total_pnl = total_current_value - total_invested
    total_pnl_pct = (total_pnl / total_invested * 100) if total_invested > 0 else 0

    by_type = {}
    for p in product_responses:
        product_type = p.product_type or "Other"
        if product_type not in by_type:
            by_type[product_type] = {"invested": 0, "current": 0, "count": 0}
        by_type[product_type]["invested"] += p.purchase_price
        by_type[product_type]["current"] += p.computed_current_value if p.computed_current_value is not None else p.purchase_price
        by_type[product_type]["count"] += 1

    by_type_list = [
        {
            "type": product_type,
            "invested": round(values["invested"], 2),
            "current": round(values["current"], 2),
            "pnl": round(values["current"] - values["invested"], 2),
            "pnl_pct": round(((values["current"] - values["invested"]) / values["invested"] * 100) if values["invested"] > 0 else 0, 2),
            "count": values["count"],
        }
        for product_type, values in by_type.items()
    ]

    monthly = {}
    for p in product_responses:
        key = p.purchase_date.strftime("%Y-%m") if p.purchase_date else "Unknown"
        if key not in monthly:
            monthly[key] = {"invested": 0, "current": 0, "count": 0}
        monthly[key]["invested"] += p.purchase_price
        monthly[key]["current"] += p.computed_current_value if p.computed_current_value is not None else p.purchase_price
        monthly[key]["count"] += 1

    monthly_list = sorted([
        {
            "month": key,
            "invested": round(values["invested"], 2),
            "current": round(values["current"], 2),
            "pnl": round(values["current"] - values["invested"], 2),
            "count": values["count"],
        }
        for key, values in monthly.items()
    ], key=lambda item: item["month"])

    return {
        "total_invested": round(total_invested, 2),
        "total_current_value": round(total_current_value, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl_pct, 2),
        "total_products": len(product_responses),
        "needs_review_count": sum(p.lifecycle_status == "review" for p in product_responses),
        "linked_live_value": round(sum(p.linked_live_value for p in product_responses), 2),
        "realized_gains": round(sum(p.realized_gains for p in product_responses), 2),
        "by_type": by_type_list,
        "monthly": monthly_list,
    }


@router.get("/{product_id}", response_model=ProductPurchaseResponse)
def get_product(
    product_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Get one product with its linked-card ledger."""
    product = _get_product_or_404(db, current_user, product_id)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))


@router.post("/{product_id}/cards", response_model=ProductPurchaseResponse)
def link_collection_item_to_product(
    product_id: int,
    link: ProductCardLinkCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Link exact owned collection copies to a product without removing them from active inventory."""
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    has_activity = _product_has_activity(db, current_user, product.id)
    if product_lifecycle_status(product, has_activity) == "sold":
        raise HTTPException(status_code=409, detail="A sold sealed product cannot have cards linked to it")
    _link_collection_items(db, current_user, product, [link])

    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))


@router.post("/{product_id}/cards/bulk", response_model=ProductPurchaseResponse)
def link_collection_items_to_product(
    product_id: int,
    payload: ProductCardBulkLinkCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Link multiple exact collection rows to one product transactionally."""
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    has_activity = _product_has_activity(db, current_user, product.id)
    if product_lifecycle_status(product, has_activity) == "sold":
        raise HTTPException(status_code=409, detail="A sold sealed product cannot have cards linked to it")
    _link_collection_items(db, current_user, product, payload.items)

    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))


@router.delete("/{product_id}/cards/{product_card_id}", response_model=ProductPurchaseResponse)
def unlink_product_card(
    product_id: int,
    product_card_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Remove an active product-card link without touching collection inventory."""
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    # Serialize the history check with sales and trade-outs. Without the row
    # lock, an unlink can read the pre-trade state and delete this provenance
    # immediately after a concurrent trade commits.
    product_card = db.query(ProductCard).filter(
        ProductCard.id == product_card_id,
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
    ).with_for_update(of=ProductCard).first()
    if not product_card:
        raise HTTPException(status_code=404, detail="Linked product card not found")
    if product_card.sold_quantity > 0 or product_card.ledger_entries:
        raise HTTPException(status_code=409, detail="Cannot unlink a card that already has sale history")

    db.delete(product_card)
    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))


@router.post("/{product_id}/cards/{product_card_id}/sell", response_model=ProductPurchaseResponse)
def sell_product_card(
    product_id: int,
    product_card_id: int,
    sale: ProductCardSaleCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Mark linked card copies as sold, remove them from active collection, and keep ledger history."""
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    product.lifecycle_status = "opened"
    # Resolve the linked item first, then lock CollectionItem before ProductCard.
    # Other inventory flows use this same lock order to avoid cross-request deadlocks.
    product_card_link = db.query(ProductCard.collection_item_id).filter(
        ProductCard.id == product_card_id,
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
    ).first()
    if not product_card_link:
        raise HTTPException(status_code=404, detail="Linked product card not found")

    collection_item_id = product_card_link.collection_item_id
    collection_item = None
    if collection_item_id:
        collection_item = db.query(CollectionItem).filter(
            CollectionItem.id == collection_item_id,
            CollectionItem.user_id == current_user.id,
        ).with_for_update(of=CollectionItem).first()

    product_card = db.query(ProductCard).options(joinedload(ProductCard.card)).filter(
        ProductCard.id == product_card_id,
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
    ).with_for_update(of=ProductCard).first()
    if not product_card:
        raise HTTPException(status_code=404, detail="Linked product card not found")
    if product_card.collection_item_id != collection_item_id:
        raise HTTPException(status_code=409, detail="Linked collection item changed; please try again")
    if not positive_quantity(sale.quantity, PRODUCT_LINK_MAX_QUANTITY):
        raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")
    if sale.quantity > product_card.active_quantity:
        raise HTTPException(status_code=409, detail="Cannot sell more copies than are active on this product")
    if not sale_total_is_valid(sale.sold_price):
        raise HTTPException(status_code=422, detail="sold_price must be a finite, non-negative flat sale total")

    if not collection_item:
        raise HTTPException(
            status_code=409,
            detail="Active collection item is missing for this product card. Relink an owned copy before recording a sale.",
        )
    if collection_item.quantity < sale.quantity:
        raise HTTPException(
            status_code=409,
            detail=f"Only {collection_item.quantity} active collection copie(s) remain for this linked card",
        )

    remaining_quantity = int(collection_item.quantity or 0) - sale.quantity
    allocated_quantity = collection_item_allocated_quantity(db, current_user.id, collection_item.id)
    if remaining_quantity < allocated_quantity:
        raise HTTPException(
            status_code=409,
            detail=f"This sale would leave fewer copies than the {allocated_quantity} assigned to binders. Reduce binder quantities first.",
        )

    if remaining_quantity > 0:
        collection_item.quantity = remaining_quantity
    else:
        db.delete(collection_item)

    product_card.active_quantity -= sale.quantity
    product_card.sold_quantity += sale.quantity
    db.add(ProductLedgerEntry(
        product_card_id=product_card.id,
        product_id=product.id,
        user_id=current_user.id,
        entry_type="card_sale",
        card_id=product_card.card_id,
        original_collection_item_id=product_card.collection_item_id,
        quantity=sale.quantity,
        amount=round(float(sale.sold_price), 2),
        event_date=sale.sold_date,
        product_name=product.product_name,
        card_name=product_card.card.name if product_card.card else None,
        set_id=product_card.card.set_id if product_card.card else None,
        card_number=product_card.card.number if product_card.card else None,
        variant=product_card.variant,
        condition=product_card.condition,
        lang=product_card.lang,
        notes=sale.notes,
        created_at=datetime.datetime.utcnow(),
    ))

    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))


@router.post("/{product_id}/ledger", response_model=ProductPurchaseResponse)
def add_product_ledger_entry(
    product_id: int,
    entry: ProductLedgerEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Cardmarket price field for linked-card valuation"),
):
    """Add a flat realized gain to a product ledger."""
    product = _get_product_or_404(db, current_user, product_id, lock=True)
    has_activity = _product_has_activity(db, current_user, product.id)
    if product_lifecycle_status(product, has_activity) == "sold":
        raise HTTPException(status_code=409, detail="A sold sealed product cannot receive opened-product ledger entries")
    if entry.entry_type != "flat_gain":
        raise HTTPException(status_code=422, detail="entry_type must be flat_gain")
    if not finite_non_negative(entry.amount):
        raise HTTPException(status_code=422, detail="amount must be a finite, non-negative number")

    db.add(ProductLedgerEntry(
        product_card_id=None,
        product_id=product.id,
        user_id=current_user.id,
        entry_type="flat_gain",
        card_id=None,
        original_collection_item_id=None,
        quantity=1,
        amount=round(float(entry.amount), 2),
        event_date=entry.event_date,
        product_name=product.product_name,
        notes=entry.notes,
        created_at=datetime.datetime.utcnow(),
    ))
    product.lifecycle_status = "opened"
    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))
