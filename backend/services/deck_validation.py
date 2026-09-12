"""Structured, non-destructive Pokemon TCG deck validation."""

from __future__ import annotations

from collections import defaultdict

from services.standard_legality import is_standard_legal_card


def _normalized(value) -> str:
    return str(value or "").strip().casefold()


def is_basic_pokemon(card) -> bool:
    return _normalized(getattr(card, "supertype", None)) in {"pokemon", "pokémon"} and (
        _normalized(getattr(card, "stage", None)) == "basic"
        or "basic" in {_normalized(subtype) for subtype in (getattr(card, "subtypes", None) or [])}
    )


def is_basic_energy(card) -> bool:
    """Identify Basic Energy from TCGdex gameplay metadata, including older prints."""
    if _normalized(getattr(card, "supertype", None)) != "energy":
        return False
    subtypes = {_normalized(subtype) for subtype in (getattr(card, "subtypes", None) or [])}
    energy_type = _normalized(getattr(card, "energy_type", None))
    if "special" in subtypes or energy_type == "special":
        return False
    return "basic" in subtypes or _normalized(getattr(card, "stage", None)) == "basic" or energy_type == "normal"


def _check(code, status, severity, message, details=None):
    return {
        "code": code,
        "status": status,
        "severity": severity,
        "message": message,
        "details": details or {},
    }


def validate_deck(deck, owned_quantities=None, standard_legal_fingerprints=None) -> dict:
    """Validate a loaded deck without changing its entries or collection rows."""
    entries = list(deck.entries)
    owned_quantities = owned_quantities or {}
    required_total = sum(int(entry.required_quantity or 0) for entry in entries)
    checks = []

    if required_total == deck.target_size:
        checks.append(_check("deck_size", "pass", "error", f"Deck contains {required_total} cards.", {"current": required_total, "target": deck.target_size}))
    else:
        checks.append(_check("deck_size", "fail", "error", f"Deck contains {required_total} of {deck.target_size} cards.", {"current": required_total, "target": deck.target_size}))

    basic_entries = [entry for entry in entries if entry.card and is_basic_pokemon(entry.card)]
    if basic_entries:
        checks.append(_check("basic_pokemon", "pass", "error", "Deck contains a Basic Pokemon.", {"count": len(basic_entries)}))
    else:
        checks.append(_check("basic_pokemon", "fail", "error", "Deck needs at least one Basic Pokemon.", {"count": 0}))

    named_quantities = defaultdict(lambda: {"name": "", "quantity": 0})
    for entry in entries:
        if not entry.card or is_basic_energy(entry.card):
            continue
        name = _normalized(entry.card.name)
        if name:
            if not named_quantities[name]["name"]:
                named_quantities[name]["name"] = entry.card.name
            named_quantities[name]["quantity"] += int(entry.required_quantity or 0)
    violations = [value for value in named_quantities.values() if value["quantity"] > 4]
    if violations:
        checks.append(_check("copy_limit", "fail", "error", "One or more cards exceed the 4-copy limit.", {"violations": sorted(violations, key=lambda item: item["name"].casefold())}))
    else:
        checks.append(_check("copy_limit", "pass", "error", "Copy limits are valid."))

    shortages = []
    for entry in entries:
        owned = int(owned_quantities.get(entry.card_id, 0))
        missing = max(int(entry.required_quantity or 0) - owned, 0)
        if missing:
            shortages.append({"entry_id": entry.id, "card_id": entry.card_id, "name": entry.card.name if entry.card else entry.card_id, "required": entry.required_quantity, "owned": owned, "missing": missing})
    missing_total = sum(item["missing"] for item in shortages)
    if shortages:
        checks.append(_check("ownership", "fail", "warning", f"Missing {missing_total} copies from your collection.", {"missing": missing_total, "cards": shortages}))
    else:
        checks.append(_check("ownership", "pass", "warning", "All required copies are in your collection."))

    deck_format = getattr(deck, "format", None) or "Casual"
    if deck_format == "Standard":
        illegal = [
            {"entry_id": entry.id, "card_id": entry.card_id, "name": entry.card.name if entry.card else entry.card_id}
            for entry in entries
            if not is_standard_legal_card(entry.card, standard_legal_fingerprints)
        ]
        if illegal:
            checks.append(_check("format_legality", "fail", "error", f"{len(illegal)} cards are not legal in Standard.", {"format": deck_format, "illegal_cards": illegal}))
        else:
            checks.append(_check("format_legality", "pass", "error", "All cards are legal in Standard.", {"format": deck_format}))
    elif deck_format in {"Expanded", "Unlimited"}:
        checks.append(_check("format_legality", "unavailable", "info", f"{deck_format} legality is not available from current card metadata.", {"format": deck_format}))
    else:
        checks.append(_check("format_legality", "pass", "info", "Casual format does not apply card legality restrictions.", {"format": "Casual"}))

    return {
        "valid": not any(check["severity"] == "error" and check["status"] == "fail" for check in checks),
        "errors": [check for check in checks if check["severity"] == "error" and check["status"] == "fail"],
        "warnings": [check for check in checks if check["severity"] == "warning" and check["status"] == "fail"],
        "checks": checks,
    }
