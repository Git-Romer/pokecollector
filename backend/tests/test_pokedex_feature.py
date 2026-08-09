import datetime
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import Card, CollectionItem, Setting, User

from services.pokemon_api import extract_cardmarket_products, extract_dex_ids, infer_dex_ids_from_name, parse_card_for_db
from services.pokedex import aggregate_pokedex, load_pokedex, normalize_dex_ids
from services.pokedex_backfill import (
    COMPLETED_SETTING_KEY,
    CURRENT_BACKFILL_REVISION,
    REVISION_SETTING_KEY,
    STATUS_SETTING_KEY,
    missing_pokedex_metadata_count,
    pokedex_metadata_backfill_completed,
    run_pokedex_metadata_backfill,
)
from services import pokedex_images


class PokedexMetadataTests(unittest.TestCase):
    def test_catalogue_contains_complete_national_dex(self):
        catalogue = load_pokedex()
        self.assertEqual(len(catalogue), 1025)
        self.assertEqual(catalogue[93]["name_en"], "Gengar")
        self.assertEqual(catalogue[93]["name_de"], "Gengar")
        self.assertEqual(catalogue[1024]["name_en"], "Pecharunt")

    def test_dex_ids_accept_scalar_and_multiple_values(self):
        self.assertEqual(extract_dex_ids({"dexId": 94}), [94])
        self.assertEqual(extract_dex_ids({"dexId": [25, "133", 25, None]}), [25, 133])
        self.assertEqual(normalize_dex_ids([25, "133", 25, 0, 1026]), [25, 133])

    def test_cardmarket_products_preserve_variant_and_foil(self):
        data = {
            "variants": [
                {"type": "holo", "thirdParty": {"cardmarket": 733689}},
                {"type": "reverse", "thirdParty": {"cardmarket": 733689}},
                {"type": "holo", "foil": "galaxy", "thirdParty": {"cardmarket": 861151}},
            ]
        }
        self.assertEqual(
            extract_cardmarket_products(data),
            [
                {"variant": "holo", "foil": None, "product_id": 733689},
                {"variant": "reverse", "foil": None, "product_id": 733689},
                {"variant": "holo", "foil": "galaxy", "product_id": 861151},
            ],
        )

    def test_parse_full_card_adds_pokedex_and_cardmarket_metadata(self):
        parsed = parse_card_for_db({
            "id": "sv03.5-094",
            "localId": "094",
            "name": "Gengar",
            "category": "Pokemon",
            "dexId": [94],
            "variants": [
                {"type": "holo", "thirdParty": {"cardmarket": 733689}},
            ],
        }, lang="en")
        self.assertEqual(parsed["dex_ids"], [94])
        self.assertEqual(parsed["cardmarket_products"][0]["product_id"], 733689)
        # Rich variant arrays also populate the legacy availability booleans.
        self.assertTrue(parsed["variants_holo"])

    def test_missing_dex_id_falls_back_to_mega_species_name(self):
        self.assertEqual(infer_dex_ids_from_name({
            "name": "Mega-Glurak Y-ex",
            "category": "Pokémon",
        }), [6])
        self.assertEqual(infer_dex_ids_from_name({
            "name": "Mega Charizard Y ex",
            "category": "Pokemon",
        }), [6])
        self.assertEqual(parse_card_for_db({
            "id": "me02.5-022",
            "localId": "022",
            "name": "Mega-Glurak Y-ex",
            "category": "Pokémon",
            "dexId": None,
        }, lang="de")["dex_ids"], [6])

    def test_name_fallback_does_not_apply_to_trainers(self):
        self.assertIsNone(infer_dex_ids_from_name({
            "name": "Mega-Signal",
            "category": "Trainer",
        }))

    def test_full_card_without_mapping_marks_metadata_as_checked(self):
        parsed = parse_card_for_db({
            "id": "base1-1",
            "localId": "1",
            "name": "Trainer",
            "category": "Trainer",
        }, lang="en")
        self.assertEqual(parsed["dex_ids"], [])
        self.assertEqual(parsed["cardmarket_products"], [])

    def test_brief_card_keeps_metadata_null_for_later_enrichment(self):
        parsed = parse_card_for_db({
            "id": "base1-1",
            "localId": "1",
            "name": "Brief card",
        }, lang="en")
        self.assertIsNone(parsed["dex_ids"])
        self.assertIsNone(parsed["cardmarket_products"])


class PokedexAggregationTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="misty", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Setting(key="tcgdex_digital_sets_enabled", value="true"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _entry(self, result, dex_id):
        return next(entry for entry in result["entries"] if entry["dex_id"] == dex_id)

    def test_ownership_is_derived_from_collection_and_updates_after_removal(self):
        gengar = Card(
            id="sv03.5-094_en", tcg_card_id="sv03.5-094", name="Gengar",
            number="094", lang="en", is_custom=False, dex_ids=[94],
        )
        self.db.add(gengar)
        self.db.commit()

        missing = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertFalse(self._entry(missing, 94)["owned"])

        owned_item = CollectionItem(card_id=gengar.id, user_id=self.user.id, quantity=2, lang="en")
        self.db.add(owned_item)
        self.db.commit()
        owned = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertTrue(self._entry(owned, 94)["owned"])
        self.assertEqual(self._entry(owned, 94)["owned_cards"], 2)

        self.db.delete(owned_item)
        self.db.commit()
        removed = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertFalse(self._entry(removed, 94)["owned"])

    def test_multispecies_card_counts_for_each_species(self):
        card = Card(
            id="multi-1_en", tcg_card_id="multi-1", name="Friends",
            lang="en", is_custom=False, dex_ids=[25, 133],
        )
        self.db.add(card)
        self.db.commit()
        self.db.add(CollectionItem(card_id=card.id, user_id=self.user.id, quantity=1, lang="en"))
        self.db.commit()

        result = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertTrue(self._entry(result, 25)["owned"])
        self.assertTrue(self._entry(result, 133)["owned"])

    def test_available_printings_are_deduplicated_across_languages(self):
        self.db.add_all([
            Card(id="base-1_en", tcg_card_id="base-1", name="Gengar", lang="en", is_custom=False, dex_ids=[94]),
            Card(id="base-1_de", tcg_card_id="base-1", name="Gengar", lang="de", is_custom=False, dex_ids=[94]),
            Card(id="other-1_en", tcg_card_id="other-1", name="Gengar", lang="en", is_custom=False, dex_ids=[94]),
        ])
        self.db.commit()
        result = aggregate_pokedex(self.db, self.user.id, language="all", generation=1)
        self.assertEqual(self._entry(result, 94)["available_printings"], 2)

    def test_search_accepts_padded_and_unpadded_numbers(self):
        padded = aggregate_pokedex(self.db, self.user.id, search="094")
        unpadded = aggregate_pokedex(self.db, self.user.id, search="94")
        self.assertEqual([row["dex_id"] for row in padded["entries"]], [94])
        self.assertEqual([row["dex_id"] for row in unpadded["entries"]], [94])


class PokedexBackfillTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()

    def tearDown(self):
        self.db.close()

    def test_completed_marker_skips_startup_backfill(self):
        self.db.add_all([
            Setting(key=COMPLETED_SETTING_KEY, value="true"),
            Setting(key=REVISION_SETTING_KEY, value=CURRENT_BACKFILL_REVISION),
            Card(id="base-25_en", tcg_card_id="base-25", name="Pikachu", lang="en", is_custom=False, supertype="Pokemon"),
        ])
        self.db.commit()

        with patch("services.pokedex_backfill.enrich_cards_metadata") as enrich:
            result = run_pokedex_metadata_backfill(self.db)

        self.assertTrue(result["skipped"])
        enrich.assert_not_called()

    def test_backfill_marks_complete_after_missing_rows_are_enriched(self):
        self.db.add(Card(
            id="base-25_en",
            tcg_card_id="base-25",
            name="Pikachu",
            lang="en",
            is_custom=False,
            supertype="Pokemon",
        ))
        self.db.commit()
        self.assertEqual(missing_pokedex_metadata_count(self.db), 1)

        def enrich(db, cards, **_kwargs):
            for card in cards:
                card.dex_ids = [25]
                card.cardmarket_products = []
                db.add(card)
            db.commit()
            return {"attempted": len(cards), "updated": len(cards), "missing": 0, "failed": 0, "ids": [card.id for card in cards]}

        with patch("services.pokedex_backfill.enrich_cards_metadata", side_effect=enrich):
            result = run_pokedex_metadata_backfill(self.db, batch_limit=10)

        self.assertTrue(result["completed"])
        self.assertEqual(result["attempted"], 1)
        self.assertTrue(pokedex_metadata_backfill_completed(self.db))
        self.assertEqual(self.db.query(Setting).filter(Setting.key == STATUS_SETTING_KEY).count(), 1)
        self.assertEqual(missing_pokedex_metadata_count(self.db), 0)

    def test_old_completed_marker_without_current_revision_runs_again(self):
        self.db.add_all([
            Setting(key=COMPLETED_SETTING_KEY, value="true"),
            Card(
                id="me02.5-022_de",
                tcg_card_id="me02.5-022",
                name="Mega-Glurak Y-ex",
                lang="de",
                is_custom=False,
                supertype="Pokémon",
                dex_ids=[],
                cardmarket_products=[],
            ),
        ])
        self.db.commit()

        def enrich(db, cards, **_kwargs):
            for card in cards:
                card.dex_ids = [6]
                db.add(card)
            db.commit()
            return {"attempted": len(cards), "updated": len(cards), "missing": 0, "failed": 0, "ids": [card.id for card in cards]}

        with patch("services.pokedex_backfill.enrich_cards_metadata", side_effect=enrich):
            result = run_pokedex_metadata_backfill(self.db, batch_limit=10)

        self.assertTrue(result["completed"])
        self.assertTrue(pokedex_metadata_backfill_completed(self.db))
        revision = self.db.query(Setting).filter(Setting.key == REVISION_SETTING_KEY).one()
        self.assertEqual(revision.value, CURRENT_BACKFILL_REVISION)

    def test_missing_rows_are_attempted_once_without_looping_forever(self):
        self.db.add(Card(
            id="missing-25_en",
            tcg_card_id="missing-25",
            name="Missing",
            lang="en",
            is_custom=False,
            supertype="Pokemon",
        ))
        self.db.commit()
        attempts = []

        def enrich(db, cards, **_kwargs):
            attempts.extend(card.id for card in cards)
            for card in cards:
                card.updated_at = datetime.datetime.utcnow()
                db.add(card)
            db.commit()
            return {"attempted": len(cards), "updated": 0, "missing": len(cards), "failed": 0, "ids": []}

        with patch("services.pokedex_backfill.enrich_cards_metadata", side_effect=enrich):
            result = run_pokedex_metadata_backfill(self.db, batch_limit=1, batch_delay_seconds=0)

        self.assertTrue(result["completed"])
        self.assertEqual(result["attempted"], 1)
        self.assertEqual(attempts, ["missing-25_en"])
        self.assertEqual(missing_pokedex_metadata_count(self.db), 1)
        self.assertTrue(pokedex_metadata_backfill_completed(self.db))

    def test_empty_pokemon_dex_ids_are_retried_by_backfill(self):
        self.db.add(Card(
            id="me02.5-022_de",
            tcg_card_id="me02.5-022",
            name="Mega-Glurak Y-ex",
            lang="de",
            is_custom=False,
            supertype="Pokémon",
            dex_ids=[],
            cardmarket_products=[],
        ))
        self.db.commit()
        self.assertEqual(missing_pokedex_metadata_count(self.db), 1)

    def test_real_backfill_refreshes_recent_attempt_and_marks_complete(self):
        card = Card(
            id="base-25_en",
            tcg_card_id="base-25",
            name="Pikachu",
            lang="en",
            is_custom=False,
            supertype="Pokemon",
            last_metadata_enrichment_attempt_at=datetime.datetime.utcnow(),
        )
        self.db.add(card)
        self.db.commit()
        parsed = {
            "id": card.id,
            "tcg_card_id": card.tcg_card_id,
            "name": card.name,
            "rarity": "Common",
            "types": ["Lightning"],
            "supertype": "Pokemon",
            "subtypes": ["Basic"],
            "dex_ids": [25],
            "cardmarket_products": [],
            "lang": "en",
            "is_custom": False,
        }

        with patch("services.card_metadata.pokemon_api.get_card", return_value={"id": "base-25"}), \
             patch("services.card_metadata.pokemon_api.parse_card_for_db", return_value=parsed), \
             patch(
                 "services.card_metadata.apply_cross_language_fallbacks",
                 side_effect=lambda _db, value: value,
             ):
            result = run_pokedex_metadata_backfill(
                self.db,
                batch_limit=10,
                batch_delay_seconds=0,
            )

        self.assertTrue(result["completed"])
        self.assertEqual(result["attempted"], 1)
        self.assertEqual(result["deferred"], 0)
        self.assertEqual(missing_pokedex_metadata_count(self.db), 0)
        self.assertTrue(pokedex_metadata_backfill_completed(self.db))

    def test_deferred_backfill_claim_does_not_mark_revision_complete(self):
        self.db.add(Card(
            id="base-25_en",
            tcg_card_id="base-25",
            name="Pikachu",
            lang="en",
            is_custom=False,
            supertype="Pokemon",
        ))
        self.db.commit()
        deferred = {
            "attempted": 0,
            "updated": 0,
            "missing": 0,
            "failed": 0,
            "deferred": 1,
            "ids": [],
        }

        with patch("services.pokedex_backfill.enrich_cards_metadata", return_value=deferred):
            result = run_pokedex_metadata_backfill(
                self.db,
                batch_limit=10,
                batch_delay_seconds=0,
            )

        self.assertFalse(result["completed"])
        self.assertEqual(result["deferred"], 1)
        self.assertFalse(pokedex_metadata_backfill_completed(self.db))

    def test_manual_refresh_bypasses_retry_cooldown(self):
        from scripts import backfill_pokedex_metadata

        card = Card(
            id="base-25_en",
            tcg_card_id="base-25",
            name="Pikachu",
            lang="en",
            is_custom=False,
            rarity="Common",
            types=["Lightning"],
            supertype="Pokemon",
            subtypes=["Basic"],
            dex_ids=[25],
            cardmarket_products=[],
            last_metadata_enrichment_attempt_at=datetime.datetime.utcnow(),
        )
        self.db.add(card)
        self.db.commit()
        parsed = {
            "id": card.id,
            "tcg_card_id": card.tcg_card_id,
            "name": card.name,
            "rarity": card.rarity,
            "types": card.types,
            "supertype": card.supertype,
            "subtypes": card.subtypes,
            "dex_ids": card.dex_ids,
            "cardmarket_products": card.cardmarket_products,
            "lang": card.lang,
            "is_custom": False,
        }

        with patch.object(backfill_pokedex_metadata, "SessionLocal", return_value=self.db), \
             patch.object(sys, "argv", ["backfill_pokedex_metadata.py", "--refresh", "--limit", "1"]), \
             patch("services.card_metadata.pokemon_api.get_card", return_value={"id": "base-25"}) as get_card, \
             patch("services.card_metadata.pokemon_api.parse_card_for_db", return_value=parsed), \
             patch(
                 "services.card_metadata.apply_cross_language_fallbacks",
                 side_effect=lambda _db, value: value,
             ):
            exit_code = backfill_pokedex_metadata.main()

        self.assertEqual(exit_code, 0)
        get_card.assert_called_once_with("base-25", lang="en")


class PokedexImageCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_root = pokedex_images.CACHE_ROOT
        pokedex_images.CACHE_ROOT = Path(self.temp_dir.name)

    def tearDown(self):
        pokedex_images.CACHE_ROOT = self.old_root
        self.temp_dir.cleanup()

    def test_cache_path_validates_kind_and_number(self):
        self.assertEqual(
            pokedex_images.cache_path("sprites", 94),
            Path(self.temp_dir.name) / "sprites" / "94.png",
        )
        with self.assertRaises(ValueError):
            pokedex_images.cache_path("../secret", 94)
        with self.assertRaises(ValueError):
            pokedex_images.cache_path("sprites", 0)

    def test_fetch_image_uses_existing_file_without_network(self):
        path = pokedex_images.cache_path("sprites", 94)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"png")
        client = Mock()
        self.assertEqual(pokedex_images.fetch_image("sprites", 94, client=client), path)
        client.get.assert_not_called()

    def test_fetch_image_writes_atomically(self):
        response = Mock(status_code=200, content=b"image-data")
        response.raise_for_status = Mock()
        client = Mock()
        client.get.return_value = response
        path = pokedex_images.fetch_image("artwork", 94, client=client)
        self.assertEqual(path.read_bytes(), b"image-data")
        self.assertFalse(any(path.parent.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
