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

    def test_rejects_rate_set_with_no_supported_quotes(self):
        with self.assertRaises(ExchangeRateError):
            parse_frankfurter_v2_rates([
                {"date": "2026-10-20", "base": "EUR", "quote": "AAVE", "rate": 0.009},
                {"date": "2026-10-20", "base": "EUR", "quote": "USDT", "rate": 1.12},
            ], "EUR")

    def test_rejects_wrong_base_even_on_an_unsupported_quote(self):
        with self.assertRaises(ExchangeRateError):
            parse_frankfurter_v2_rates([
                {"date": "2026-10-20", "base": "USD", "quote": "AAVE", "rate": 0.009},
                {"date": "2026-10-20", "base": "EUR", "quote": "DKK", "rate": 7.46},
            ], "EUR")

    def test_skipping_unsupported_quotes_does_not_hide_invalid_supported_rates(self):
        for bad_record in (
            {"date": "not-a-date", "base": "EUR", "quote": "USD", "rate": 1.12},
            {"date": "2026-10-20", "base": "EUR", "quote": "USD", "rate": 0},
            {"date": "2026-10-20", "base": "EUR", "quote": "USD", "rate": "NaN"},
        ):
            with self.subTest(record=bad_record):
                with self.assertRaises(ExchangeRateError):
                    parse_frankfurter_v2_rates([
                        {"date": "2026-10-20", "base": "EUR", "quote": "AAVE", "rate": 0.009},
                        bad_record,
                    ], "EUR")

    def test_rejects_duplicate_supported_quotes_in_mixed_rate_set(self):
        with self.assertRaises(ExchangeRateError):
            parse_frankfurter_v2_rates([
                {"date": "2026-10-20", "base": "EUR", "quote": "USD", "rate": 1.12},
                {"date": "2026-10-20", "base": "EUR", "quote": "AAVE", "rate": 0.009},
                {"date": "2026-10-20", "base": "EUR", "quote": "USD", "rate": 1.13},
            ], "EUR")

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
