import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException

    from api.collection import _parse_import_row, _normalize_request_lang, ensure_card_exists
    from api.settings import _normalize_tcgdex_sync_languages
    API_VALIDATION_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_VALIDATION_DEPS_AVAILABLE = False


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


if __name__ == "__main__":
    unittest.main()
