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

from api.cards import search_cards
from services.pokemon_api import extract_cardmarket_products, extract_dex_ids, infer_dex_ids_from_name, parse_card_for_db
from services.pokedex import aggregate_pokedex, load_pokedex, normalize_dex_ids, species_detail
from services.pokedex_forms import (
    classify_pokedex_entries,
    form_catalogue_by_key,
    get_entry,
    split_entry_key,
)
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
from scripts import cache_pokedex_images


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

    def test_tcgplayer_prices_override_contradictory_variant_flags(self):
        parsed = parse_card_for_db({
            "id": "me04-068",
            "localId": "068",
            "name": "Goodra",
            "category": "Pokemon",
            "variants": {"normal": True, "reverse": False, "holo": False},
            "pricing": {
                "tcgplayer": {
                    "reverse-holofoil": {"marketPrice": 0.22},
                    "holofoil": {"marketPrice": 0.41},
                },
            },
        }, lang="en")

        self.assertTrue(parsed["variants_normal"])
        self.assertTrue(parsed["variants_reverse"])
        self.assertTrue(parsed["variants_holo"])

    def test_empty_tcgplayer_prices_do_not_override_variant_flags(self):
        parsed = parse_card_for_db({
            "id": "me04-069",
            "localId": "069",
            "name": "Test card",
            "category": "Pokemon",
            "variants": {"normal": True, "reverse": False, "holo": False},
            "pricing": {
                "tcgplayer": {
                    "reverse-holofoil": {"marketPrice": None, "lowPrice": 0},
                    "holofoil": {"marketPrice": float("nan")},
                },
            },
        }, lang="en")

        self.assertTrue(parsed["variants_normal"])
        self.assertFalse(parsed["variants_reverse"])
        self.assertFalse(parsed["variants_holo"])

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

    def test_form_catalogue_has_stable_keys_and_specific_artwork(self):
        charizard_x = form_catalogue_by_key()["6:mega-x"]
        self.assertEqual(charizard_x["display_number"], "#006-MX")
        self.assertEqual(charizard_x["image_id"], 10034)
        self.assertEqual(split_entry_key("6:mega-x"), (6, "mega-x"))
        self.assertIsNone(get_entry("6:gigantamax"))

    def test_classifier_separates_base_regional_and_mixed_cards(self):
        self.assertEqual(classify_pokedex_entries("Charizard", [6]), ["6"])
        self.assertEqual(classify_pokedex_entries("Alolan Raichu", [26]), ["26:alola"])
        self.assertEqual(
            classify_pokedex_entries("Raichu & Alolan Raichu GX", [26]),
            ["26", "26:alola"],
        )
        self.assertEqual(
            classify_pokedex_entries("Rowlet & Alolan Exeggutor GX", [722, 103]),
            ["722", "103:alola"],
        )

    def test_classifier_splits_localized_mixed_card_conjunctions(self):
        names = (
            "Raichu y Raichu de Alola GX",
            "Raichu e Raichu di Alola GX",
            "Raichu e Raichu de Alola GX",
            "Raichu en Alola Raichu GX",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(
                    classify_pokedex_entries(name, [26]),
                    ["26", "26:alola"],
                )

    def test_classifier_preserves_non_latin_form_markers_and_mixed_order(self):
        self.assertEqual(classify_pokedex_entries("アローラサンド", [27]), ["27:alola"])
        self.assertEqual(classify_pokedex_entries("阿羅拉 六尾V", [37]), ["37:alola"])
        self.assertEqual(
            classify_pokedex_entries("モクロー&アローラナッシーGX", [722, 103]),
            ["722", "103:alola"],
        )
        self.assertEqual(
            classify_pokedex_entries("ライチュウ&アローラライチュウGX", [26]),
            ["26", "26:alola"],
        )
        self.assertEqual(classify_pokedex_entries("超級噴火龍Y ex", [6]), ["6:mega-y"])

    def test_classifier_uses_legacy_mega_artwork_overrides(self):
        self.assertEqual(
            classify_pokedex_entries("M Charizard EX", [6], tcg_card_id="xy2-69"),
            ["6:mega-x"],
        )
        self.assertEqual(
            classify_pokedex_entries("M Charizard EX", [6], tcg_card_id="xy2-13"),
            ["6:mega-y"],
        )

    def test_parse_full_card_derives_form_entries(self):
        parsed = parse_card_for_db({
            "id": "me02.5-022", "name": "Mega Charizard Y ex",
            "localId": "022", "category": "Pokemon", "dexId": [6],
        }, lang="en")
        self.assertEqual(parsed["pokedex_entry_ids"], ["6:mega-y"])


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

    def _entry_id(self, result, entry_id):
        return next(entry for entry in result["entries"] if entry["entry_id"] == entry_id)

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

    def test_separate_forms_do_not_credit_the_base_species(self):
        mega = Card(
            id="mega-y_en", tcg_card_id="mega-y", name="Mega Charizard Y ex",
            lang="en", is_custom=False, supertype="Pokemon", dex_ids=[6],
            pokedex_entry_ids=["6:mega-y"],
        )
        self.db.add(mega)
        self.db.commit()
        self.db.add(CollectionItem(card_id=mega.id, user_id=self.user.id, quantity=1, lang="en"))
        self.db.commit()

        grouped = aggregate_pokedex(self.db, self.user.id, mode="grouped", generation=1)
        separate = aggregate_pokedex(self.db, self.user.id, mode="forms", generation=1)
        self.assertTrue(self._entry(grouped, 6)["owned"])
        self.assertFalse(self._entry_id(separate, "6")["owned"])
        self.assertTrue(self._entry_id(separate, "6:mega-y")["owned"])

    def test_mixed_form_card_credits_each_exact_entry(self):
        mixed = Card(
            id="mixed_en", tcg_card_id="mixed", name="Raichu & Alolan Raichu GX",
            lang="en", is_custom=False, supertype="Pokemon", dex_ids=[26],
            pokedex_entry_ids=["26", "26:alola"],
        )
        self.db.add(mixed)
        self.db.commit()
        self.db.add(CollectionItem(card_id=mixed.id, user_id=self.user.id, quantity=2, lang="en"))
        self.db.commit()

        result = aggregate_pokedex(self.db, self.user.id, mode="forms", generation=1)
        self.assertEqual(self._entry_id(result, "26")["owned_cards"], 2)
        self.assertEqual(self._entry_id(result, "26:alola")["owned_cards"], 2)

    def test_null_mapping_fallback_is_shared_by_overview_detail_and_search(self):
        card = Card(
            id="mega-y-pending_en", tcg_card_id="mega-y-pending",
            name="Mega Charizard Y ex", lang="en", is_custom=False,
            supertype="Pokemon", dex_ids=[6], pokedex_entry_ids=None,
        )
        self.db.add(card)
        self.db.commit()

        overview = aggregate_pokedex(self.db, self.user.id, language="en", mode="forms")
        self.assertEqual(self._entry_id(overview, "6:mega-y")["available_printings"], 1)

        detail = species_detail(self.db, self.user.id, "6:mega-y", language="en", mode="forms")
        self.assertIn("6:mega-y", {row["entry_id"] for row in detail["related_forms"]})

        result = search_cards(
            pokedex_entry_id="6:mega-y", type_filter=None,
            lang="en", page=1, page_size=20,
            db=self.db, current_user=self.user, background_tasks=None,
        )
        self.assertEqual(result["total_count"], 1)
        self.assertEqual(result["data"][0]["id"], card.id)

    def test_related_forms_use_the_same_language_visibility_as_overview(self):
        self.db.add(Card(
            id="mega-x-fr", tcg_card_id="mega-x-fr", name="Méga-Dracaufeu X-ex",
            lang="fr", is_custom=False, supertype="Pokémon", dex_ids=[6],
            pokedex_entry_ids=["6:mega-x"],
        ))
        self.db.commit()

        overview = aggregate_pokedex(self.db, self.user.id, language="en", mode="forms")
        self.assertNotIn("6:mega-x", {row["entry_id"] for row in overview["entries"]})
        detail = species_detail(self.db, self.user.id, "6", language="en", mode="forms")
        self.assertNotIn("6:mega-x", {row["entry_id"] for row in detail["related_forms"]})


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

    def test_name_fallback_revision_upgrades_forms_without_refetching(self):
        card = Card(
            id="base-26_en", tcg_card_id="base-26", name="Alolan Raichu",
            lang="en", is_custom=False, supertype="Pokemon", dex_ids=[26],
            cardmarket_products=[], pokedex_entry_ids=None,
        )
        self.db.add_all([
            Setting(key=COMPLETED_SETTING_KEY, value="true"),
            Setting(key=REVISION_SETTING_KEY, value="name-fallback-v1"),
            card,
        ])
        self.db.commit()

        with patch("services.pokedex_backfill.enrich_cards_metadata") as enrich:
            result = run_pokedex_metadata_backfill(self.db)

        enrich.assert_not_called()
        self.db.refresh(card)
        self.assertTrue(result["forms_only_upgrade"])
        self.assertEqual(card.pokedex_entry_ids, ["26:alola"])
        self.assertTrue(pokedex_metadata_backfill_completed(self.db))

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

    def test_form_only_backfill_is_detected_and_does_not_call_tcgdex(self):
        card = Card(
            id="me02.5-022_en", tcg_card_id="me02.5-022",
            name="Mega Charizard Y ex", lang="en", is_custom=False,
            supertype="Pokemon", dex_ids=[6], cardmarket_products=[],
            pokedex_entry_ids=None,
        )
        self.db.add(card)
        self.db.commit()
        self.assertEqual(missing_pokedex_metadata_count(self.db), 1)

        with patch("services.pokedex_backfill.enrich_cards_metadata") as enrich:
            result = run_pokedex_metadata_backfill(self.db)

        enrich.assert_not_called()
        self.db.refresh(card)
        self.assertEqual(card.pokedex_entry_ids, ["6:mega-y"])
        self.assertEqual(result["form_entries_updated"], 1)
        self.assertEqual(missing_pokedex_metadata_count(self.db), 0)

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

    def test_default_prewarm_includes_species_and_curated_form_images(self):
        completed = {"cached": 0, "downloaded": 0, "missing": [], "failed": []}
        with patch.object(sys, "argv", ["cache_pokedex_images.py"]), \
             patch.object(cache_pokedex_images, "populate_image_ids", return_value=completed) as populate:
            self.assertEqual(cache_pokedex_images.main(), 0)

        image_ids = list(populate.call_args.args[0])
        self.assertIn(1, image_ids)
        self.assertIn(1025, image_ids)
        self.assertIn(10034, image_ids)


if __name__ == "__main__":
    unittest.main()
