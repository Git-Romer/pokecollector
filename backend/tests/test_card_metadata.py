import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card
    from services.card_metadata import (
        METADATA_ENRICHMENT_COOLDOWN,
        card_needs_metadata_enrichment,
        enrich_cards_metadata,
        enrich_missing_card_metadata,
    )
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
            last_metadata_enrichment_attempt_at=now - datetime.timedelta(hours=1),
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
            last_metadata_enrichment_attempt_at=(
                now - METADATA_ENRICHMENT_COOLDOWN - datetime.timedelta(seconds=1)
            ),
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


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class CardMetadataAttemptPersistenceTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()

    def _add_brief_card(self, card_id: str = "smp-SM170_en") -> Card:
        card = Card(
            id=card_id,
            tcg_card_id=card_id.removesuffix("_en"),
            name="Promo Pikachu",
            lang="en",
            is_custom=False,
            updated_at=datetime.datetime(2020, 1, 1),
        )
        self.db.add(card)
        self.db.commit()
        return card

    def test_missing_metadata_records_dedicated_attempt_without_touching_updated_at(self):
        card = self._add_brief_card()

        with patch("services.card_metadata.pokemon_api.get_card", return_value=None) as get_card:
            first = enrich_cards_metadata(self.db, [card], limit=1)
            self.db.refresh(card)
            second = enrich_cards_metadata(self.db, [card], limit=1)

        self.assertEqual(first["attempted"], 1)
        self.assertEqual(first["missing"], 1)
        self.assertIsNotNone(card.last_metadata_enrichment_attempt_at)
        self.assertEqual(card.updated_at, datetime.datetime(2020, 1, 1))
        self.assertEqual(second["attempted"], 0)
        get_card.assert_called_once_with("smp-SM170", lang="en")

    def test_failed_metadata_fetch_still_records_attempt(self):
        card = self._add_brief_card("smp-SM171_en")

        with patch(
            "services.card_metadata.pokemon_api.get_card",
            side_effect=RuntimeError("upstream unavailable"),
        ):
            result = enrich_cards_metadata(self.db, [card], limit=1)

        self.db.refresh(card)
        self.assertEqual(result["attempted"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertIsNotNone(card.last_metadata_enrichment_attempt_at)

    def test_successful_metadata_fetch_preserves_attempt_timestamp(self):
        card = self._add_brief_card("base1-1_en")
        parsed = {
            "id": card.id,
            "tcg_card_id": card.tcg_card_id,
            "name": card.name,
            "rarity": "Rare",
            "types": ["Psychic"],
            "supertype": "Pokemon",
            "subtypes": ["Stage 2"],
            "dex_ids": [65],
            "cardmarket_products": [],
            "lang": "en",
            "is_custom": False,
        }

        with patch("services.card_metadata.pokemon_api.get_card", return_value={"id": "base1-1"}), \
             patch("services.card_metadata.pokemon_api.parse_card_for_db", return_value=parsed), \
             patch(
                 "services.card_metadata.apply_cross_language_fallbacks",
                 side_effect=lambda _db, value: value,
             ):
            result = enrich_cards_metadata(self.db, [card], limit=1)

        self.db.refresh(card)
        self.assertEqual(result["attempted"], 1)
        self.assertEqual(result["updated"], 1)
        self.assertIsNotNone(card.last_metadata_enrichment_attempt_at)
        self.assertEqual(card.rarity, "Rare")

    def test_atomic_claim_prevents_stale_session_from_fetching_same_card_twice(self):
        card = self._add_brief_card()
        second_db = self.Session()
        stale_card = second_db.query(Card).filter(Card.id == card.id).first()
        try:
            with patch("services.card_metadata.pokemon_api.get_card", return_value=None) as get_card:
                first = enrich_cards_metadata(self.db, [card], limit=1)
                second = enrich_cards_metadata(second_db, [stale_card], limit=1)
        finally:
            second_db.close()

        self.assertEqual(first["attempted"], 1)
        self.assertEqual(second["attempted"], 0)
        self.assertEqual(second["deferred"], 1)
        get_card.assert_called_once_with("smp-SM170", lang="en")

    def test_forced_refresh_rejects_stale_concurrent_claim(self):
        card = self._add_brief_card()
        second_db = self.Session()
        stale_card = second_db.query(Card).filter(Card.id == card.id).first()
        try:
            with patch("services.card_metadata.pokemon_api.get_card", return_value=None) as get_card:
                first = enrich_cards_metadata(
                    self.db,
                    [card],
                    limit=1,
                    force=True,
                    ignore_cooldown=True,
                )
                second = enrich_cards_metadata(
                    second_db,
                    [stale_card],
                    limit=1,
                    force=True,
                    ignore_cooldown=True,
                )
        finally:
            second_db.close()

        self.assertEqual(first["attempted"], 1)
        self.assertEqual(second["attempted"], 0)
        self.assertEqual(second["deferred"], 1)
        get_card.assert_called_once_with("smp-SM170", lang="en")

    def test_full_sync_candidates_prioritize_never_attempted_then_oldest_due(self):
        now = datetime.datetime.utcnow()
        never = self._add_brief_card("never-1_en")
        oldest = self._add_brief_card("oldest-1_en")
        newer = self._add_brief_card("newer-1_en")
        recent = self._add_brief_card("recent-1_en")
        oldest_attempt = now - datetime.timedelta(days=10)
        newer_attempt = now - datetime.timedelta(days=8)
        recent_attempt = now - datetime.timedelta(days=1)
        oldest.last_metadata_enrichment_attempt_at = oldest_attempt
        newer.last_metadata_enrichment_attempt_at = newer_attempt
        recent.last_metadata_enrichment_attempt_at = recent_attempt
        self.db.commit()

        with patch("services.card_metadata.pokemon_api.get_card", return_value=None) as get_card:
            result = enrich_missing_card_metadata(self.db, limit=2)

        self.assertEqual(result["attempted"], 2)
        self.assertEqual(
            [call.args[0] for call in get_card.call_args_list],
            [never.tcg_card_id, oldest.tcg_card_id],
        )
        self.db.refresh(newer)
        self.db.refresh(recent)
        self.assertEqual(newer.last_metadata_enrichment_attempt_at, newer_attempt)
        self.assertEqual(recent.last_metadata_enrichment_attempt_at, recent_attempt)


if __name__ == "__main__":
    unittest.main()
