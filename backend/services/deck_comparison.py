"""Pure, deterministic alignment of two computed deck payloads."""

from __future__ import annotations


def normalized_name(value) -> str:
    return str(value or "").strip().casefold()


def _value(source, key, default=None):
    return source.get(key, default) if isinstance(source, dict) else getattr(source, key, default)


def _card_groups(deck):
    groups = {}
    for entry in _value(deck, "entries", []) or []:
        card = _value(entry, "card", {}) or {}
        name = _value(card, "name", "")
        key = normalized_name(name)
        if not key:
            continue
        group = groups.setdefault(key, {"name": name, "quantity": 0, "printings": []})
        quantity = int(_value(entry, "required_quantity", 0) or 0)
        group["quantity"] += quantity
        group["printings"].append({
            "card_id": _value(entry, "card_id"), "quantity": quantity,
            "set": _value(card, "set_id"), "number": _value(card, "number"), "language": _value(card, "lang"),
        })
    return groups


def _numeric_deltas(left, right, prefix=""):
    changes = []
    keys = set((left or {}).keys()) | set((right or {}).keys()) if isinstance(left, dict) and isinstance(right, dict) else set()
    for key in sorted(keys):
        a, b = (left or {}).get(key), (right or {}).get(key)
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(a, dict) or isinstance(b, dict):
            changes.extend(_numeric_deltas(a or {}, b or {}, path))
        elif isinstance(a, (int, float)) and not isinstance(a, bool) or isinstance(b, (int, float)) and not isinstance(b, bool):
            a, b = a or 0, b or 0
            if a != b:
                changes.append({"metric": path, "left": a, "right": b, "delta": b - a})
    return changes


def compare_decks(left, right, left_probability=None, right_probability=None):
    """Compare independently calculated deck payloads without mutating them."""
    left_cards, right_cards = _card_groups(left), _card_groups(right)
    cards = []
    for key in sorted(set(left_cards) | set(right_cards), key=lambda item: (left_cards.get(item) or right_cards[item])["name"].casefold()):
        a = left_cards.get(key) or {"name": right_cards[key]["name"], "quantity": 0, "printings": []}
        b = right_cards.get(key) or {"name": left_cards[key]["name"], "quantity": 0, "printings": []}
        status = "added" if not a["quantity"] else "removed" if not b["quantity"] else "changed" if a["quantity"] != b["quantity"] else "unchanged"
        cards.append({"name": a["name"], "left": a["quantity"], "right": b["quantity"], "delta": b["quantity"] - a["quantity"], "status": status, "printings": {"left": a["printings"], "right": b["printings"]}})

    left_analysis, right_analysis = _value(left, "analysis", {}) or {}, _value(right, "analysis", {}) or {}
    left_validation, right_validation = _value(left, "validation", {}) or {}, _value(right, "validation", {}) or {}
    left_checks = {_value(check, "code"): check for check in _value(left_validation, "checks", []) or []}
    right_checks = {_value(check, "code"): check for check in _value(right_validation, "checks", []) or []}
    validation = []
    for code in sorted(set(left_checks) | set(right_checks)):
        a, b = left_checks.get(code), right_checks.get(code)
        if _value(a, "status") != _value(b, "status"):
            validation.append({"code": code, "left": a, "right": b})

    left_effects, right_effects = left_analysis.get("effects", {}), right_analysis.get("effects", {})
    effect_changes = _numeric_deltas({key: value.get("cards", 0) for key, value in left_effects.get("coverage", {}).items()}, {key: value.get("cards", 0) for key, value in right_effects.get("coverage", {}).items()})
    return {
        "decks": {"left": left, "right": right},
        "cards": {"changes": cards},
        "composition": _numeric_deltas(_value(left, "composition_counts", {}), _value(right, "composition_counts", {})),
        "validation": {"left": left_validation, "right": right_validation, "changes": validation},
        "ownership": {"left": _value(left, "missing_copy_count", 0), "right": _value(right, "missing_copy_count", 0), "delta": _value(right, "missing_copy_count", 0) - _value(left, "missing_copy_count", 0)},
        "analytics": {"left": left_analysis, "right": right_analysis, "changes": _numeric_deltas(left_analysis, right_analysis)},
        "effects": {"left": left_effects, "right": right_effects, "changes": effect_changes},
        "probability": {"left": left_probability, "right": right_probability, "changes": _numeric_deltas(left_probability or {}, right_probability or {})},
    }
