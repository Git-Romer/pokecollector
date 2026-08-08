from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

from sqlalchemy.orm import Session, joinedload

from models import (
    PORTFOLIO_CALCULATION_VERSION,
    Card,
    CollectionItem,
    ProductCard,
    ProductLedgerEntry,
    ProductPurchase,
)
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_card_filter
from services.product_ledger import product_effective_value


@dataclass(frozen=True)
class PortfolioValuation:
    card_value: float
    product_value: float
    total_value: float
    card_cost_basis: float
    product_cost_basis: float
    active_cost_basis: float
    performance_cost_basis: float
    realized_value: float
    unrealized_pnl: float
    realized_pnl: float
    total_pnl: float
    total_cards: int
    product_value_fallback_count: int
    products_sold_cost: float
    products_sold_revenue: float
    product_card_realized_gains: float
    products_realized_pnl: float

    def as_dict(self) -> dict:
        return {
            "calculation_version": PORTFOLIO_CALCULATION_VERSION,
            "card_value": round(self.card_value, 2),
            "product_value": round(self.product_value, 2),
            "total_value": round(self.total_value, 2),
            "card_cost_basis": round(self.card_cost_basis, 2),
            "product_cost_basis": round(self.product_cost_basis, 2),
            "active_cost_basis": round(self.active_cost_basis, 2),
            "performance_cost_basis": round(self.performance_cost_basis, 2),
            "realized_value": round(self.realized_value, 2),
            "unrealized_pnl": round(self.unrealized_pnl, 2),
            "realized_pnl": round(self.realized_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "total_cards": self.total_cards,
            "product_value_fallback_count": self.product_value_fallback_count,
            "products_sold_cost": round(self.products_sold_cost, 2),
            "products_sold_revenue": round(self.products_sold_revenue, 2),
            "product_card_realized_gains": round(self.product_card_realized_gains, 2),
            "products_realized_pnl": round(self.products_realized_pnl, 2),
        }


def portfolio_snapshot_fields(valuation: PortfolioValuation) -> dict:
    """Return the complete versioned value payload for a snapshot row."""
    return {
        "total_value": valuation.total_value,
        "total_cards": valuation.total_cards,
        "total_cost": valuation.active_cost_basis,
        "calculation_version": PORTFOLIO_CALCULATION_VERSION,
        "cards_value": valuation.card_value,
        "products_value": valuation.product_value,
        "cards_cost": valuation.card_cost_basis,
        "products_cost": valuation.product_cost_basis,
        "performance_cost_basis": valuation.performance_cost_basis,
        "realized_value": valuation.realized_value,
        "unrealized_pnl": valuation.unrealized_pnl,
        "realized_pnl": valuation.realized_pnl,
        "total_pnl": valuation.total_pnl,
        "product_value_fallback_count": valuation.product_value_fallback_count,
    }


def portfolio_snapshot_payload(snapshot) -> dict:
    """Serialize legacy and current snapshots without rewriting old history."""
    calculation_version = int(getattr(snapshot, "calculation_version", 1) or 1)
    is_legacy = calculation_version < PORTFOLIO_CALCULATION_VERSION
    total_value = float(getattr(snapshot, "total_value", 0) or 0)
    total_cost = float(getattr(snapshot, "total_cost", 0) or 0)
    stored_pnl = getattr(snapshot, "total_pnl", None)
    total_pnl = total_value - total_cost if is_legacy or stored_pnl is None else float(stored_pnl)
    return {
        "date": snapshot.date.isoformat(),
        "value": round(total_value, 2),
        "cost": round(total_cost, 2),
        "pnl": round(total_pnl, 2),
        "cards": int(getattr(snapshot, "total_cards", 0) or 0),
        "calculation_version": calculation_version,
        "legacy": is_legacy,
        "cards_value": None if is_legacy else round(float(snapshot.cards_value or 0), 2),
        "products_value": None if is_legacy else round(float(snapshot.products_value or 0), 2),
        "cards_cost": None if is_legacy else round(float(snapshot.cards_cost or 0), 2),
        "products_cost": None if is_legacy else round(float(snapshot.products_cost or 0), 2),
        "performance_cost_basis": None if is_legacy else round(float(snapshot.performance_cost_basis or 0), 2),
        "realized_value": None if is_legacy else round(float(snapshot.realized_value or 0), 2),
        "unrealized_pnl": None if is_legacy else round(float(snapshot.unrealized_pnl or 0), 2),
        "realized_pnl": None if is_legacy else round(float(snapshot.realized_pnl or 0), 2),
        "product_value_fallback_count": None if is_legacy else int(snapshot.product_value_fallback_count or 0),
    }


def _collection_items(db: Session, user_id: int) -> list[CollectionItem]:
    return db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
        joinedload(CollectionItem.card)
    ).filter(
        CollectionItem.user_id == user_id,
        visible_card_filter(db, user_id, "all"),
    ).all()


def calculate_portfolio_valuation(
    db: Session,
    user_id: int,
    price_field: str = "price_trend",
    collection_items: Iterable[CollectionItem] | None = None,
) -> PortfolioValuation:
    """Calculate the authoritative combined card and product valuation.

    Collection value always includes every active owned card. Sealed products
    without ledger activity add their manual current value, falling back to
    purchase cost when no current value has been supplied. Opened products do
    not add another asset value because their active cards are already present
    in the collection.

    Product-linked card purchase prices are excluded from the standalone card
    cost basis. Their original product purchase is the cost basis instead, so
    both asset value and cost are counted exactly once.
    """
    price_field = normalize_price_field(price_field)
    items = list(collection_items) if collection_items is not None else _collection_items(db, user_id)

    card_value = sum(
        effective_market_price(item.card, item.variant, price_field) * int(item.quantity or 0)
        for item in items
        if item.card
    )
    total_cards = sum(max(int(item.quantity or 0), 0) for item in items)

    products = db.query(ProductPurchase).filter(ProductPurchase.user_id == user_id).all()
    product_cards = db.query(ProductCard).options(
        joinedload(ProductCard.card),
        joinedload(ProductCard.ledger_entries),
    ).filter(ProductCard.user_id == user_id).all()
    flat_ledger_entries = db.query(ProductLedgerEntry).filter(
        ProductLedgerEntry.user_id == user_id,
        ProductLedgerEntry.product_card_id.is_(None),
    ).all()

    product_cards_by_product: dict[int, list[ProductCard]] = defaultdict(list)
    flat_entries_by_product: dict[int, list[ProductLedgerEntry]] = defaultdict(list)
    active_linked_quantity_by_collection_item: dict[int, int] = defaultdict(int)
    for entry in product_cards:
        product_cards_by_product[entry.product_id].append(entry)
        if entry.collection_item_id is not None:
            active_linked_quantity_by_collection_item[entry.collection_item_id] += max(
                int(entry.active_quantity or 0), 0
            )
    for entry in flat_ledger_entries:
        flat_entries_by_product[entry.product_id].append(entry)

    card_cost_basis = 0.0
    for item in items:
        quantity = max(int(item.quantity or 0), 0)
        linked_quantity = min(active_linked_quantity_by_collection_item.get(item.id, 0), quantity)
        standalone_quantity = quantity - linked_quantity
        card_cost_basis += float(item.purchase_price or 0) * standalone_quantity

    product_value = 0.0
    product_cost_basis = 0.0
    performance_product_cost = 0.0
    realized_value = 0.0
    product_value_fallback_count = 0
    product_returns = 0.0
    products_sold_cost = 0.0
    products_sold_revenue = 0.0
    product_card_realized_gains = 0.0

    for product in products:
        purchase_price = float(product.purchase_price or 0)
        performance_product_cost += purchase_price
        linked_entries = product_cards_by_product.get(product.id, [])
        flat_entries = flat_entries_by_product.get(product.id, [])

        if linked_entries or flat_entries:
            effective_value, _source, totals = product_effective_value(
                product,
                linked_entries,
                price_field,
                flat_entries,
            )
            product_returns += float(effective_value or 0)
            realized_value += float(totals.realized_gains or 0)
            product_card_realized_gains += float(totals.realized_gains or 0)
            if totals.active_cards_count > 0:
                product_cost_basis += purchase_price
            continue

        if product.sold_price is not None:
            sold_price = float(product.sold_price or 0)
            product_returns += sold_price
            realized_value += sold_price
            products_sold_cost += purchase_price
            products_sold_revenue += sold_price
            continue

        current_value = product.current_value
        if current_value is None:
            current_value = purchase_price
            product_value_fallback_count += 1
        current_value = float(current_value or 0)
        product_value += current_value
        product_returns += current_value
        product_cost_basis += purchase_price

    linked_cards_value = sum(
        effective_market_price(entry.card, entry.variant, price_field) * max(int(entry.active_quantity or 0), 0)
        for entry in product_cards
        if entry.card
    )
    standalone_card_value = max(card_value - linked_cards_value, 0.0)
    total_value = card_value + product_value
    active_cost_basis = card_cost_basis + product_cost_basis
    performance_cost_basis = card_cost_basis + performance_product_cost
    total_pnl = standalone_card_value - card_cost_basis + product_returns - performance_product_cost
    # Keep active assets and completed history reconcilable without inventing a
    # per-card allocation for opened products. The full product cost remains
    # active while linked copies remain; the realized portion is the remainder
    # needed to reconcile unrealized P&L to total lifetime product performance.
    unrealized_pnl = total_value - active_cost_basis
    realized_pnl = total_pnl - unrealized_pnl
    # Standalone active cards have no realized component in the available data,
    # so the reconciled realized figure is also the authoritative product
    # realized P&L. This transfers the original product cost only when the last
    # linked copy leaves the active collection instead of reporting proceeds as
    # profit.
    products_realized_pnl = realized_pnl

    return PortfolioValuation(
        card_value=round(card_value, 2),
        product_value=round(product_value, 2),
        total_value=round(total_value, 2),
        card_cost_basis=round(card_cost_basis, 2),
        product_cost_basis=round(product_cost_basis, 2),
        active_cost_basis=round(active_cost_basis, 2),
        performance_cost_basis=round(performance_cost_basis, 2),
        realized_value=round(realized_value, 2),
        unrealized_pnl=round(unrealized_pnl, 2),
        realized_pnl=round(realized_pnl, 2),
        total_pnl=round(total_pnl, 2),
        total_cards=total_cards,
        product_value_fallback_count=product_value_fallback_count,
        products_sold_cost=round(products_sold_cost, 2),
        products_sold_revenue=round(products_sold_revenue, 2),
        product_card_realized_gains=round(product_card_realized_gains, 2),
        products_realized_pnl=round(products_realized_pnl, 2),
    )
