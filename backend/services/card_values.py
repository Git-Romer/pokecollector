HOLO_VARIANTS = {"Holo", "Holo Rare", "Holo V", "Holo VMAX", "Holo VSTAR", "Holo ex", "Reverse Holo"}


def effective_market_price(card, variant=None) -> float:
    if not card:
        return 0
    if variant in HOLO_VARIANTS and getattr(card, "price_market_holo", None) is not None:
        return card.price_market_holo or 0
    return getattr(card, "price_market", None) or 0
