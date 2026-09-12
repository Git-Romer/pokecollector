"""Deterministic functional effect tags and consistency coverage for deck cards."""

from __future__ import annotations

from collections import defaultdict
import re

EFFECT_TAGS = (
    "draw", "pokemon_search", "energy_search", "trainer_search", "general_search",
    "energy_acceleration", "energy_recovery", "pokemon_recovery", "trainer_recovery", "general_recovery",
    "switching", "gust", "healing", "damage_boost", "damage_reduction", "bench_damage",
    "status_condition", "discard", "hand_disruption", "deck_disruption", "evolution_acceleration",
    "prize_manipulation", "retreat_support",
)


def normalize_effect_text(value) -> str:
    """Normalize source text while retaining words needed by conservative rules."""
    return re.sub(r"\s+", " ", re.sub(r"[\u2018\u2019]", "'", str(value or "").casefold())).strip()


def card_effect_text(card) -> str:
    parts = [getattr(card, "card_effect", None)]
    for ability in getattr(card, "abilities", None) or []:
        if isinstance(ability, dict):
            parts.append(ability.get("effect"))
    for attack in getattr(card, "attacks", None) or []:
        if isinstance(attack, dict):
            parts.append(attack.get("effect"))
    return normalize_effect_text(" ".join(str(part) for part in parts if part))


def classify_effects(card) -> set[str]:
    """Classify explicit gameplay actions from card metadata, never card names."""
    text = card_effect_text(card)
    if not text:
        return set()
    tags = set()
    pokemon = r"pok[eé]mon"
    search = bool(re.search(r"search your deck for|durchsuche dein deck nach", text))
    if re.search(r"\bdraw (?:up to )?\d+ cards?\b|\bziehe (?:bis zu )?\d+ karten\b", text):
        tags.add("draw")
    if search:
        if re.search(rf"(?:search your deck for|durchsuche dein deck nach).*{pokemon}", text):
            tags.add("pokemon_search")
        elif re.search(r"(?:search your deck for|durchsuche dein deck nach).*energy", text):
            tags.add("energy_search")
        elif re.search(r"(?:search your deck for|durchsuche dein deck nach).*trainer", text):
            tags.add("trainer_search")
        else:
            tags.add("general_search")
    if re.search(r"(?:put|return|trade).*energy.*from your discard pile|(?:lege|nimm).*energie.*aus deinem ablagestapel", text):
        tags.add("energy_recovery")
    if re.search(rf"(?:put|return).*{pokemon}.*from your discard pile", text):
        tags.add("pokemon_recovery")
    if re.search(r"(?:put|return).*trainer.*from your discard pile", text):
        tags.add("trainer_recovery")
    if "from your discard pile" in text and re.search(r"\b(?:put|return)\b", text):
        tags.add("general_recovery")
    if re.search(r"attach.*energy.*to (?:one of )?your pok[eé]mon", text):
        tags.add("energy_acceleration")
    if "switch" in text:
        if re.search(r"opponent.*(?:benched|active)|opponent's benched", text):
            tags.add("gust")
        elif re.search(r"your (?:benched|active)|one of your pok[eé]mon", text):
            tags.add("switching")
    if re.search(r"heal .*damage|remove .*damage counters? from your pok[eé]mon", text):
        tags.add("healing")
    if re.search(r"\bdiscard (?!pile\b)(?:\d+|a|an|your|all|up to)\b", text):
        tags.add("discard")
    if re.search(r"opponent.*hand.*(?:shuffle|discard)|each player.*(?:hand.*(?:shuffle|discard)|(?:shuffle|discard).*hand)", text):
        tags.add("hand_disruption")
    if re.search(r"attacks do .* more damage", text):
        tags.add("damage_boost")
    if re.search(r"take .* less damage", text):
        tags.add("damage_reduction")
    if re.search(r"damage counters? on .*benched pok[eé]mon", text):
        tags.add("bench_damage")
    if re.search(r"burned|confused|asleep|paralyzed|poisoned", text):
        tags.add("status_condition")
    if re.search(r"evolve.*your pok[eé]mon|evolve 1 of your pok[eé]mon", text):
        tags.add("evolution_acceleration")
    if "prize card" in text or "prize cards" in text:
        tags.add("prize_manipulation")
    if re.search(r"retreat cost|retreat .*without paying", text):
        tags.add("retreat_support")
    return tags


def _coverage(entries, tags):
    selected = [entry for entry, entry_tags in entries if entry_tags.intersection(tags)]
    return {
        "cards": sum(int(entry.required_quantity or 0) for entry in selected),
        "unique_sources": len(selected),
        "sources": [{"card_id": entry.card_id, "name": entry.card.name if entry.card else entry.card_id, "quantity": entry.required_quantity} for entry in selected],
    }


def analyze_deck_effects(deck) -> dict:
    """Return quantity-weighted tags and non-overlapping functional outs."""
    tagged_entries = []
    unclassified = []
    for entry in deck.entries:
        if not entry.card or int(entry.required_quantity or 0) <= 0:
            continue
        tags = classify_effects(entry.card)
        tagged_entries.append((entry, tags))
        if not tags:
            unclassified.append(entry)
    coverage = {tag: _coverage(tagged_entries, {tag}) for tag in EFFECT_TAGS}
    outs = {
        "draw_outs": _coverage(tagged_entries, {"draw"}),
        "pokemon_search_outs": _coverage(tagged_entries, {"pokemon_search"}),
        "energy_access_outs": _coverage(tagged_entries, {"energy_search", "energy_acceleration"}),
        "switching_outs": _coverage(tagged_entries, {"switching"}),
        "recovery_outs": _coverage(tagged_entries, {"energy_recovery", "pokemon_recovery", "trainer_recovery", "general_recovery"}),
    }
    return {
        "taxonomy": list(EFFECT_TAGS),
        "coverage": coverage,
        "outs": outs,
        "unclassified_cards": {"cards": sum(int(entry.required_quantity or 0) for entry in unclassified), "unique_sources": len(unclassified)},
    }
