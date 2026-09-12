"""Exact, deterministic deck-draw and prize probability calculations."""

from __future__ import annotations

from math import comb

from services.deck_effects import analyze_deck_effects
from services.deck_validation import is_basic_pokemon


def _safe_comb(n: int, k: int) -> int:
    return comb(n, k) if 0 <= k <= n else 0


def probability_at_least(total: int, successes: int, draws: int, minimum: int = 1) -> float:
    """Hypergeometric P(X >= minimum), clamping draws to the available deck."""
    if total <= 0 or successes < 0 or draws < 0 or minimum <= 0:
        return 0.0 if minimum > 0 else 1.0
    successes = min(successes, total)
    draws = min(draws, total)
    denominator = _safe_comb(total, draws)
    if not denominator or minimum > min(successes, draws):
        return 0.0
    return min(1.0, max(0.0, sum(
        _safe_comb(successes, hit) * _safe_comb(total - successes, draws - hit) / denominator
        for hit in range(minimum, min(successes, draws) + 1)
    )))


def prize_risk(total: int, copies: int, prize_count: int) -> dict:
    """Exact risk of copies landing in a random prize-card sample."""
    if total <= 0 or copies <= 0 or prize_count <= 0:
        return {"at_least_one": 0.0, "all_copies": 0.0, "expected_copies": 0.0}
    copies = min(copies, total)
    prize_count = min(prize_count, total)
    denominator = _safe_comb(total, prize_count)
    all_copies = _safe_comb(total - copies, prize_count - copies) / denominator if denominator else 0.0
    return {
        "at_least_one": probability_at_least(total, copies, prize_count),
        "all_copies": min(1.0, max(0.0, all_copies)),
        "expected_copies": copies * prize_count / total,
    }


def _normalized_name(value) -> str:
    return str(value or "").strip().casefold()


def analyze_deck_probability(deck, hand_size: int = 7, subsequent_draws: int = 0, card_name: str | None = None, prize_count: int = 6) -> dict:
    """Analyze raw draw access using the actual required-card total of a deck."""
    entries = [entry for entry in deck.entries if entry.card and int(entry.required_quantity or 0) > 0]
    total = sum(int(entry.required_quantity or 0) for entry in entries)
    hand_size = max(0, hand_size)
    subsequent_draws = max(0, subsequent_draws)
    opening_draws = min(hand_size, total)
    cards_seen = min(hand_size + subsequent_draws, total)
    basic_count = sum(int(entry.required_quantity or 0) for entry in entries if is_basic_pokemon(entry.card))
    effects = analyze_deck_effects(deck)
    outs = {
        name: {"count": value["cards"], "opening_probability": probability_at_least(total, value["cards"], opening_draws), "cards_seen_probability": probability_at_least(total, value["cards"], cards_seen)}
        for name, value in effects["outs"].items()
    }
    selected = _normalized_name(card_name)
    selected_entries = [entry for entry in entries if selected and _normalized_name(entry.card.name) == selected]
    key_card = None
    if selected_entries:
        copies = sum(int(entry.required_quantity or 0) for entry in selected_entries)
        key_card = {
            "name": selected_entries[0].card.name,
            "copies": copies,
            "opening_probability": probability_at_least(total, copies, opening_draws),
            "cards_seen_probability": probability_at_least(total, copies, cards_seen),
            "prize_risk": prize_risk(total, copies, prize_count),
        }
    return {
        "deck_size": total,
        "opening_hand_size": opening_draws,
        "subsequent_draws": subsequent_draws,
        "cards_seen": cards_seen,
        "prize_count": min(max(prize_count, 0), total),
        "basic_pokemon": {"count": basic_count, "at_least_one": probability_at_least(total, basic_count, opening_draws), "none": 1 - probability_at_least(total, basic_count, opening_draws)},
        "outs": outs,
        "key_card": key_card,
    }
