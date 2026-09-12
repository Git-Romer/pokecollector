"""Deterministic, quantity-weighted deck composition analysis."""

from __future__ import annotations

from collections import Counter
from statistics import median
import re

from services.deck_validation import is_basic_energy
from services.deck_effects import analyze_deck_effects


def _normalized(value) -> str:
    return str(value or "").strip().casefold()


def _category(card) -> str:
    value = _normalized(getattr(card, "supertype", None))
    return "pokemon" if value in {"pokemon", "pokémon"} else value if value in {"trainer", "energy"} else "other"


def _stage(card) -> str:
    value = re.sub(r"[\s_-]+", "", _normalized(getattr(card, "stage", None)))
    if not value:
        value = next((re.sub(r"[\s_-]+", "", _normalized(item)) for item in (getattr(card, "subtypes", None) or []) if _normalized(item) in {"basic", "basis", "stage1", "stage2", "rang1", "rang2"}), "")
    return {"basic": "Basic", "basis": "Basic", "stage1": "Stage 1", "rang1": "Stage 1", "stage2": "Stage 2", "rang2": "Stage 2"}.get(value, "other_unknown")


def _trainer_category(card) -> str:
    value = _normalized(getattr(card, "trainer_type", None))
    if not value:
        value = next((_normalized(item) for item in (getattr(card, "subtypes", None) or []) if _normalized(item) in {"item", "supporter", "stadium", "tool"}), "")
    return {"item": "Item", "supporter": "Supporter", "stadium": "Stadium", "tool": "Tool"}.get(value, "other_unknown")


def _numeric_hp(value):
    text = str(value or "").strip()
    return int(text) if text.isdigit() else None


def _damage_kind(value):
    if value is None or str(value).strip() == "":
        return "non_damaging", None
    text = str(value).strip()
    if text.isdigit():
        return "fixed", int(text)
    if any(marker in text for marker in ("+", "×", "x", "X", "-")):
        return "variable", None
    return "unknown", None


def _weighted_stats(values):
    if not values:
        return {"count": 0, "min": None, "max": None, "average": None, "median": None}
    return {"count": len(values), "min": min(values), "max": max(values), "average": sum(values) / len(values), "median": median(values)}


def analyze_deck(deck) -> dict:
    """Analyze a deck whose entries and cards are already loaded in memory."""
    entries = list(deck.entries)
    composition = Counter()
    stages = Counter({"Basic": 0, "Stage 1": 0, "Stage 2": 0, "other_unknown": 0})
    pokemon_types = Counter()
    trainer_types = Counter({"Item": 0, "Supporter": 0, "Stadium": 0, "Tool": 0, "other_unknown": 0})
    energy_types = Counter()
    energy = Counter({"basic": 0, "special": 0, "other_unknown": 0})
    hp_values, retreat_values = [], []
    missing_hp = missing_retreat = 0
    attacks = Counter({"fixed_attack_count": 0, "variable_attack_count": 0, "non_damage_attack_count": 0, "unknown_attack_count": 0, "unparseable_attack_count": 0})
    fixed_damage = []
    attack_costs = Counter({"0": 0, "1": 0, "2": 0, "3": 0, "4+": 0, "unknown": 0})
    unique_names = set()

    for entry in entries:
        quantity = int(entry.required_quantity or 0)
        card = entry.card
        if not card or quantity <= 0:
            continue
        category = _category(card)
        composition[category] += quantity
        if card.name:
            unique_names.add(_normalized(card.name))
        if category == "pokemon":
            stages[_stage(card)] += quantity
            for card_type in card.types or []:
                if str(card_type).strip():
                    pokemon_types[str(card_type)] += quantity
            hp = _numeric_hp(card.hp)
            if hp is None:
                missing_hp += quantity
            else:
                hp_values.extend([hp] * quantity)
            if isinstance(card.retreat, int) and card.retreat >= 0:
                retreat_values.extend([card.retreat] * quantity)
            else:
                missing_retreat += quantity
            raw_attacks = card.attacks or []
            if not isinstance(raw_attacks, list):
                attacks["unparseable_attack_count"] += quantity
                continue
            for attack in raw_attacks:
                if not isinstance(attack, dict):
                    attacks["unparseable_attack_count"] += quantity
                    continue
                kind, damage = _damage_kind(attack.get("damage"))
                attacks[{"fixed": "fixed_attack_count", "variable": "variable_attack_count", "non_damaging": "non_damage_attack_count", "unknown": "unknown_attack_count"}[kind]] += quantity
                if damage is not None:
                    fixed_damage.extend([damage] * quantity)
                cost = attack.get("cost")
                if not isinstance(cost, list):
                    attack_costs["unknown"] += quantity
                else:
                    bucket = "4+" if len(cost) >= 4 else str(len(cost))
                    attack_costs[bucket] += quantity
        elif category == "trainer":
            trainer_types[_trainer_category(card)] += quantity
        elif category == "energy":
            if is_basic_energy(card):
                energy["basic"] += quantity
            elif _normalized(card.energy_type) == "special" or "special" in {_normalized(item) for item in (card.subtypes or [])}:
                energy["special"] += quantity
            else:
                energy["other_unknown"] += quantity
            for card_type in card.types or []:
                if str(card_type).strip():
                    energy_types[str(card_type)] += quantity

    total = sum(composition.values())
    retreat_distribution = Counter({"0": 0, "1": 0, "2": 0, "3+": 0})
    for value in retreat_values:
        retreat_distribution["3+" if value >= 3 else str(value)] += 1
    return {
        "composition": {
            "total_cards": total,
            "pokemon_count": composition["pokemon"], "trainer_count": composition["trainer"], "energy_count": composition["energy"], "other_count": composition["other"],
            "pokemon_percent": composition["pokemon"] / total * 100 if total else 0, "trainer_percent": composition["trainer"] / total * 100 if total else 0, "energy_percent": composition["energy"] / total * 100 if total else 0, "other_percent": composition["other"] / total * 100 if total else 0,
        },
        "pokemon": {"stages": dict(stages), "types": dict(sorted(pokemon_types.items())), "hp": {**_weighted_stats(hp_values), "missing_hp": missing_hp}, "retreat": {**_weighted_stats(retreat_values), "distribution": dict(retreat_distribution), "missing_retreat": missing_retreat}},
        "trainers": dict(trainer_types),
        "energy": {**energy, "types": dict(sorted(energy_types.items()))},
        "attacks": {**attacks, "fixed_damage": _weighted_stats(fixed_damage), "cost_distribution": dict(attack_costs)},
        "diversity": {"total_cards": total, "unique_printings": len(entries), "unique_card_names": len(unique_names)},
        "effects": analyze_deck_effects(deck),
    }
