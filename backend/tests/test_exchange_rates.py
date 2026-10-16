import unittest

from services.exchange_rates import (
    ExchangeRateError,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_v2_rate,
)


class ExchangeRateTests(unittest.TestCase):
    def test_normalizes_supported_currency_pair(self):
        self.assertEqual(normalize_currency_pair(" eur ", "usd"), ("EUR", "USD"))
        self.assertEqual(normalize_currency_pair(" eur ", "dkk"), ("EUR", "DKK"))
        self.assertEqual(normalize_currency_pair(" dkk ", "eur"), ("DKK", "EUR"))

    def test_rejects_unsupported_currency_pair(self):
        with self.assertRaises(ExchangeRateError):
            normalize_currency_pair("EUR", "GBP")

    def test_fallback_rates_are_available_for_supported_pairs(self):
        self.assertEqual(fallback_exchange_rate("EUR", "EUR"), 1.0)
        self.assertEqual(fallback_exchange_rate("EUR", "USD"), 1.1)
        self.assertEqual(fallback_exchange_rate("USD", "EUR"), 0.91)
        self.assertEqual(fallback_exchange_rate("EUR", "DKK"), 7.46)
        self.assertEqual(fallback_exchange_rate("DKK", "EUR"), 0.134)
        self.assertEqual(fallback_exchange_rate("USD", "DKK"), 6.78)

    def test_parses_frankfurter_v2_rate(self):
        self.assertEqual(parse_frankfurter_v2_rate({"rate": 0.92}), 0.92)

    def test_rejects_missing_or_invalid_frankfurter_v2_rate(self):
        for payload in (
            {},
            {"rate": 0},
            {"rate": "nope"},
            {"rate": "NaN"},
            {"rate": "Infinity"},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ExchangeRateError):
                    parse_frankfurter_v2_rate(payload)


if __name__ == "__main__":
    unittest.main()
