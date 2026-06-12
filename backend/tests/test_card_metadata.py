import unittest

try:
    from models import Card
    from services.card_metadata import card_needs_metadata_enrichment
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class CardMetadataEnrichmentTests(unittest.TestCase):
    def test_brief_api_card_needs_metadata_enrichment(self):
        card = Card(
            id="xy1-1_en",
            tcg_card_id="xy1-1",
            name="Venusaur EX",
            number="1",
            images_small="https://example.test/low.webp",
            lang="en",
            is_custom=False,
        )

        self.assertTrue(card_needs_metadata_enrichment(card))

    def test_enriched_card_does_not_need_metadata_enrichment(self):
        card = Card(
            id="xy1-1_en",
            tcg_card_id="xy1-1",
            name="Venusaur EX",
            rarity="Ultra Rare",
            types=["Grass"],
            supertype="Pokemon",
            subtypes=["Basic", "EX"],
            lang="en",
            is_custom=False,
        )

        self.assertFalse(card_needs_metadata_enrichment(card))

    def test_enriched_trainer_does_not_need_elemental_type(self):
        card = Card(
            id="sv1-166_en",
            tcg_card_id="sv1-166",
            name="Professor's Research",
            rarity="Uncommon",
            supertype="Trainer",
            subtypes=["Supporter"],
            trainer_type="Supporter",
            lang="en",
            is_custom=False,
        )

        self.assertFalse(card_needs_metadata_enrichment(card))

    def test_pokemon_missing_elemental_type_needs_metadata_enrichment(self):
        card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Sprigatito",
            rarity="Common",
            supertype="Pokemon",
            subtypes=["Basic"],
            lang="en",
            is_custom=False,
        )

        self.assertTrue(card_needs_metadata_enrichment(card))

    def test_partially_populated_card_needs_metadata_enrichment(self):
        card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Partial card",
            rarity="Common",
            lang="en",
            is_custom=False,
        )

        self.assertTrue(card_needs_metadata_enrichment(card))

    def test_custom_card_does_not_need_metadata_enrichment(self):
        card = Card(
            id="custom-1",
            name="Custom card",
            lang="en",
            is_custom=True,
        )

        self.assertFalse(card_needs_metadata_enrichment(card))


if __name__ == "__main__":
    unittest.main()
