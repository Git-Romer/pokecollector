import unittest

from services.wishlist_missing import plan_missing_wishlist_additions


class WishlistMissingTests(unittest.TestCase):
    def test_only_missing_cards_are_planned_for_global_wishlist(self):
        plan = plan_missing_wishlist_additions(
            entries=[("trainer-1_en", 4), ("energy-1_en", 2), ("pokemon-1_en", 1)],
            owned_quantities={"trainer-1_en": 4, "energy-1_en": 1, "pokemon-1_en": 0},
            existing_wishlist_card_ids=set(),
        )

        self.assertEqual(plan.card_ids_to_add, ["energy-1_en", "pokemon-1_en"])
        self.assertEqual(plan.missing_copies, 2)
        self.assertEqual(plan.skipped_complete, 1)
        self.assertEqual(plan.skipped_existing, 0)

    def test_existing_wishlist_cards_are_not_added_again(self):
        plan = plan_missing_wishlist_additions(
            entries=[("trainer-1_en", 4), ("energy-1_en", 2)],
            owned_quantities={"trainer-1_en": 2, "energy-1_en": 0},
            existing_wishlist_card_ids={"trainer-1_en"},
        )

        self.assertEqual(plan.card_ids_to_add, ["energy-1_en"])
        self.assertEqual(plan.missing_copies, 4)
        self.assertEqual(plan.skipped_complete, 0)
        self.assertEqual(plan.skipped_existing, 1)
        self.assertEqual(plan.skipped, 1)

    def test_duplicate_entries_are_combined_before_subtracting_owned_copies(self):
        plan = plan_missing_wishlist_additions(
            entries=[("trainer-1_en", 2), ("trainer-1_en", 2)],
            owned_quantities={"trainer-1_en": 3},
            existing_wishlist_card_ids=set(),
        )

        self.assertEqual(plan.card_ids_to_add, ["trainer-1_en"])
        self.assertEqual(plan.missing_copies, 1)
        self.assertEqual(plan.checked, 1)


if __name__ == "__main__":
    unittest.main()
