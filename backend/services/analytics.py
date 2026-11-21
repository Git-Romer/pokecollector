"""Collection analytics helpers that do not depend on the HTTP layer."""

from __future__ import annotations

from sqlalchemy.orm import Session, joinedload

from models import Card, CollectionCardPhoto, CollectionItem
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_any_card_filter
from services.pokedex import normalize_dex_ids, pokedex_by_id

_PHOTO_CHUNK_SIZE = 500


def sort_top_movers(results, sort_by="percentage"):
    sort_field = "change_abs" if sort_by == "absolute" else "change_pct"
    return sorted(results, key=lambda x: abs(x[sort_field]), reverse=True)


def _scan_photo_card_ids(db: Session, user_id: int, card_ids: list[str]) -> set[str]:
    """Return which of these cards have an owner-supplied photo.

    Mirrors api.collection._annotate_scan_photos (selecting only the foreign
    key, 500 rows at a time) without importing from the HTTP layer: services
    must not depend on api.
    """
    with_photos: set[str] = set()
    for start in range(0, len(card_ids), _PHOTO_CHUNK_SIZE):
        chunk = card_ids[start:start + _PHOTO_CHUNK_SIZE]
        rows = db.query(CollectionCardPhoto.card_id).filter(
            CollectionCardPhoto.user_id == user_id,
            CollectionCardPhoto.card_id.in_(chunk),
        ).all()
        with_photos.update(row[0] for row in rows)
    return with_photos


def _printing_payload(card: Card, rows: list[CollectionItem], price_field: str) -> tuple[dict, int]:
    """Collapse every collection row of one card into a single printing.

    Returns the payload plus the total quantity, which callers sum for the
    species totals. Rows differ by condition/variant/price only; the printing
    identity is the card, so quantities add up and the unit price is their
    weighted average.
    """
    quantity = sum(max(int(row.quantity or 0), 0) for row in rows)
    total_value = 0.0
    for row in rows:
        unit_price = effective_market_price(card, row.variant, price_field)
        total_value += unit_price * max(int(row.quantity or 0), 0)
    payload = {
        # The first row is only a handle for the owner's own photo lookup.
        "collection_item_id": rows[0].id,
        "card_id": card.id,
        "tcg_card_id": card.tcg_card_id,
        "name": card.name,
        "set_id": card.set_id,
        "set_name": card.set_ref.name if card.set_ref else None,
        "number": card.number,
        "lang": card.lang,
        "rarity": card.rarity,
        "images_small": card.images_small,
        "quantity": quantity,
        "price": round(total_value / quantity, 2) if quantity else 0.0,
        "total_value": round(total_value, 2),
        "has_scan_photo": False,
    }
    return payload, quantity


def aggregate_species_duplicates(db: Session, user_id: int, price_field: str = "price_trend") -> dict:
    """Group visible collection printings by species of the collected cards.

    A printing is a distinct card, not a collection row: condition, variant and
    price rows for the same card are one printing with summed quantity. A card
    that maps to several dex ids counts under each of them, matching
    aggregate_pokedex. Only species with at least two printings are reported;
    the summary counts distinct printings once even when such a card also makes
    several species qualify.
    """
    price_field = normalize_price_field(price_field)

    items = (
        db.query(CollectionItem)
        .join(Card, Card.id == CollectionItem.card_id)
        .options(joinedload(CollectionItem.card).joinedload(Card.set_ref))
        .filter(
            CollectionItem.user_id == user_id,
            Card.is_custom.is_(False),
            Card.dex_ids.isnot(None),
            visible_any_card_filter(db, user_id, "all"),
        )
        .all()
    )

    rows_by_card: dict[str, list[CollectionItem]] = {}
    for item in items:
        if item.card_id:
            rows_by_card.setdefault(item.card_id, []).append(item)

    with_photos = _scan_photo_card_ids(db, user_id, list(rows_by_card))

    catalogue = pokedex_by_id()
    printings: dict[str, tuple[dict, int, list[int]]] = {}
    for card_id, rows in rows_by_card.items():
        card = rows[0].card
        if not card:
            continue
        payload, quantity = _printing_payload(card, rows, price_field)
        if quantity <= 0:
            continue
        payload["has_scan_photo"] = card_id in with_photos
        printings[card_id] = (payload, quantity, normalize_dex_ids(card.dex_ids))

    species: dict[int, dict] = {}
    for card_id, (payload, quantity, dex_ids) in printings.items():
        for dex_id in dex_ids:
            entry = catalogue.get(dex_id)
            if not entry:
                continue
            bucket = species.setdefault(dex_id, {
                "dex_id": dex_id,
                "name_en": entry.get("name_en"),
                "name_de": entry.get("name_de"),
                "generation": int(entry.get("generation") or 0),
                "region": entry.get("region"),
                "printing_count": 0,
                "copies": 0,
                "total_value": 0.0,
                "printings": [],
            })
            bucket["printing_count"] += 1
            bucket["copies"] += quantity
            bucket["total_value"] += payload["total_value"]
            bucket["printings"].append(payload)

    results = []
    for bucket in species.values():
        if bucket["printing_count"] < 2:
            continue
        bucket["total_value"] = round(bucket["total_value"], 2)
        bucket["printings"].sort(key=lambda row: (
            -row["total_value"], (row["set_name"] or "").casefold(), (row["name"] or "").casefold(),
        ))
        results.append(bucket)

    results.sort(key=lambda row: (-row["printing_count"], -row["total_value"]))

    reported_ids = {payload["card_id"] for row in results for payload in row["printings"]}
    summary = {
        "species_with_duplicates": len(results),
        "printings": len(reported_ids),
        "copies": sum(printings[card_id][1] for card_id in reported_ids),
        "total_value": round(sum(printings[card_id][0]["total_value"] for card_id in reported_ids), 2),
    }
    return {"summary": summary, "species": results}
