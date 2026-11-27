"""Read-only collision hints from the local catalogue, never price corrections.

Different finishes of one numbered card may legitimately share a product. Only
compare different card numbers within the same localized set, and describe a
collision as possible rather than proven. No provider request is needed.
"""
from collections import defaultdict

from sqlalchemy import tuple_
from sqlalchemy.orm import Session

from models import Card
from services.card_visibility import visible_card_filter


def _product_ids(products) -> set[int]:
    ids = set()
    for row in products if isinstance(products, list) else []:
        value = row.get("product_id") if isinstance(row, dict) else None
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value > 0:
            ids.add(value)
        elif isinstance(value, str) and value.isascii() and value.isdecimal() and int(value) > 0:
            ids.add(int(value))
    return ids


def _number(value) -> str:
    value = str(value or "").strip()
    return str(int(value)) if value.isascii() and value.isdecimal() else value


def find_pricing_warnings(db: Session, card_ids: list[str], user_id: int) -> dict[str, list[dict]]:
    """Batch by localized set, with no per-card SQL or database writes.

    Missing, invisible, custom and unnumbered cards return empty lists. An empty
    list means no collision found in the currently synced catalogue, not that a
    price has been independently verified.
    """
    result = {card_id: [] for card_id in card_ids}
    requested = db.query(Card.id, Card.set_id, Card.lang).filter(
        Card.id.in_(result), Card.is_custom == False,
        visible_card_filter(db, user_id),
    ).all()
    scopes = {(card.set_id, card.lang) for card in requested if card.set_id and card.lang}
    if not scopes:
        return result
    # Project just the catalogue metadata needed here, not images/attacks/prices.
    candidates = db.query(
        Card.id, Card.name, Card.number, Card.rarity, Card.set_id, Card.lang, Card.cardmarket_products,
    ).filter(Card.is_custom == False, tuple_(Card.set_id, Card.lang).in_(sorted(scopes))).order_by(Card.id).all()
    groups = defaultdict(list)
    products_by_card = {}
    cards = {}
    for card in candidates:
        if not _number(card.number):
            continue
        cards[card.id] = card
        products_by_card[card.id] = _product_ids(card.cardmarket_products)
        for product_id in products_by_card[card.id]:
            groups[(card.set_id, card.lang, product_id)].append(card)
    for requested_card in requested:
        card = cards.get(requested_card.id)
        if card is None:
            continue
        for product_id in sorted(products_by_card[card.id]):
            others = [other for other in groups[(card.set_id, card.lang, product_id)]
                      if _number(other.number) != _number(card.number)]
            if others:
                result[card.id].append({
                    "code": "shared_cardmarket_product",
                    "severity": "possible_mismatch",
                    "product_id": product_id,
                    "other_cards": [{key: getattr(other, key) for key in ("id", "name", "number", "rarity", "set_id", "lang")} for other in others],
                })
    return result
