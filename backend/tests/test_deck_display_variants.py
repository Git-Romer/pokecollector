import unittest
from types import SimpleNamespace

from services.deck_display_variants import representative_display_variants


class DeckDisplayVariantTests(unittest.TestCase):
    def test_prefers_holo_then_reverse_then_normal_deterministically(self):
        rows = [SimpleNamespace(card_id="a", variant="Normal"), SimpleNamespace(card_id="a", variant="Reverse Holo"), SimpleNamespace(card_id="b", variant="Holo")]
        self.assertEqual(representative_display_variants(rows), {"a": {"variant": "Reverse Holo"}, "b": {"variant": "Holo"}})

    def test_omits_cards_without_a_owned_variant(self):
        self.assertEqual(representative_display_variants([SimpleNamespace(card_id="a", variant=None)]), {})


if __name__ == "__main__":
    unittest.main()
