import math

VALID_PRICE_FIELDS = {"price_market", "price_trend", "price_avg1", "price_avg7", "price_avg30", "price_low"}
PRICE_PRIMARY_TO_FIELD = {
    "market": "price_market",
    "avg": "price_market",
    "trend": "price_trend",
    "avg1": "price_avg1",
    "avg7": "price_avg7",
    "avg30": "price_avg30",
    "low": "price_low",
}
REVERSE_HOLO_VARIANTS = {"Reverse Holo"}
HOLO_FIELD_MAP = {
    "price_market": "price_market_holo",
    "price_trend": "price_trend_holo",
    "price_avg1": "price_avg1_holo",
    "price_avg7": "price_avg7_holo",
    "price_avg30": "price_avg30_holo",
    "price_low": "price_low_holo",
}


def normalize_price_field(price_field: str | None) -> str:
    if not price_field:
        return "price_trend"
    value = str(price_field)
    field = PRICE_PRIMARY_TO_FIELD.get(value, value)
    return field if field in VALID_PRICE_FIELDS else "price_trend"


def _positive_price(value) -> float | None:
    """Return a usable Cardmarket price, treating missing/zero values as unavailable."""
    if value is None or isinstance(value, bool):
        return None
    try:
        price = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return price if math.isfinite(price) and price > 0 else None


def _cardmarket_price(card, variant=None, price_field: str | None = "price_trend") -> float:
    """Return the selected Cardmarket EUR price for a card.

    TCGdex/Cardmarket may report unavailable reverse-holo prices as 0 instead of null.
    The ``*-holo`` price fields represent Cardmarket's alternate/reverse listing,
    not every card whose printed finish is Holo. Treat zero values as missing so
    Reverse Holo can fall back to the selected base price instead of being valued
    at €0.
    """
    if not card:
        return 0
    field = normalize_price_field(price_field)
    if variant in REVERSE_HOLO_VARIANTS:
        holo_field = HOLO_FIELD_MAP.get(field)
        for candidate in (
            getattr(card, holo_field, None) if holo_field else None,
            getattr(card, field, None),
            getattr(card, "price_market_holo", None),
            getattr(card, "price_market", None),
        ):
            price = _positive_price(candidate)
            if price is not None:
                return price
        return 0

    for candidate in (getattr(card, field, None), getattr(card, "price_market", None)):
        price = _positive_price(candidate)
        if price is not None:
            return price
    return 0


def cross_language_tcgplayer_fallback_enabled(db) -> bool:
    """Read the existing admin preference once per transaction, never globally."""
    from models import Setting

    cached = db.info.get("tcgplayer_cross_language_permission")
    if cached is not None and cached[0] is db.get_transaction():
        return cached[1]
    with db.no_autoflush:
        row = db.get(Setting, "cross_language_price_fallback")
    enabled = row is None or str(row.value).lower() in {"true", "1", "yes", "on"}
    db.info["tcgplayer_cross_language_permission"] = (db.get_transaction(), enabled)
    return enabled


def effective_price_quote(card, variant=None, price_field: str | None = "price_trend", *, allow_cross_language=None) -> dict:
    """Resolve an EUR value without changing stored Cardmarket prices.

    German cards require the existing cross-language price-fallback permission.
    All TCGplayer values require a matching variant and a saved USD/EUR rate.
    Valuation performs no network requests or database writes.
    """
    value = _cardmarket_price(card, variant, price_field)
    quote = {
        "amount": value, "currency": "EUR",
        "source": "cardmarket" if value else None,
        "source_amount": value or None,
        "source_currency": "EUR" if value else None,
    }
    if value or card is None:
        return quote
    lang = getattr(card, "lang", None)
    allowed = getattr(card, "tcgplayer_fallback_allowed", False) if allow_cross_language is None else allow_cross_language
    if lang != "en" and not (lang == "de" and allowed is True):
        return quote
    if variant is None:
        variant = "Holo" if getattr(card, "variants_holo", False) and getattr(card, "variants_normal", None) is False else "Normal"
    tcg_field = {
        "Normal": "price_tcg_normal_market",
        "Holo": "price_tcg_holo_market",
        "Reverse Holo": "price_tcg_reverse_market",
        "First Edition": "price_tcg_first_edition_market",
    }.get(variant)
    usd = _positive_price(getattr(card, tcg_field, None)) if tcg_field else None
    rate = _positive_price(getattr(card, "price_tcg_usd_to_eur", None))
    if usd is not None and rate is not None and math.isfinite(usd * rate):
        quote.update(amount=usd * rate, source="tcgplayer", source_amount=usd,
                     source_currency="USD", usd_to_eur=rate)
    return quote


def effective_market_price(card, variant=None, price_field: str | None = "price_trend", *, allow_cross_language=None) -> float:
    """Return the shared EUR valuation, preferring existing Cardmarket prices."""
    return effective_price_quote(card, variant, price_field, allow_cross_language=allow_cross_language)["amount"]
