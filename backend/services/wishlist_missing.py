"""Helpers for adding only missing wishlist/deck binder cards to the global wishlist."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True)
class MissingWishlistPlan:
    card_ids_to_add: list[str] = field(default_factory=list)
    checked: int = 0
    missing_copies: int = 0
    skipped_complete: int = 0
    skipped_existing: int = 0

    @property
    def skipped(self) -> int:
        return self.skipped_complete + self.skipped_existing


def _safe_int(value: object, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def plan_missing_wishlist_additions(
    entries: Iterable[tuple[str | None, int | None]],
    owned_quantities: Mapping[str, int | None],
    existing_wishlist_card_ids: set[str] | frozenset[str] | None = None,
) -> MissingWishlistPlan:
    """Return unique cards that are still missing and not already in the global wishlist.

    Wishlist binders can represent deck lists with required quantities, while the
    global wishlist stores one row per card. This helper keeps the math explicit:
    aggregate required quantities per card, subtract all owned copies, then only
    add cards whose missing delta is greater than zero.
    """
    existing_wishlist_card_ids = existing_wishlist_card_ids or set()
    required_by_card: dict[str, int] = {}
    ordered_card_ids: list[str] = []

    for card_id, required_quantity in entries:
        if not card_id:
            continue
        if card_id not in required_by_card:
            ordered_card_ids.append(card_id)
            required_by_card[card_id] = 0
        required_by_card[card_id] += max(_safe_int(required_quantity, 1), 1)

    card_ids_to_add: list[str] = []
    missing_copies = 0
    skipped_complete = 0
    skipped_existing = 0

    for card_id in ordered_card_ids:
        required_quantity = required_by_card[card_id]
        owned_quantity = max(_safe_int(owned_quantities.get(card_id), 0), 0)
        missing_quantity = max(required_quantity - owned_quantity, 0)
        missing_copies += missing_quantity
        if missing_quantity <= 0:
            skipped_complete += 1
            continue
        if card_id in existing_wishlist_card_ids:
            skipped_existing += 1
            continue
        card_ids_to_add.append(card_id)

    return MissingWishlistPlan(
        card_ids_to_add=card_ids_to_add,
        checked=len(ordered_card_ids),
        missing_copies=missing_copies,
        skipped_complete=skipped_complete,
        skipped_existing=skipped_existing,
    )
