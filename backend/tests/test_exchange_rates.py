import unittest

from services.exchange_rates import (
    ExchangeRateError,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_currencies,
    parse_frankfurter_v2_rate,
)


class ExchangeRateTests(unittest.TestCase):
    def test_normalizes_supported_currency_pair(self):
        self.assertEqual(normalize_currency_pair(" eur ", "usd"), ("EUR", "USD"))

    def test_accepts_any_iso_style_currency_pair(self):
        self.assertEqual(normalize_currency_pair("eur", "jpy"), ("EUR", "JPY"))

    def test_rejects_malformed_currency_pair(self):
        for pair in (("EUR", "GB"), ("EUR", ""), (None, "USD"), ("EU1", "USD")):
            with self.subTest(pair=pair):
                with self.assertRaises(ExchangeRateError):
                    normalize_currency_pair(*pair)

    def test_fallback_is_none_for_unknown_pair(self):
        self.assertIsNone(fallback_exchange_rate("EUR", "JPY"))

    def test_parses_currency_list(self):
        items = parse_frankfurter_currencies([
            {"iso_code": "USD", "name": "US Dollar", "symbol": "$"},
            {"iso_code": "TOOLONG"},
            {"iso_code": "AED", "name": "Dirham", "symbol": "د.إ"},
        ])
        self.assertEqual([i["code"] for i in items], ["AED", "USD"])

    def test_fallback_rates_are_available_for_supported_pairs(self):
        self.assertEqual(fallback_exchange_rate("EUR", "EUR"), 1.0)
        self.assertEqual(fallback_exchange_rate("EUR", "USD"), 1.1)
        self.assertEqual(fallback_exchange_rate("USD", "EUR"), 0.91)

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
