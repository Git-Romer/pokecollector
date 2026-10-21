import unittest

from services.exchange_rates import (
    ExchangeRateError,
    normalize_currency_pair,
    parse_frankfurter_currencies,
    parse_frankfurter_v2_rates,
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

    def test_parses_currency_list(self):
        items = parse_frankfurter_currencies([
            {"iso_code": "USD", "name": "US Dollar", "symbol": "$"},
            {"iso_code": "TOOLONG"},
            {"iso_code": "AED", "name": "Dirham", "symbol": "د.إ"},
        ])
        self.assertEqual([item["code"] for item in items], ["AED", "USD"])

    def test_parses_a_base_rate_set_and_provider_dates(self):
        rates = parse_frankfurter_v2_rates([
            {"date": "2026-10-20", "base": "EUR", "quote": "EUR", "rate": 1},
            {"date": "2026-10-20", "base": "EUR", "quote": "DKK", "rate": 7.46},
        ], "EUR")
        self.assertEqual(rates[1]["base_currency"], "EUR")
        self.assertEqual(rates[1]["quote_currency"], "DKK")
        self.assertEqual(rates[1]["rate"], 7.46)
        self.assertEqual(rates[1]["provider_date"].isoformat(), "2026-10-20")

    def test_rejects_invalid_or_inconsistent_rate_sets(self):
        for payload, base in (
            ([], "EUR"),
            ([{"date": "not-a-date", "base": "EUR", "quote": "DKK", "rate": 7.46}], "EUR"),
            ([{"date": "2026-10-20", "base": "USD", "quote": "DKK", "rate": 7.46}], "EUR"),
            ([{"date": "2026-10-20", "base": "EUR", "quote": "DKK", "rate": 0}], "EUR"),
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ExchangeRateError):
                    parse_frankfurter_v2_rates(payload, base)


if __name__ == "__main__":
    unittest.main()
