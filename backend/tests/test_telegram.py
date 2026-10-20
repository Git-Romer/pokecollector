import unittest
from types import SimpleNamespace
from unittest.mock import patch

from services import telegram


class _Query:
    def filter(self, *criteria):
        return self

    def first(self):
        return SimpleNamespace(value="DKK")


class _Database:
    def query(self, _model):
        return _Query()


class _RateResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {"rate": 7.5}


class _RateClient:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def get(self, _url):
        return _RateResponse()


class TelegramCurrencyTests(unittest.TestCase):
    def test_price_alert_formats_both_eur_values_in_any_selected_currency(self):
        with patch("services.telegram.httpx.Client", return_value=_RateClient()) as client, \
             patch("services.telegram.send_message", return_value=True) as send_message:
            result = telegram.send_price_alert(
                "Pikachu", 2.0, 3.0, "above", db=_Database(), user_id=17
            )

        self.assertTrue(result)
        message = send_message.call_args.args[0]
        self.assertIn("Current price: <b>DKK 15.00</b>", message)
        self.assertIn("Alert threshold (above): <b>DKK 22.50</b>", message)
        self.assertEqual(client.call_count, 1)

    def test_price_alert_falls_back_to_eur_when_selected_currency_rate_is_unavailable(self):
        with patch("services.telegram.httpx.Client", side_effect=RuntimeError("offline")), \
             patch("services.telegram.send_message", return_value=True) as send_message:
            telegram.send_price_alert(
                "Pikachu", 2.0, 3.0, "above", db=_Database(), user_id=17
            )

        message = send_message.call_args.args[0]
        self.assertIn("Current price: <b>EUR 2.00</b>", message)
        self.assertIn("Alert threshold (above): <b>EUR 3.00</b>", message)


if __name__ == "__main__":
    unittest.main()
