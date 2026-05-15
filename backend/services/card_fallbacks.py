"""Cross-language fallback helpers for TCGdex card rows.

TCGdex can have images or pricing in one language response while the matching
card in another language has no public API data. These helpers keep the native
card row but fill missing image/price fields from the sibling language when the
admin setting allows it, and record the source language for visible UI tags.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from models import Card, Setting
from services import pokemon_api

logger = logging.getLogger(__name__)

SUPPORTED_LANGS = {"en", "de"}
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
IMAGE_FIELDS = ("images_small", "images_large")


def _setting_enabled(db: Session, key: str, default: bool = True) -> bool:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        return default
    return str(row.value).lower() in {"true", "1", "yes", "on"}


def _other_lang(lang: Optional[str]) -> Optional[str]:
    if lang == "de":
        return "en"
    if lang == "en":
        return "de"
    return None


def _has_price(data: dict) -> bool:
    return any(data.get(field) is not None for field in PRICE_FIELDS)


def _has_image(data: dict) -> bool:
    return any(data.get(field) for field in IMAGE_FIELDS)


def _card_to_data(card: Card) -> dict:
    data = {field: getattr(card, field, None) for field in (*PRICE_FIELDS, *IMAGE_FIELDS)}
    # Do not cascade fallback data. A card may only borrow native data from its
    # sibling language, never data that was itself borrowed from somewhere else.
    if getattr(card, "price_source_lang", None):
        for field in PRICE_FIELDS:
            data[field] = None
    if getattr(card, "image_source_lang", None):
        for field in IMAGE_FIELDS:
            data[field] = None
    return data


def _load_sibling_data(db: Session, tcg_card_id: str, lang: str) -> Optional[dict]:
    sibling = db.query(Card).filter(
        Card.tcg_card_id == tcg_card_id,
        Card.lang == lang,
        Card.is_custom == False,
    ).first()
    if sibling:
        return _card_to_data(sibling)

    try:
        card_data = pokemon_api.get_card(tcg_card_id, lang=lang)
    except Exception as exc:
        logger.debug("Failed to fetch %s in %s for fallback: %s", tcg_card_id, lang, exc)
        return None

    if not card_data:
        return None
    return pokemon_api.parse_card_for_db(card_data, lang=lang)


def apply_cross_language_fallbacks(
    db: Session,
    parsed: dict,
    *,
    price_enabled: Optional[bool] = None,
    image_enabled: Optional[bool] = None,
) -> dict:
    """Fill missing image/price fields from the DE/EN sibling card when allowed.

    Native data always wins. That means a later sync that receives native prices
    or images clears the fallback source tag automatically.
    """
    lang = parsed.get("lang")
    tcg_card_id = parsed.get("tcg_card_id") or pokemon_api.strip_lang_suffix(parsed.get("id", ""))[0]

    parsed["price_source_lang"] = None
    parsed["image_source_lang"] = None

    fallback_lang = _other_lang(lang)
    if not tcg_card_id or not fallback_lang or lang not in SUPPORTED_LANGS:
        return parsed

    need_price = not _has_price(parsed)
    need_image = not _has_image(parsed)

    if price_enabled is None:
        price_enabled = _setting_enabled(db, "cross_language_price_fallback", True)
    if image_enabled is None:
        image_enabled = _setting_enabled(db, "cross_language_image_fallback", True)

    if not ((need_price and price_enabled) or (need_image and image_enabled)):
        return parsed

    sibling_data = _load_sibling_data(db, tcg_card_id, fallback_lang)
    if not sibling_data:
        return parsed

    if need_price and price_enabled and _has_price(sibling_data):
        for field in PRICE_FIELDS:
            parsed[field] = sibling_data.get(field)
        parsed["price_source_lang"] = fallback_lang

    if need_image and image_enabled and _has_image(sibling_data):
        for field in IMAGE_FIELDS:
            parsed[field] = sibling_data.get(field)
        parsed["image_source_lang"] = fallback_lang

    return parsed
