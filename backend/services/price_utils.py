"""Shared helpers for card price fields."""

from __future__ import annotations

import math
from typing import Any, Mapping

PRICE_FIELDS = (
    "price_market",
    "price_low",
    "price_mid",
    "price_high",
    "price_trend",
    "price_avg1",
    "price_avg7",
    "price_avg30",
    "price_market_holo",
    "price_low_holo",
    "price_trend_holo",
    "price_avg1_holo",
    "price_avg7_holo",
    "price_avg30_holo",
    "price_tcg_normal_low",
    "price_tcg_normal_mid",
    "price_tcg_normal_high",
    "price_tcg_normal_market",
    "price_tcg_reverse_low",
    "price_tcg_reverse_mid",
    "price_tcg_reverse_market",
    "price_tcg_holo_low",
    "price_tcg_holo_mid",
    "price_tcg_holo_market",
)


def is_valid_price(value: Any) -> bool:
    """Return true when a price is a usable positive finite number."""
    if value is None or isinstance(value, bool):
        return False
    try:
        price = float(value)
    except (TypeError, ValueError, OverflowError):
        return False
    return math.isfinite(price) and price > 0


def _get_price_value(source: Any, field: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(field)
    return getattr(source, field, None)


def has_valid_price(source: Any) -> bool:
    """Return true when any known price field has a usable value."""
    if not source:
        return False
    return any(is_valid_price(_get_price_value(source, field)) for field in PRICE_FIELDS)


def preserve_existing_prices_for_invalid_update(card_data: dict, existing_card: Any | None) -> dict:
    """Keep last known prices when an incoming card payload has no valid price.

    TCGdex set endpoints can return brief card objects without pricing. Those
    entries parse to missing price fields, and some upstream outages can return
    zero or non-finite values. Existing prices should only be replaced with a
    positive finite incoming value.
    """
    incoming_has_valid_price = has_valid_price(card_data)

    if (
        existing_card is not None
        and card_data.get("price_source_lang")
        and has_valid_price(existing_card)
        and not getattr(existing_card, "price_source_lang", None)
    ):
        for field in PRICE_FIELDS:
            card_data.pop(field, None)
        card_data.pop("price_source_lang", None)
        return card_data

    preserved_existing_fallback_price = False
    existing_has_fallback_prices = bool(
        existing_card is not None
        and getattr(existing_card, "price_source_lang", None)
        and has_valid_price(existing_card)
    )

    for field in PRICE_FIELDS:
        if field not in card_data:
            continue
        if is_valid_price(card_data.get(field)):
            continue
        if existing_card is None:
            card_data[field] = None
        else:
            if existing_has_fallback_prices and is_valid_price(getattr(existing_card, field, None)):
                preserved_existing_fallback_price = True
            card_data.pop(field, None)

    if existing_card is not None and (not incoming_has_valid_price or preserved_existing_fallback_price):
        card_data.pop("price_source_lang", None)

    return card_data
