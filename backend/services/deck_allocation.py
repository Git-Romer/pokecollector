"""Derived shared collection availability for reserved decks, keyed by card_id."""

from collections import defaultdict


def allocation_for_decks(decks, owned_quantities, current_deck_id=None):
    reserved, users = defaultdict(int), defaultdict(list)
    for deck in decks:
        if getattr(deck, "inventory_state", "planning") != "reserved":
            continue
        for entry in deck.entries:
            quantity = int(entry.required_quantity or 0)
            reserved[entry.card_id] += quantity
            users[entry.card_id].append({"deck_id": deck.id, "name": deck.name, "quantity": quantity})
    result = {}
    for card_id in set(owned_quantities) | set(reserved):
        own = sum(item["quantity"] for item in users[card_id] if item["deck_id"] == current_deck_id)
        elsewhere, owned = max(reserved[card_id] - own, 0), int(owned_quantities.get(card_id, 0))
        result[card_id] = {"owned_quantity": owned, "reserved_in_other_decks": elsewhere, "available_to_this_deck": max(owned - elsewhere, 0), "reserved_total": reserved[card_id], "conflict": max(reserved[card_id] - owned, 0), "decks": users[card_id]}
    return result
