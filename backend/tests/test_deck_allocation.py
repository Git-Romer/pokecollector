import unittest
from types import SimpleNamespace

from services.deck_allocation import allocation_for_decks, allocations_for_decks


def card_list(list_id, binder_type, card_id, quantity):
    allocation = SimpleNamespace(card_id=card_id, collection_item_id=list_id, required_quantity=quantity)
    return SimpleNamespace(id=list_id, name=f"List {list_id}", binder_type=binder_type, allocations=[allocation])


class DeckAllocationTests(unittest.TestCase):
    def test_multiple_deck_views_are_computed_together(self):
        a = card_list(1, "physical_deck", "ultra", 4)
        b = card_list(2, "physical_deck", "ultra", 3)
        result = allocations_for_decks([a, b], {"ultra": 8}, (1, 2))
        self.assertEqual(result[1]["ultra"]["available_to_this_deck"], 5)
        self.assertEqual(result[2]["ultra"]["available_to_this_deck"], 4)

    def test_exact_deck_allocations_share_inventory_without_self_subtraction(self):
        a, b = card_list(1, "physical_deck", "ultra", 3), card_list(2, "physical_deck", "ultra", 4)
        self.assertEqual(allocation_for_decks([a, b], {"ultra": 6}, 1)["ultra"]["available_to_this_deck"], 2)
        self.assertEqual(allocation_for_decks([a, b], {"ultra": 6}, 2)["ultra"]["available_to_this_deck"], 3)

    def test_planned_binders_do_not_allocate(self):
        a = card_list(1, "deck", "ultra", 3)
        b = card_list(2, "collection", "ultra", 4)
        c = card_list(3, "wishlist", "ultra", 4)
        result = allocation_for_decks([a, b, c], {"ultra": 6}, 1)["ultra"]
        self.assertEqual((result["reserved_total"], result["conflict"]), (4, 0))

    def test_unallocated_owned_cards_remain_free(self):
        a = card_list(1, "physical_deck", "partial", 4)
        b = card_list(2, "collection", "full", 4)
        c = card_list(3, "wishlist", "ignored", 6)
        d = card_list(4, "physical_deck", "over", 6)
        result = allocation_for_decks([a, b, c, d], {"unused": 4, "partial": 6, "full": 4, "over": 4})
        self.assertEqual(result["unused"]["available_to_this_deck"], 4)
        self.assertEqual(result["partial"]["available_to_this_deck"], 2)
        self.assertEqual(result["full"]["available_to_this_deck"], 0)
        self.assertEqual(result["over"]["conflict"], 2)


if __name__ == "__main__":
    unittest.main()
