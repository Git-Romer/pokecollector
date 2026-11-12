import unittest
from unittest.mock import patch

from fastapi import HTTPException

from api import settings as settings_api
from models import User
from services.exchange_rates import CurrencyMetadataUnavailable


class CurrencySettingsApiTests(unittest.TestCase):
    def test_exchange_rate_endpoint_returns_persistent_cache_metadata(self):
        quote = {
            "rate": 7.46,
            "provider_date": "2026-10-20",
            "synced_at": "2026-10-20T12:00:00Z",
            "stale": True,
        }
        with patch("api.settings.get_cached_exchange_rate", return_value=quote) as get_rate:
            result = settings_api.get_exchange_rate("EUR", "DKK")

        self.assertEqual(result["rate"], 7.46)
        self.assertEqual(result["provider_date"], "2026-10-20")
        self.assertEqual(result["synced_at"], "2026-10-20T12:00:00Z")
        self.assertTrue(result["stale"])
        get_rate.assert_called_once_with("EUR", "DKK")

    def test_currency_endpoint_returns_persisted_cache_freshness(self):
        cached = {
            "currencies": [{"code": "DKK", "name": "Danish Krone", "symbol": "kr."}],
            "synced_at": "2026-10-20T12:00:00Z",
            "stale": True,
        }
        with patch("api.settings.get_currency_metadata", return_value=cached) as get_currencies:
            result = settings_api.get_currencies(_current_user=User(id=17))

        self.assertEqual(result, cached)
        get_currencies.assert_called_once_with()

    def test_currency_endpoint_refuses_to_invent_a_list_before_first_sync(self):
        with patch(
            "api.settings.get_currency_metadata",
            side_effect=CurrencyMetadataUnavailable("currency list unavailable"),
        ):
            with self.assertRaises(HTTPException) as raised:
                settings_api.get_currencies(_current_user=User(id=17))

        self.assertEqual(raised.exception.status_code, 503)

    def test_exchange_rate_endpoint_only_accepts_market_price_bases(self):
        with self.assertRaises(HTTPException) as raised:
            settings_api.get_exchange_rate("GBP", "DKK")

        self.assertEqual(raised.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
