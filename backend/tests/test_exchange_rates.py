import unittest

from services.exchange_rates import (
    ExchangeRateError,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_rate,
)


class ExchangeRateTests(unittest.TestCase):
    def test_normalizes_supported_currency_pair(self):
        self.assertEqual(normalize_currency_pair(" eur ", "usd"), ("EUR", "USD"))

    def test_rejects_unsupported_currency_pair(self):
        with self.assertRaises(ExchangeRateError):
            normalize_currency_pair("EUR", "GBP")

    def test_fallback_rates_are_available_for_supported_pairs(self):
        self.assertEqual(fallback_exchange_rate("EUR", "EUR"), 1.0)
        self.assertEqual(fallback_exchange_rate("EUR", "USD"), 1.1)
        self.assertEqual(fallback_exchange_rate("USD", "EUR"), 0.91)

    def test_parses_frankfurter_rate(self):
        self.assertEqual(parse_frankfurter_rate({"rates": {"EUR": 0.92}}, "EUR"), 0.92)

    def test_rejects_missing_or_invalid_frankfurter_rate(self):
        for payload in (
            {"rates": {}},
            {"rates": {"EUR": 0}},
            {"rates": {"EUR": "nope"}},
            {"rates": {"EUR": "NaN"}},
            {"rates": {"EUR": "Infinity"}},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ExchangeRateError):
                    parse_frankfurter_rate(payload, "EUR")


if __name__ == "__main__":
    unittest.main()
