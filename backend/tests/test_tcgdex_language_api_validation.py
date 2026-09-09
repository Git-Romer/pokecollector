import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException

    from api.collection import (
        _add_collection_item,
        _collection_item_language,
        _normalize_request_lang,
        _parse_import_row,
        add_to_collection,
        bulk_add_to_collection,
        ensure_card_exists,
    )
    from api.settings import _normalize_tcgdex_sync_languages
    from schemas import BulkCollectionAddRequest, CollectionItemCreate
    from services.tcgdex_languages import SUPPORTED_TCGDEX_LANGUAGES
    API_VALIDATION_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_VALIDATION_DEPS_AVAILABLE = False


class _EmptyQuery:
    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return None


class _FakeCollectionDb:
    def __init__(self):
        self.added = []

    def query(self, *args, **kwargs):
        return _EmptyQuery()

    def add(self, item):
        self.added.append(item)

    def commit(self):
        pass

    def refresh(self, item):
        pass

    def rollback(self):
        pass


@unittest.skipUnless(API_VALIDATION_DEPS_AVAILABLE, "FastAPI is not installed in this lightweight test environment")
class TcgdexLanguageApiValidationTests(unittest.TestCase):
    def test_settings_api_accepts_supported_languages_and_aliases(self):
        self.assertEqual(_normalize_tcgdex_sync_languages("de,fr,zh_tw"), "fr,de,zh-tw")

    def test_settings_api_rejects_all_invalid_languages(self):
        with self.assertRaises(HTTPException) as ctx:
            _normalize_tcgdex_sync_languages("banana")
        self.assertEqual(ctx.exception.status_code, 422)

    def test_collection_import_normalizes_supported_language_alias(self):
        item = _parse_import_row({
            "set_code": "SV1",
            "number": "001",
            "quantity": "2",
            "condition": "NM",
            "variant": "",
            "lang": "zh_tw",
            "purchase_price": "",
        }, 2)
        self.assertEqual(item.lang, "zh-tw")

    def test_collection_import_rejects_invalid_language(self):
        with self.assertRaises(ValueError) as ctx:
            _parse_import_row({
                "set_code": "SV1",
                "number": "001",
                "quantity": "1",
                "condition": "NM",
                "variant": "Normal",
                "lang": "banana",
                "purchase_price": "",
            }, 2)
        self.assertIn("lang must be one of", str(ctx.exception))

    def test_collection_api_rejects_invalid_language(self):
        with self.assertRaises(HTTPException) as ctx:
            _normalize_request_lang("banana")
        self.assertEqual(ctx.exception.status_code, 422)

    def test_ensure_card_exists_prefers_composite_id_suffix_language(self):
        class FakeQuery:
            def filter(self, *args, **kwargs):
                return self

            def first(self):
                return None

        class FakeDb:
            def __init__(self):
                self.added = []

            def query(self, *args, **kwargs):
                return FakeQuery()

            def add(self, item):
                self.added.append(item)

            def commit(self):
                pass

            def refresh(self, item):
                pass

        fake_db = FakeDb()
        with patch("api.collection.pokemon_api.get_card", return_value={"id": "sv1-1", "name": "Test", "_lang": "zh-tw"}) as get_card:
            card = ensure_card_exists(fake_db, "sv1-1_zh-tw")

        self.assertGreaterEqual(get_card.call_count, 1)
        self.assertEqual(get_card.call_args_list[0].args, ("sv1-1",))
        self.assertEqual(get_card.call_args_list[0].kwargs, {"lang": "zh-tw"})
        self.assertEqual(card.id, "sv1-1_zh-tw")
        self.assertEqual(card.lang, "zh-tw")

    def test_add_collection_item_prefers_composite_id_suffix_over_default_lang(self):
        # item.lang defaults to "en" on CollectionItemCreate when the caller
        # doesn't pass it explicitly; a card_id with an explicit "_ja" suffix
        # must still win, not get silently coerced to English.
        fake_db = _FakeCollectionDb()
        user = type("User", (), {"id": 1})()
        item = CollectionItemCreate(card_id="PMCG3-031_ja", quantity=1)
        self.assertEqual(item.lang, "en")  # schema default, not overridden by the caller

        with patch("api.collection.ensure_card_exists") as ensure_card_exists_mock:
            result = _add_collection_item(fake_db, user, item)

        self.assertEqual(result, "added")
        ensure_card_exists_mock.assert_called_once_with(fake_db, "PMCG3-031_ja", lang="ja")
        self.assertEqual(fake_db.added[0].card_id, "PMCG3-031_ja")
        self.assertEqual(fake_db.added[0].lang, "ja")

    def test_every_supported_composite_suffix_is_authoritative(self):
        for lang in SUPPORTED_TCGDEX_LANGUAGES:
            with self.subTest(lang=lang):
                self.assertEqual(
                    _collection_item_language(f"card-1_{lang}", "de"),
                    lang,
                )

    def test_unsuffixed_ids_use_and_normalize_the_requested_language(self):
        for requested, expected in (
            (None, "en"),
            ("de", "de"),
            ("JP", "ja"),
            ("zh_TW", "zh-tw"),
            ("br", "pt-br"),
        ):
            with self.subTest(requested=requested):
                self.assertEqual(_collection_item_language("card-1", requested), expected)

    def test_suffix_wins_over_an_explicit_conflicting_or_invalid_lang(self):
        self.assertEqual(_collection_item_language("card-1_ja", "de"), "ja")
        self.assertEqual(_collection_item_language("card-1_zh-tw", "banana"), "zh-tw")

    def test_unsuffixed_id_still_rejects_an_invalid_language(self):
        with self.assertRaises(HTTPException) as ctx:
            _collection_item_language("card-1", "banana")
        self.assertEqual(ctx.exception.status_code, 422)

    def test_single_bulk_and_csv_add_paths_all_honor_the_suffix(self):
        user = type("User", (), {"id": 1})()

        single_db = _FakeCollectionDb()
        with (
            patch("api.collection.ensure_card_exists") as single_ensure,
            patch("api.collection._annotate_collection_item", side_effect=lambda db, owner, item: item),
        ):
            added = add_to_collection(
                CollectionItemCreate(card_id="PMCG3-031_ja", quantity=1, lang="de"),
                current_user=user,
                db=single_db,
            )
        single_ensure.assert_called_once_with(single_db, "PMCG3-031_ja", lang="ja")
        self.assertEqual((added.card_id, added.lang), ("PMCG3-031_ja", "ja"))

        bulk_db = _FakeCollectionDb()
        with patch("api.collection.ensure_card_exists") as bulk_ensure:
            result = bulk_add_to_collection(
                BulkCollectionAddRequest(items=[
                    CollectionItemCreate(card_id="card-1_zh-tw", quantity=1),
                ]),
                current_user=user,
                db=bulk_db,
            )
        bulk_ensure.assert_called_once_with(bulk_db, "card-1_zh-tw", lang="zh-tw")
        self.assertEqual((result.added, result.updated, result.failed), (1, 0, 0))
        self.assertEqual((bulk_db.added[0].card_id, bulk_db.added[0].lang), ("card-1_zh-tw", "zh-tw"))

        csv_db = _FakeCollectionDb()
        with patch("api.collection.ensure_card_exists") as csv_ensure:
            status = _add_collection_item(
                csv_db,
                user,
                CollectionItemCreate(card_id="card-1_pt-br", quantity=1),
                commit=False,
            )
        csv_ensure.assert_called_once_with(csv_db, "card-1_pt-br", lang="pt-br")
        self.assertEqual(status, "added")
        self.assertEqual((csv_db.added[0].card_id, csv_db.added[0].lang), ("card-1_pt-br", "pt-br"))


if __name__ == "__main__":
    unittest.main()
