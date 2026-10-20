import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import CurrencyMetadata, CurrencyRate
from services.exchange_rates import (
    CurrencyMetadataUnavailable,
    ExchangeRateUnavailable,
    get_currency_metadata,
    get_exchange_rate,
)


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class ExchangeRateCacheTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(
            self.engine,
            tables=[CurrencyRate.__table__, CurrencyMetadata.__table__],
        )
        self.sessions = sessionmaker(bind=self.engine)
        self.now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)

    def tearDown(self):
        self.engine.dispose()

    def test_syncs_and_persists_all_currency_rates_with_provider_date(self):
        payload = [
            {"date": "2026-10-20", "base": "EUR", "quote": "EUR", "rate": 1},
            {"date": "2026-10-20", "base": "EUR", "quote": "DKK", "rate": 7.46},
            {"date": "2026-10-20", "base": "EUR", "quote": "USD", "rate": 1.12},
        ]

        def get(url, timeout):
            self.assertIn("base=EUR", url)
            return _Response(payload)

        with patch("services.exchange_rates.httpx.get", side_effect=get) as request:
            result = get_exchange_rate(
                "EUR", "DKK", session_factory=self.sessions, now=self.now
            )

        self.assertEqual(result["rate"], 7.46)
        self.assertEqual(result["provider_date"], "2026-10-20")
        self.assertFalse(result["stale"])
        self.assertEqual(request.call_count, 1)
        with self.sessions() as db:
            cached = db.query(CurrencyRate).filter_by(base_currency="EUR", quote_currency="DKK").one()
            self.assertEqual(cached.rate, 7.46)
            self.assertEqual(cached.provider_date.isoformat(), "2026-10-20")

    def test_returns_stale_saved_rate_when_provider_is_offline(self):
        stale_synced_at = self.now - timedelta(hours=2)
        with self.sessions() as db:
            db.add(CurrencyRate(
                base_currency="EUR",
                quote_currency="DKK",
                rate=7.46,
                provider_date=datetime(2026, 10, 19).date(),
                synced_at=stale_synced_at,
            ))
            db.commit()

        with patch("services.exchange_rates.httpx.get", side_effect=httpx.ConnectError("offline")):
            result = get_exchange_rate(
                "EUR", "DKK", session_factory=self.sessions, now=self.now
            )

        self.assertEqual(result["rate"], 7.46)
        self.assertEqual(result["provider_date"], "2026-10-19")
        self.assertTrue(result["stale"])

    def test_does_not_invent_a_rate_when_offline_cache_is_empty(self):
        with patch("services.exchange_rates.httpx.get", side_effect=httpx.ConnectError("offline")):
            with self.assertRaises(ExchangeRateUnavailable):
                get_exchange_rate(
                    "EUR", "DKK", session_factory=self.sessions, now=self.now
                )

    def test_does_not_refetch_fresh_rate_set_for_unsupported_quote(self):
        payload = [
            {"date": "2026-10-20", "base": "EUR", "quote": "EUR", "rate": 1},
            {"date": "2026-10-20", "base": "EUR", "quote": "DKK", "rate": 7.46},
        ]
        with patch(
            "services.exchange_rates.httpx.get",
            return_value=_Response(payload),
        ) as request:
            for _ in range(2):
                with self.assertRaises(ExchangeRateUnavailable):
                    get_exchange_rate(
                        "EUR", "ZZZ", session_factory=self.sessions, now=self.now
                    )

        self.assertEqual(request.call_count, 1)

    def test_persists_currency_metadata_and_serves_it_offline(self):
        payload = [
            {"iso_code": "DKK", "name": "Danish Krone", "symbol": "kr."},
            {"iso_code": "EUR", "name": "Euro", "symbol": "€"},
        ]
        with patch("services.exchange_rates.httpx.get", return_value=_Response(payload)) as request:
            first = get_currency_metadata(session_factory=self.sessions, now=self.now)

        self.assertEqual([item["code"] for item in first["currencies"]], ["DKK", "EUR"])
        self.assertFalse(first["stale"])
        self.assertEqual(request.call_count, 1)
        with self.sessions() as db:
            self.assertEqual(db.query(CurrencyMetadata).count(), 2)

        later = self.now + timedelta(days=31)
        with patch("services.exchange_rates.httpx.get", side_effect=httpx.ConnectError("offline")):
            cached = get_currency_metadata(session_factory=self.sessions, now=later)

        self.assertEqual([item["code"] for item in cached["currencies"]], ["DKK", "EUR"])
        self.assertTrue(cached["stale"])
        self.assertEqual(cached["synced_at"], self.now.isoformat().replace("+00:00", "Z"))

    def test_currency_metadata_is_unavailable_if_never_synced_and_offline(self):
        with patch("services.exchange_rates.httpx.get", side_effect=httpx.ConnectError("offline")):
            with self.assertRaises(CurrencyMetadataUnavailable):
                get_currency_metadata(session_factory=self.sessions, now=self.now)


if __name__ == "__main__":
    unittest.main()
