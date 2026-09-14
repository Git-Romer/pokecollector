"""Shared owned-copy allocation across collection binders and deck card lists."""

from collections import defaultdict


def allocations_for_decks(card_lists, owned_quantities, current_deck_ids):
    """Summarize exact Card List allocations for several Decks in one pass.

    Collection binders and real decks use the same exact owned-copy rows.
    Planned binders and planned decks never reserve inventory.
    """
    deck_ids = tuple(current_deck_ids)
    tracked_deck_ids = set(deck_ids)
    reserved = defaultdict(int)
    users = defaultdict(list)
    current_by_deck = {deck_id: defaultdict(int) for deck_id in deck_ids}

    for card_list in card_lists:
        list_type = getattr(card_list, "binder_type", "collection") or "collection"
        if list_type not in {"collection", "physical_deck"}:
            continue
        allocations = getattr(card_list, "allocations", None)
        if allocations is None:
            allocations = [
                entry
                for entry in getattr(card_list, "binder_cards", [])
                if getattr(entry, "collection_item_id", None) is not None
            ]
        grouped = defaultdict(int)
        for allocation in allocations:
            quantity = max(int(getattr(allocation, "required_quantity", 0) or 0), 0)
            if quantity <= 0:
                continue
            grouped[allocation.card_id] += quantity
            reserved[allocation.card_id] += quantity
            if card_list.id in tracked_deck_ids:
                current_by_deck[card_list.id][allocation.card_id] += quantity
        for card_id, quantity in grouped.items():
            users[card_id].append({
                "deck_id": card_list.id,
                "name": card_list.name,
                "quantity": quantity,
                "type": list_type,
            })

    card_ids = set(owned_quantities) | set(reserved)
    results = {}
    for deck_id in deck_ids:
        current = current_by_deck[deck_id]
        result = {}
        for card_id in card_ids:
            own = current[card_id]
            total_reserved = reserved[card_id]
            elsewhere = max(total_reserved - own, 0)
            owned = int(owned_quantities.get(card_id, 0))
            result[card_id] = {
                "owned_quantity": owned,
                "reserved_in_other_decks": elsewhere,
                "reserved_in_this_deck": own,
                "available_to_this_deck": max(owned - elsewhere, 0),
                "reserved_total": total_reserved,
                "conflict": max(total_reserved - owned, 0),
                "decks": users[card_id],
            }
        results[deck_id] = result
    return results


def allocation_for_decks(card_lists, owned_quantities, current_deck_id=None):
    """Compatibility helper for callers that need one Deck allocation view."""
    return allocations_for_decks(
        card_lists,
        owned_quantities,
        (current_deck_id,),
    )[current_deck_id]
