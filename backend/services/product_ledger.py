import math
from dataclasses import dataclass
from typing import Iterable

from services.card_values import effective_market_price, normalize_price_field


@dataclass(frozen=True)
class ProductLedgerTotals:
    live_cards_value: float
    realized_gains: float
    dynamic_value: float
    linked_cards_count: int
    active_cards_count: int
    sold_cards_count: int


def finite_non_negative(value) -> bool:
    """Return True for finite numbers greater than or equal to zero."""
    if isinstance(value, bool) or value is None:
        return False
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and number >= 0


def positive_quantity(value, maximum: int | None = None) -> bool:
    """Return True for safe human-entered card quantities."""
    if isinstance(value, bool):
        return False
    try:
        quantity = int(value)
    except (TypeError, ValueError):
        return False
    if quantity < 1:
        return False
    if maximum is not None and quantity > maximum:
        return False
    return True


def sale_total_is_valid(value) -> bool:
    """A sale may be zero for giveaways, but must never be negative/NaN/Infinity."""
    return finite_non_negative(value)


def entry_live_value(entry, price_field: str | None = "price_trend") -> float:
    """Calculate live value for the active copies on one product-card ledger row."""
    active_quantity = max(int(getattr(entry, "active_quantity", 0) or 0), 0)
    if active_quantity <= 0:
        return 0
    card = getattr(entry, "card", None)
    price = effective_market_price(card, getattr(entry, "variant", None), normalize_price_field(price_field))
    return round(price * active_quantity, 2)


def entry_realized_value(entry) -> float:
    """Sum realized sale ledger totals for one product-card ledger row."""
    ledger_entries = getattr(entry, "ledger_entries", None) or []
    total = 0.0
    for ledger_entry in ledger_entries:
        if getattr(ledger_entry, "entry_type", None) != "card_sale":
            continue
        value = getattr(ledger_entry, "amount", 0) or 0
        if finite_non_negative(value):
            total += float(value)
    return round(total, 2)


def ledger_totals(entries: Iterable, price_field: str | None = "price_trend", flat_entries: Iterable | None = None) -> ProductLedgerTotals:
    """Calculate aggregate dynamic product values from active and realized ledger rows."""
    live_cards_value = 0.0
    realized_gains = 0.0
    linked_cards_count = 0
    active_cards_count = 0
    sold_cards_count = 0

    for entry in entries:
        initial_quantity = max(int(getattr(entry, "initial_quantity", 0) or 0), 0)
        active_quantity = max(int(getattr(entry, "active_quantity", 0) or 0), 0)
        sold_quantity = max(int(getattr(entry, "sold_quantity", 0) or 0), 0)
        linked_cards_count += initial_quantity
        active_cards_count += active_quantity
        sold_cards_count += sold_quantity
        live_cards_value += entry_live_value(entry, price_field)
        realized_gains += entry_realized_value(entry)

    for ledger_entry in flat_entries or []:
        if getattr(ledger_entry, "entry_type", None) not in {"flat_gain", "adjustment"}:
            continue
        value = getattr(ledger_entry, "amount", 0) or 0
        if finite_non_negative(value):
            realized_gains += float(value)

    live_cards_value = round(live_cards_value, 2)
    realized_gains = round(realized_gains, 2)
    return ProductLedgerTotals(
        live_cards_value=live_cards_value,
        realized_gains=realized_gains,
        dynamic_value=round(live_cards_value + realized_gains, 2),
        linked_cards_count=linked_cards_count,
        active_cards_count=active_cards_count,
        sold_cards_count=sold_cards_count,
    )


def product_effective_value(product, entries: Iterable, price_field: str | None = "price_trend", flat_entries: Iterable | None = None):
    """Return the value used for product P&L without breaking old manual products.

    Products with any linked-card ledger rows are dynamically valued as active
    linked cards plus realized sales. Older products without ledger rows keep the
    existing sold_price/current_value behavior.
    """
    entry_list = list(entries)
    flat_entry_list = list(flat_entries or [])
    totals = ledger_totals(entry_list, price_field, flat_entry_list)
    if entry_list or flat_entry_list:
        return totals.dynamic_value, "linked_cards", totals
    if getattr(product, "sold_price", None) is not None:
        return round(float(product.sold_price), 2), "manual_sold", totals
    if getattr(product, "current_value", None) is not None:
        return round(float(product.current_value), 2), "manual_current", totals
    return None, "none", totals
