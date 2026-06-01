"""Cross-language fallback helpers for TCGdex card rows.

TCGdex can have images or pricing in one language response while the matching
card in another language has no public API data. These helpers keep the native
card row but fill missing image/price fields from the sibling language when the
admin setting allows it, and record the source language for visible UI tags.

Some new sets appear in one language before the matching card endpoints exist
in the other language. For those temporary gaps we can also create a card row in
the requested language from the sibling language data. The row keeps the target
DB id/lang (for example ``me04-001_de``), but marks borrowed metadata,
images, and prices so a later native sync can replace the fallback data in
place.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from models import Card, Setting
from services import pokemon_api
from services.price_utils import PRICE_FIELDS, has_valid_price, is_valid_price
from services.tcgdex_languages import (
    SUPPORTED_TCGDEX_LANGUAGES,
    english_fallback_languages,
    is_supported_tcgdex_language,
    normalize_tcgdex_language,
)

logger = logging.getLogger(__name__)

SUPPORTED_LANGS = set(SUPPORTED_TCGDEX_LANGUAGES)
IMAGE_FIELDS = ("images_small", "images_large")
CARD_COPY_FIELDS = (
    "tcg_card_id",
    "name",
    "set_id",
    "number",
    "rarity",
    "types",
    "supertype",
    "subtypes",
    "hp",
    "artist",
    "stage",
    "evolve_from",
    "suffix",
    "trainer_type",
    "energy_type",
    "card_effect",
    "regulation_mark",
    "attacks",
    "abilities",
    "weaknesses",
    "resistances",
    "retreat",
    "playable_fingerprint",
    "variants_normal",
    "variants_reverse",
    "variants_holo",
    "variants_first_edition",
)


def _setting_enabled(db: Session, key: str, default: bool = True) -> bool:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        return default
    return str(row.value).lower() in {"true", "1", "yes", "on"}


def _other_lang(lang: Optional[str]) -> Optional[str]:
    fallback_order = english_fallback_languages(lang)
    return fallback_order[0] if fallback_order else None


def other_supported_lang(lang: Optional[str]) -> Optional[str]:
    """Return the preferred fallback language for public callers."""
    return _other_lang(lang)


def _has_price(data: dict) -> bool:
    return has_valid_price(data)


def _has_image(data: dict) -> bool:
    return any(data.get(field) for field in IMAGE_FIELDS)


def _card_to_data(card: Card) -> dict:
    data = {field: getattr(card, field, None) for field in (*PRICE_FIELDS, *IMAGE_FIELDS)}
    for field in PRICE_FIELDS:
        if not is_valid_price(data.get(field)):
            data[field] = None
    # Do not cascade fallback data. A card may only borrow native data from its
    # sibling language, never data that was itself borrowed from somewhere else.
    if getattr(card, "price_source_lang", None):
        for field in PRICE_FIELDS:
            data[field] = None
    if getattr(card, "image_source_lang", None):
        for field in IMAGE_FIELDS:
            data[field] = None
    return data


def _card_to_fallback_source(card: Card) -> dict:
    data = {field: getattr(card, field, None) for field in CARD_COPY_FIELDS}
    data.update(_card_to_data(card))
    return data


def _fallback_settings(db: Session, price_enabled: Optional[bool], image_enabled: Optional[bool]) -> tuple[bool, bool]:
    if price_enabled is None:
        price_enabled = _setting_enabled(db, "cross_language_price_fallback", True)
    if image_enabled is None:
        image_enabled = _setting_enabled(db, "cross_language_image_fallback", True)
    return price_enabled, image_enabled


def missing_language_fallback_enabled(
    db: Session,
    *,
    price_enabled: Optional[bool] = None,
    image_enabled: Optional[bool] = None,
) -> bool:
    """Return whether whole-card missing-language fallback rows may be created."""
    price_enabled, image_enabled = _fallback_settings(db, price_enabled, image_enabled)
    return bool(price_enabled or image_enabled)


def _number_sort_key(value) -> tuple:
    value = "" if value is None else str(value)
    digits = ""
    prefix = ""
    for index, char in enumerate(value):
        if char.isdigit():
            prefix = value[:index]
            digits = value[index:]
            break
    else:
        prefix = value
    try:
        number = int(digits) if digits else 999999
    except ValueError:
        number = 999999
    return (prefix.casefold(), number, value)


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


def clone_card_for_missing_language(
    db: Session,
    source: Card | dict,
    *,
    target_lang: str,
    source_lang: Optional[str] = None,
    default_set_id: Optional[str] = None,
    price_enabled: Optional[bool] = None,
    image_enabled: Optional[bool] = None,
) -> Optional[dict]:
    """Create a target-language card row from sibling-language card data.

    This is used when TCGdex has a set/card in one language, but the requested
    language endpoint is still missing. The returned row keeps the requested
    language id (``<tcg_id>_<target_lang>``) so collection entries can already be
    stored as German/English and later native syncs replace the fallback data.
    """
    target_lang = normalize_tcgdex_language(target_lang)
    source_lang = normalize_tcgdex_language(source_lang) or None
    if not is_supported_tcgdex_language(target_lang):
        return None

    if isinstance(source, Card):
        # Do not cascade metadata fallback. Missing-language rows should only be
        # cloned from native sibling data, not from a row that was itself cloned.
        if getattr(source, "data_source_lang", None):
            return None
        parsed = _card_to_fallback_source(source)
        source_lang = source_lang or source.lang
    else:
        source_lang = source_lang or source.get("_lang") or source.get("lang")
        parsed = pokemon_api.parse_card_for_db(source, default_set_id=default_set_id, lang=source_lang)

    source_lang = normalize_tcgdex_language(source_lang or parsed.get("lang") or "")
    if not is_supported_tcgdex_language(source_lang) or source_lang == target_lang:
        return None

    price_enabled, image_enabled = _fallback_settings(db, price_enabled, image_enabled)
    if not (price_enabled or image_enabled):
        return None

    tcg_card_id = parsed.get("tcg_card_id") or pokemon_api.strip_lang_suffix(parsed.get("id", ""))[0]
    if not tcg_card_id:
        return None

    parsed = parsed.copy()
    parsed["id"] = f"{tcg_card_id}_{target_lang}"
    parsed["tcg_card_id"] = tcg_card_id
    parsed["lang"] = target_lang
    if default_set_id and not parsed.get("set_id"):
        parsed["set_id"] = default_set_id

    parsed["price_source_lang"] = None
    parsed["image_source_lang"] = None
    parsed["data_source_lang"] = source_lang

    if price_enabled and _has_price(parsed):
        parsed["price_source_lang"] = source_lang
    else:
        for field in PRICE_FIELDS:
            parsed[field] = None

    if image_enabled and _has_image(parsed):
        parsed["image_source_lang"] = source_lang
    else:
        for field in IMAGE_FIELDS:
            parsed[field] = None

    return parsed


def build_missing_language_card(
    db: Session,
    tcg_card_id: str,
    target_lang: str,
    *,
    default_set_id: Optional[str] = None,
    price_enabled: Optional[bool] = None,
    image_enabled: Optional[bool] = None,
) -> Optional[dict]:
    """Fetch sibling card data and clone it into the requested language."""
    target_lang = normalize_tcgdex_language(target_lang)
    fallback_lang = _other_lang(target_lang)
    if not tcg_card_id or not fallback_lang:
        return None

    if not missing_language_fallback_enabled(db, price_enabled=price_enabled, image_enabled=image_enabled):
        return None

    sibling = db.query(Card).filter(
        Card.tcg_card_id == tcg_card_id,
        Card.lang == fallback_lang,
        Card.is_custom == False,
    ).first()
    if sibling:
        return clone_card_for_missing_language(
            db,
            sibling,
            target_lang=target_lang,
            source_lang=fallback_lang,
            default_set_id=default_set_id,
            price_enabled=price_enabled,
            image_enabled=image_enabled,
        )

    try:
        card_data = pokemon_api.get_card(tcg_card_id, lang=fallback_lang)
    except Exception as exc:
        logger.debug("Failed to fetch %s in %s for missing-language fallback: %s", tcg_card_id, fallback_lang, exc)
        return None

    if not card_data:
        return None

    return clone_card_for_missing_language(
        db,
        card_data,
        target_lang=target_lang,
        source_lang=fallback_lang,
        default_set_id=default_set_id,
        price_enabled=price_enabled,
        image_enabled=image_enabled,
    )


def build_missing_language_cards_for_set(
    db: Session,
    tcg_set_id: str,
    target_lang: str,
    *,
    max_cards: Optional[int] = None,
    expected_total: Optional[int] = None,
    price_enabled: Optional[bool] = None,
    image_enabled: Optional[bool] = None,
) -> list[dict]:
    """Clone sibling-language set cards into missing target-language rows."""
    target_lang = normalize_tcgdex_language(target_lang)
    fallback_lang = _other_lang(target_lang)
    if not tcg_set_id or not fallback_lang:
        return []

    if not missing_language_fallback_enabled(db, price_enabled=price_enabled, image_enabled=image_enabled):
        return []

    existing_target_sources = {
        card_id: data_source_lang
        for card_id, data_source_lang in db.query(Card.id, Card.data_source_lang).filter(
            Card.set_id == tcg_set_id,
            Card.lang == target_lang,
            Card.is_custom == False,
        ).all()
    }

    source_cards = db.query(Card).filter(
        Card.set_id == tcg_set_id,
        Card.lang == fallback_lang,
        Card.is_custom == False,
    ).all()
    source_cards.sort(key=lambda card: _number_sort_key(card.number))

    sources: list[Card | dict] = source_cards
    if not sources or (expected_total and len(sources) < expected_total):
        try:
            set_data = pokemon_api.get_set_cards(tcg_set_id, lang=fallback_lang)
        except Exception as exc:
            logger.debug("Failed to fetch set %s in %s for missing-language fallback: %s", tcg_set_id, fallback_lang, exc)
            # Prefer partial cached sibling data over an empty checklist when the
            # public sibling API is temporarily unreachable. Existing target
            # rows are skipped below, so this only fills still-missing cards.
            if not sources:
                return []
        else:
            fetched_sources = sorted(
                set_data.get("cards", []),
                key=lambda card: _number_sort_key(card.get("localId")),
            )
            if len(fetched_sources) > len(sources):
                sources = fetched_sources

    parsed_cards = []
    for source in sources:
        if max_cards and len(parsed_cards) >= max_cards:
            break
        if isinstance(source, Card):
            source_tcg_id = source.tcg_card_id or pokemon_api.strip_lang_suffix(source.id or "")[0]
        else:
            source_tcg_id = source.get("id") or source.get("tcg_card_id")
            if not source_tcg_id:
                continue
            source_tcg_id = pokemon_api.strip_lang_suffix(source_tcg_id)[0]
        target_id = f"{source_tcg_id}_{target_lang}" if source_tcg_id else None
        if target_id in existing_target_sources and not existing_target_sources[target_id]:
            # Native target-language data is present. Never overwrite it with a
            # sibling-language fallback row.
            continue
        parsed = clone_card_for_missing_language(
            db,
            source,
            target_lang=target_lang,
            source_lang=fallback_lang,
            default_set_id=tcg_set_id,
            price_enabled=price_enabled,
            image_enabled=image_enabled,
        )
        if parsed:
            parsed_cards.append(parsed)
    return parsed_cards


def apply_cross_language_fallbacks(
    db: Session,
    parsed: dict,
    *,
    price_enabled: Optional[bool] = None,
    image_enabled: Optional[bool] = None,
) -> dict:
    """Fill missing image/price fields from the preferred fallback card when allowed.

    Native data always wins. That means a later sync that receives native prices
    or images clears the fallback source tag automatically.
    """
    lang = normalize_tcgdex_language(parsed.get("lang"))
    tcg_card_id = parsed.get("tcg_card_id") or pokemon_api.strip_lang_suffix(parsed.get("id", ""))[0]

    parsed["price_source_lang"] = None
    parsed["image_source_lang"] = None
    parsed["data_source_lang"] = None

    fallback_lang = _other_lang(lang)
    if not tcg_card_id or not fallback_lang or not is_supported_tcgdex_language(lang):
        return parsed

    need_price = not _has_price(parsed)
    need_image = not _has_image(parsed)

    price_enabled, image_enabled = _fallback_settings(db, price_enabled, image_enabled)

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
