import datetime
import unittest

try:
    from models import Card
    from services.card_metadata import METADATA_ENRICHMENT_COOLDOWN, card_needs_metadata_enrichment
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
            dex_ids=[3],
            cardmarket_products=[],
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

    def test_accented_pokemon_category_missing_pokedex_metadata_needs_enrichment(self):
        card = Card(
            id="sv1-1_de",
            tcg_card_id="sv1-1",
            name="Felori",
            rarity="Common",
            types=["Grass"],
            supertype="Pokémon",
            subtypes=["Basis"],
            lang="de",
            is_custom=False,
        )

        self.assertTrue(card_needs_metadata_enrichment(card))

    def test_accented_pokemon_category_with_checked_pokedex_metadata_is_complete(self):
        card = Card(
            id="sv1-1_de",
            tcg_card_id="sv1-1",
            name="Felori",
            rarity="Common",
            types=["Grass"],
            supertype="Pokémon",
            subtypes=["Basis"],
            dex_ids=[906],
            cardmarket_products=[],
            lang="de",
            is_custom=False,
        )

        self.assertFalse(card_needs_metadata_enrichment(card))

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

    def test_recently_attempted_card_is_within_cooldown(self):
        now = datetime.datetime(2026, 8, 1, 12, 0, 0)
        card = Card(
            id="smp-SM170_en",
            tcg_card_id="smp-SM170",
            name="Promo Pikachu",
            lang="en",
            is_custom=False,
            updated_at=now - datetime.timedelta(hours=1),
        )

        self.assertFalse(card_needs_metadata_enrichment(card, now=now))

    def test_card_past_cooldown_needs_metadata_enrichment_again(self):
        now = datetime.datetime(2026, 8, 1, 12, 0, 0)
        card = Card(
            id="smp-SM170_en",
            tcg_card_id="smp-SM170",
            name="Promo Pikachu",
            lang="en",
            is_custom=False,
            updated_at=now - METADATA_ENRICHMENT_COOLDOWN - datetime.timedelta(seconds=1),
        )

        self.assertTrue(card_needs_metadata_enrichment(card, now=now))

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
