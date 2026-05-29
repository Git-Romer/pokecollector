import math
import unittest
from types import SimpleNamespace

from services.price_utils import (
    has_valid_price,
    is_valid_price,
    preserve_existing_prices_for_invalid_update,
)


class PriceUtilsTests(unittest.TestCase):
    def test_valid_prices_must_be_positive_and_finite(self):
        for value in (1, 0.01, "2.50"):
            with self.subTest(value=value):
                self.assertTrue(is_valid_price(value))

        for value in (None, 0, -1, "0", "nope", math.nan, math.inf, True):
            with self.subTest(value=value):
                self.assertFalse(is_valid_price(value))

    def test_missing_brief_set_prices_do_not_clear_existing_prices(self):
        existing = SimpleNamespace(price_market=6.62, price_trend=11.37, price_source_lang=None)
        incoming = {
            "id": "sm10-1_en",
            "name": "Oddish",
            "price_market": None,
            "price_trend": None,
            "price_avg30": None,
            "price_source_lang": None,
        }

        preserve_existing_prices_for_invalid_update(incoming, existing)

        self.assertNotIn("price_market", incoming)
        self.assertNotIn("price_trend", incoming)
        self.assertNotIn("price_avg30", incoming)
        self.assertNotIn("price_source_lang", incoming)
        self.assertEqual(incoming["name"], "Oddish")

    def test_zero_or_non_finite_prices_do_not_clear_existing_prices(self):
        existing = SimpleNamespace(price_market=6.62, price_trend=11.37)
        incoming = {
            "price_market": 0,
            "price_trend": "NaN",
            "price_avg7": "Infinity",
            "price_avg30": -3,
            "price_source_lang": None,
        }

        preserve_existing_prices_for_invalid_update(incoming, existing)

        self.assertNotIn("price_market", incoming)
        self.assertNotIn("price_trend", incoming)
        self.assertNotIn("price_avg7", incoming)
        self.assertNotIn("price_avg30", incoming)
        self.assertNotIn("price_source_lang", incoming)

    def test_sibling_fallback_prices_do_not_replace_existing_native_prices(self):
        existing = SimpleNamespace(price_market=6.62, price_trend=11.37, price_source_lang=None)
        incoming = {
            "price_market": 5.0,
            "price_trend": 8.0,
            "price_source_lang": "de",
        }

        preserve_existing_prices_for_invalid_update(incoming, existing)

        self.assertNotIn("price_market", incoming)
        self.assertNotIn("price_trend", incoming)
        self.assertNotIn("price_source_lang", incoming)

    def test_partial_native_price_update_preserves_existing_fallback_tag(self):
        existing = SimpleNamespace(price_market=6.62, price_trend=11.37, price_source_lang="de")
        incoming = {
            "price_market": 7.0,
            "price_trend": None,
            "price_source_lang": None,
        }

        preserve_existing_prices_for_invalid_update(incoming, existing)

        self.assertEqual(incoming["price_market"], 7.0)
        self.assertNotIn("price_trend", incoming)
        self.assertNotIn("price_source_lang", incoming)

    def test_complete_native_price_update_can_clear_fallback_source(self):
        existing = SimpleNamespace(price_market=6.62, price_trend=11.37, price_source_lang="de")
        incoming = {
            "price_market": 7.0,
            "price_trend": 12.5,
            "price_source_lang": None,
        }

        preserve_existing_prices_for_invalid_update(incoming, existing)

        self.assertEqual(incoming["price_market"], 7.0)
        self.assertEqual(incoming["price_trend"], 12.5)
        self.assertIsNone(incoming["price_source_lang"])

    def test_new_cards_normalize_invalid_prices_to_missing(self):
        incoming = {"price_market": 0, "price_trend": "NaN", "price_avg30": 4.2}

        preserve_existing_prices_for_invalid_update(incoming, existing_card=None)

        self.assertIsNone(incoming["price_market"])
        self.assertIsNone(incoming["price_trend"])
        self.assertEqual(incoming["price_avg30"], 4.2)
        self.assertTrue(has_valid_price(incoming))


if __name__ == "__main__":
    unittest.main()
