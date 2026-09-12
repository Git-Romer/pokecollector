"""Presentation-only representative variants for deck entry artwork."""


def representative_display_variants(collection_items):
    """Prefer holo, then reverse, then normal; never affects deck allocation."""
    priority = {"holo": 3, "reverse holo": 2, "reverse": 2, "normal": 1}
    selected = {}
    for item in collection_items:
        card_id = getattr(item, "card_id", None)
        variant = str(getattr(item, "variant", "") or "").strip()
        if not card_id:
            continue
        score = priority.get(variant.casefold(), 0)
        current = selected.get(card_id)
        if current is None or score > current[0] or (score == current[0] and variant.casefold() < current[1].casefold()):
            selected[card_id] = (score, variant)
    return {card_id: {"variant": variant} for card_id, (_, variant) in selected.items() if variant}
