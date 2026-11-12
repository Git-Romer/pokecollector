import asyncio
import csv
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from api import export as export_api
from models import User
from services.exchange_rates import ExchangeRateUnavailable


class _Query:
    def __init__(self, rows):
        self.rows = rows

    def join(self, *args, **kwargs):
        return self

    def options(self, *args, **kwargs):
        return self

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return self.rows


class _Database:
    def __init__(self, rows):
        self.rows = rows

    def query(self, _model):
        return _Query(self.rows)


async def _read_stream(response):
    return b"".join([chunk async for chunk in response.body_iterator])


class ExportCurrencyTests(unittest.TestCase):
    def setUp(self):
        self.card = SimpleNamespace(
            id="card-1",
            name="Pikachu",
            set_ref=None,
            number="1",
            rarity="Rare",
        )
        self.item = SimpleNamespace(
            card_id="card-1",
            card=self.card,
            variant="Normal",
            purchase_price=10.0,
            quantity=1,
            condition="Near Mint",
            lang="en",
            printing_detail_tags=[],
            added_at=None,
        )
        self.db = _Database([self.item])
        self.user = User(id=1)

    def test_export_money_formatter_uses_selected_currency_for_any_iso_code(self):
        self.assertEqual(export_api._format_money(1234.5, "CAD"), "CAD 1,234.50")

    def test_csv_uses_database_rate_instead_of_client_supplied_rate(self):
        with patch("api.export.get_exchange_rate", create=True, return_value={"rate": 7.46}):
            with patch("api.export.visible_any_card_filter", return_value=True), \
                 patch("api.export.effective_market_price", return_value=10.0):
                response = export_api.export_csv(
                    currency="DKK",
                    exchange_rate=1.0,
                    db=self.db,
                    current_user=self.user,
                )

        rows = list(csv.reader(io.StringIO(asyncio.run(_read_stream(response)).decode("utf-8-sig"))))
        self.assertIn("Purchase Price (DKK)", rows[0])
        self.assertEqual(rows[1][10], "74.6")
        self.assertEqual(rows[1][11], "74.6")
        self.assertEqual(rows[1][12], "74.6")

    def test_csv_refuses_to_export_unconverted_values_without_a_cached_rate(self):
        with patch(
            "api.export.get_exchange_rate",
            create=True,
            side_effect=ExchangeRateUnavailable("offline"),
        ), patch("api.export.visible_any_card_filter", return_value=True):
            with self.assertRaises(HTTPException) as raised:
                export_api.export_csv(
                    currency="DKK",
                    exchange_rate=1.0,
                    db=self.db,
                    current_user=self.user,
                )

        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
