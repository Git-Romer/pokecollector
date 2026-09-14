import math

from services.collection_variants import normalize_collection_variant
from services.printing_details import normalize_printing_details


def is_valid_collection_purchase_price(purchase_price: float) -> bool:
    return math.isfinite(purchase_price) and purchase_price >= 0


def collection_import_key(card_id, variant, lang, condition, purchase_price, printing_details=None):
    normalized_details = tuple(sorted(
        normalized_name
        for _display_name, normalized_name in normalize_printing_details(printing_details)
    ))
    return (
        card_id,
        normalize_collection_variant(variant),
        lang or "en",
        condition,
        purchase_price,
        normalized_details,
    )


def merge_collection_import_item(items_by_key, key, item) -> bool:
    """Merge duplicate collection CSV rows before writing.

    Returns True when a new planned item was inserted, False when an existing
    planned item was incremented.
    """
    existing_item = items_by_key.get(key)
    if existing_item:
        existing_item.quantity += item.quantity or 1
        return False
    items_by_key[key] = item
    return True
