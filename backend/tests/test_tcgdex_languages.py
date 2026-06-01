import unittest

from services import pokemon_api
from services.tcgdex_languages import (
    SUPPORTED_TCGDEX_LANGUAGES,
    english_fallback_languages,
    has_lang_suffix,
    normalize_tcgdex_language,
    normalize_tcgdex_sync_languages,
    strip_lang_suffix,
    validate_tcgdex_sync_languages,
)


class TcgdexLanguageHelperTests(unittest.TestCase):
    def test_normalizes_supported_aliases(self):
        self.assertEqual(normalize_tcgdex_language("ZH_HANS"), "zh-cn")
        self.assertEqual(normalize_tcgdex_language("zh-hant"), "zh-tw")
        self.assertEqual(normalize_tcgdex_language("jp"), "ja")

    def test_sync_languages_ignore_invalid_env_values_and_fallback_to_default(self):
        self.assertEqual(normalize_tcgdex_sync_languages("banana,xx"), "en,de")
        self.assertEqual(normalize_tcgdex_sync_languages(""), "en,de")
        self.assertEqual(normalize_tcgdex_sync_languages(None), "en,de")

    def test_sync_languages_keep_supported_order_and_drop_duplicates(self):
        self.assertEqual(normalize_tcgdex_sync_languages("de,fr,en,fr,zh_tw"), "en,fr,de,zh-tw")

    def test_all_expands_to_every_supported_language(self):
        self.assertEqual(normalize_tcgdex_sync_languages("all"), ",".join(SUPPORTED_TCGDEX_LANGUAGES))

    def test_user_validation_rejects_no_valid_language(self):
        with self.assertRaises(ValueError):
            validate_tcgdex_sync_languages("banana")

    def test_strip_lang_suffix_handles_hyphenated_languages(self):
        self.assertEqual(strip_lang_suffix("sv1-1_zh-tw"), ("sv1-1", "zh-tw"))
        self.assertEqual(strip_lang_suffix("sv1-1_pt-br"), ("sv1-1", "pt-br"))
        self.assertEqual(strip_lang_suffix("sv1-1"), ("sv1-1", "en"))
        self.assertTrue(has_lang_suffix("sv1-1_zh-cn"))
        self.assertFalse(has_lang_suffix("sv1-1"))

    def test_english_is_fallback_source_for_non_english_only(self):
        self.assertEqual(english_fallback_languages("de"), ["en"])
        self.assertEqual(english_fallback_languages("ja"), ["en"])
        self.assertEqual(english_fallback_languages("en"), [])

    def test_pokemon_api_base_url_normalizes_invalid_language(self):
        self.assertTrue(pokemon_api.get_base_url("zh_tw").endswith("/zh-tw"))
        self.assertTrue(pokemon_api.get_base_url("banana").endswith("/en"))


if __name__ == "__main__":
    unittest.main()
