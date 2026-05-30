import datetime
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from database import get_db
from models import BinderCard, Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, User
from schemas import (
    ProductCardLinkCreate,
    ProductCardResponse,
    ProductCardSaleCreate,
    ProductLedgerEntryCreate,
    ProductLedgerEntryResponse,
    ProductPurchaseCreate,
    ProductPurchaseResponse,
    ProductPurchaseUpdate,
)
from services.card_values import normalize_price_field
from services.product_ledger import (
    entry_live_value,
    entry_realized_value,
    finite_non_negative,
    ledger_totals,
    positive_quantity,
    product_effective_value,
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


def _get_product_or_404(db: Session, current_user: User, product_id: int) -> ProductPurchase:
    product = db.query(ProductPurchase).filter(
        ProductPurchase.id == product_id,
        ProductPurchase.user_id == current_user.id,
    ).first()
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
    if effective_value is not None:
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


def _available_collection_quantity(db: Session, current_user: User, collection_item: CollectionItem) -> int:
    linked_active = db.query(func.coalesce(func.sum(ProductCard.active_quantity), 0)).filter(
        ProductCard.user_id == current_user.id,
        ProductCard.collection_item_id == collection_item.id,
    ).scalar() or 0
    return max(int(collection_item.quantity or 0) - int(linked_active or 0), 0)


def _delete_collection_item_references(db: Session, collection_item_id: int) -> None:
    db.query(BinderCard).filter(BinderCard.collection_item_id == collection_item_id).delete(synchronize_session=False)


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
    db_product = ProductPurchase(
        product_name=product.product_name.strip(),
        product_type=product.product_type,
        purchase_price=product.purchase_price,
        current_value=product.current_value,
        sold_price=product.sold_price,
        purchase_date=product.purchase_date,
        sold_date=product.sold_date,
        notes=product.notes,
        user_id=current_user.id,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_product)
    db.commit()
    db.refresh(db_product)
    return _refresh_product_response(db, current_user, db_product, "price_trend")


@router.put("/{product_id}", response_model=ProductPurchaseResponse)
def update_product(
    product_id: int,
    update: ProductPurchaseUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a product purchase."""
    product = _get_product_or_404(db, current_user, product_id)
    _validate_product_payload(update)

    for field, value in update.model_dump(exclude_unset=True).items():
        if field == "product_name" and value is not None:
            value = value.strip()
        setattr(product, field, value)

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
    product = _get_product_or_404(db, current_user, product_id)
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
    product = _get_product_or_404(db, current_user, product_id)
    collection_item = db.query(CollectionItem).options(joinedload(CollectionItem.card)).filter(
        CollectionItem.id == link.collection_item_id,
        CollectionItem.user_id == current_user.id,
    ).with_for_update(of=CollectionItem).first()
    if not collection_item:
        raise HTTPException(status_code=404, detail="Collection item not found")
    if not positive_quantity(link.quantity, PRODUCT_LINK_MAX_QUANTITY):
        raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")

    available_quantity = _available_collection_quantity(db, current_user, collection_item)
    if link.quantity > available_quantity:
        raise HTTPException(
            status_code=409,
            detail=f"Only {available_quantity} unlinked copie(s) are available for this exact collection item",
        )

    existing = db.query(ProductCard).filter(
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
        ProductCard.collection_item_id == collection_item.id,
        ProductCard.card_id == collection_item.card_id,
        ProductCard.variant == collection_item.variant,
        ProductCard.condition == collection_item.condition,
        ProductCard.lang == collection_item.lang,
        ProductCard.purchase_price == collection_item.purchase_price,
        ProductCard.sold_quantity == 0,
    ).first()

    if existing:
        existing.initial_quantity += link.quantity
        existing.active_quantity += link.quantity
    else:
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
            linked_at=datetime.datetime.utcnow(),
        ))

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
    product = _get_product_or_404(db, current_user, product_id)
    product_card = db.query(ProductCard).filter(
        ProductCard.id == product_card_id,
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
    ).first()
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
    product = _get_product_or_404(db, current_user, product_id)
    product_card = db.query(ProductCard).options(joinedload(ProductCard.card)).filter(
        ProductCard.id == product_card_id,
        ProductCard.product_id == product.id,
        ProductCard.user_id == current_user.id,
    ).with_for_update(of=ProductCard).first()
    if not product_card:
        raise HTTPException(status_code=404, detail="Linked product card not found")
    if not positive_quantity(sale.quantity, PRODUCT_LINK_MAX_QUANTITY):
        raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")
    if sale.quantity > product_card.active_quantity:
        raise HTTPException(status_code=409, detail="Cannot sell more copies than are active on this product")
    if not sale_total_is_valid(sale.sold_price):
        raise HTTPException(status_code=422, detail="sold_price must be a finite, non-negative flat sale total")

    collection_item = None
    if product_card.collection_item_id:
        collection_item = db.query(CollectionItem).filter(
            CollectionItem.id == product_card.collection_item_id,
            CollectionItem.user_id == current_user.id,
        ).with_for_update().first()

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

    if collection_item.quantity > sale.quantity:
        collection_item.quantity -= sale.quantity
    else:
        _delete_collection_item_references(db, collection_item.id)
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
    product = _get_product_or_404(db, current_user, product_id)
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
    db.commit()
    db.refresh(product)
    return _refresh_product_response(db, current_user, product, normalize_price_field(price_field))
