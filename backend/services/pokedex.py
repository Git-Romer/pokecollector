"""Static National Pokédex catalogue and collection aggregation helpers."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from sqlalchemy.orm import Session

from models import Card, CollectionItem
from services.card_visibility import visible_card_filter

MAX_DEX_ID = 1025
REGION_RANGES = {
    1: (1, 151), 2: (152, 251), 3: (252, 386), 4: (387, 493),
    5: (494, 649), 6: (650, 721), 7: (722, 809), 8: (810, 905),
    9: (906, 1025),
}


def _catalogue_path() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "pokedex.json"


@lru_cache(maxsize=1)
def load_pokedex() -> tuple[dict, ...]:
    return tuple(json.loads(_catalogue_path().read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def pokedex_by_id() -> dict[int, dict]:
    return {int(entry["dex_id"]): entry for entry in load_pokedex()}


def normalize_dex_ids(value) -> list[int]:
    if not isinstance(value, list):
        return []
    result = []
    for raw in value:
        try:
            dex_id = int(raw)
        except (TypeError, ValueError):
            continue
        if 1 <= dex_id <= MAX_DEX_ID and dex_id not in result:
            result.append(dex_id)
    return result


def normalize_entry_ids(value) -> list[str]:
    from services.pokedex_forms import get_entry

    if not isinstance(value, list):
        return []
    result = []
    for raw in value:
        key = str(raw)
        if get_entry(key) and key not in result:
            result.append(key)
    return result


def _matches_search(entry: dict, search: str | None) -> bool:
    if not search or not search.strip():
        return True
    needle = search.strip().casefold()
    normalized_number = needle.lstrip("#").casefold()
    candidates = {
        str(entry["dex_id"]), f"{int(entry['dex_id']):03d}",
        str(entry.get("entry_id", "")).casefold(),
        str(entry.get("display_number", "")).lstrip("#").casefold(),
    }
    return (
        normalized_number in candidates
        or needle in entry.get("name_en", "").casefold()
        or needle in entry.get("name_de", "").casefold()
    )


def card_pokedex_entry_ids(
    *,
    name: str | None,
    dex_ids,
    stored_entry_ids,
    supertype: str | None,
    tcg_card_id: str | None,
) -> list[str]:
    from services.pokedex_forms import classify_pokedex_entries

    stored = normalize_entry_ids(stored_entry_ids)
    if stored or stored_entry_ids == []:
        return stored
    category = str(supertype or "").strip().casefold()
    return classify_pokedex_entries(
        name,
        dex_ids,
        tcg_card_id=tcg_card_id,
        is_pokemon=category in {"pokemon", "pokémon"} or not category,
    )


def available_pokedex_printings(
    db: Session,
    user_id: int,
    *,
    language: str = "en",
    mode: str = "grouped",
) -> dict[str, set[str]]:
    """Return visible printing identities by grouped or exact Pokédex entry."""
    mode = "forms" if mode == "forms" else "grouped"
    rows = (
        db.query(
            Card.tcg_card_id, Card.id, Card.name, Card.dex_ids,
            Card.pokedex_entry_ids, Card.supertype,
        )
        .filter(
            Card.is_custom.is_(False),
            Card.dex_ids.isnot(None),
            visible_card_filter(db, user_id, language),
        )
        .yield_per(1000)
    )
    available: dict[str, set[str]] = {}
    for tcg_card_id, card_id, name, dex_ids, stored_entry_ids, supertype in rows:
        keys = [str(value) for value in normalize_dex_ids(dex_ids)] if mode == "grouped" else card_pokedex_entry_ids(
            name=name,
            dex_ids=dex_ids,
            stored_entry_ids=stored_entry_ids,
            supertype=supertype,
            tcg_card_id=tcg_card_id,
        )
        for key in keys:
            available.setdefault(key, set()).add(tcg_card_id or card_id)
    return available


def _catalogue_for_mode(mode: str, available: dict[str, set[str]]) -> list[dict]:
    from services.pokedex_forms import base_entry, form_catalogue

    if mode == "grouped":
        return [dict(row) for row in load_pokedex()]
    catalogue = [base_entry(int(row["dex_id"])) for row in load_pokedex()]
    # Do not make completion impossible for game forms without physical cards.
    catalogue.extend(dict(row) for row in form_catalogue() if row["entry_id"] in available)
    return sorted(catalogue, key=lambda row: (int(row["dex_id"]), row.get("form", "base")))


def aggregate_pokedex(
    db: Session,
    user_id: int,
    *,
    language: str = "en",
    generation: int | None = None,
    region: str | None = None,
    status: str = "all",
    search: str | None = None,
    mode: str = "grouped",
    form_family: str = "all",
    _include_available_entry_ids: bool = False,
) -> dict:
    """Return grouped species or exact form entries with bulk ownership counts."""
    mode = "forms" if mode == "forms" else "grouped"
    available = available_pokedex_printings(
        db,
        user_id,
        language=language,
        mode=mode,
    )

    owned_rows = (
        db.query(
            CollectionItem.quantity, Card.name, Card.dex_ids,
            Card.pokedex_entry_ids, Card.supertype, Card.tcg_card_id,
        )
        .join(Card, Card.id == CollectionItem.card_id)
        .filter(
            CollectionItem.user_id == user_id,
            Card.dex_ids.isnot(None), Card.is_custom.is_(False),
            visible_card_filter(db, user_id, "all"),
        )
        .yield_per(1000)
    )
    owned: dict[str, int] = {}
    for quantity, name, dex_ids, stored_entry_ids, supertype, tcg_card_id in owned_rows:
        keys = [str(value) for value in normalize_dex_ids(dex_ids)] if mode == "grouped" else card_pokedex_entry_ids(
            name=name, dex_ids=dex_ids, stored_entry_ids=stored_entry_ids,
            supertype=supertype, tcg_card_id=tcg_card_id,
        )
        for key in keys:
            owned[key] = owned.get(key, 0) + max(int(quantity or 0), 0)

    catalogue = _catalogue_for_mode(mode, available)
    scoped = [
        entry for entry in catalogue
        if (generation is None or int(entry["generation"]) == generation)
        and (region is None or entry["region"].casefold() == region.casefold())
        and (mode == "grouped" or form_family == "all" or entry.get("form_family") == form_family)
    ]
    scope_total = len(scoped)
    scope_owned = sum(1 for entry in scoped if owned.get(str(entry.get("entry_id", entry["dex_id"])), 0) > 0)

    entries = []
    for entry in scoped:
        key = str(entry.get("entry_id", entry["dex_id"]))
        owned_cards = owned.get(key, 0)
        is_owned = owned_cards > 0
        if status == "owned" and not is_owned:
            continue
        if status == "missing" and is_owned:
            continue
        if not _matches_search(entry, search):
            continue
        row = dict(entry)
        row.setdefault("entry_id", key)
        row.setdefault("form", "base")
        row.setdefault("form_family", "base")
        row.setdefault("display_number", f"#{int(entry['dex_id']):03d}")
        row.update(
            owned=is_owned,
            owned_cards=owned_cards,
            available_printings=len(available.get(key, set())),
            sprite_url=f"/api/pokedex/images/sprites/{key}.png",
            artwork_url=f"/api/pokedex/images/artwork/{key}.png",
        )
        entries.append(row)

    result = {
        "summary": {
            "generation": generation, "region": region, "mode": mode,
            "form_family": form_family, "total": scope_total, "owned": scope_owned,
            "missing": scope_total - scope_owned, "visible": len(entries),
        },
        "entries": entries,
    }
    if _include_available_entry_ids:
        result["_available_entry_ids"] = set(available)
    return result


def species_detail(
    db: Session,
    user_id: int,
    entry_id: str | int,
    *,
    language: str = "en",
    mode: str | None = None,
) -> dict | None:
    from services.pokedex_forms import base_entry, forms_by_dex_id, get_entry

    entry = get_entry(entry_id)
    if not entry:
        return None
    key = entry["entry_id"]
    mode = mode if mode in {"grouped", "forms"} else (
        "grouped" if entry["form"] == "base" and ":" not in str(entry_id) else "forms"
    )
    aggregate = aggregate_pokedex(
        db,
        user_id,
        language=language,
        mode=mode,
        search=key,
        _include_available_entry_ids=True,
    )
    current = next((row for row in aggregate["entries"] if row["entry_id"] == key), None)
    if not current:
        current = {
            **entry, "owned": False, "owned_cards": 0, "available_printings": 0,
            "sprite_url": f"/api/pokedex/images/sprites/{key}.png",
            "artwork_url": f"/api/pokedex/images/artwork/{key}.png",
        }
    dex_id = int(entry["dex_id"])
    current["previous_entry_id"] = str(dex_id - 1) if dex_id > 1 else None
    current["next_entry_id"] = str(dex_id + 1) if dex_id < MAX_DEX_ID else None
    # Backward-compatible aliases for numeric clients.
    current["previous_dex_id"] = dex_id - 1 if dex_id > 1 else None
    current["next_dex_id"] = dex_id + 1 if dex_id < MAX_DEX_ID else None
    related = [base_entry(dex_id), *forms_by_dex_id().get(dex_id, ())]
    available_keys = aggregate["_available_entry_ids"]
    current["related_forms"] = [
        {
            "entry_id": row["entry_id"], "form": row["form"],
            "form_family": row["form_family"], "name_en": row["name_en"],
            "name_de": row["name_de"], "display_number": row["display_number"],
        }
        for row in related
        if row["form"] == "base" or row["entry_id"] in available_keys
    ]
    return current
