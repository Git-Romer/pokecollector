import unittest
from types import SimpleNamespace
from unittest.mock import patch

from services import telegram
from services.exchange_rates import ExchangeRateUnavailable


class _Query:
    def __init__(self, value):
        self.value = value

    def filter(self, *criteria):
        return self

    def first(self):
        return SimpleNamespace(value=self.value)


class _Database:
    def __init__(self, currency="DKK"):
        self.currency = currency

    def query(self, _model):
        return _Query(self.currency)


class TelegramCurrencyTests(unittest.TestCase):
    def test_price_alert_converts_both_values_to_selected_currency_with_one_cached_rate(self):
        with patch(
            "services.telegram.get_exchange_rate",
            create=True,
            return_value={"rate": 7.5, "stale": False},
        ) as get_rate, patch("services.telegram.send_message", return_value=True) as send_message:
            result = telegram.send_price_alert(
                "Pikachu", 2.0, 3.0, "above", db=_Database("DKK"), user_id=17
            )

        self.assertTrue(result)
        message = send_message.call_args.args[0]
        self.assertIn("Current price: <b>DKK 15.00</b>", message)
        self.assertIn("Alert threshold (above): <b>DKK 22.50</b>", message)
        self.assertNotIn("EUR", message)
        self.assertNotIn("USD", message)
        get_rate.assert_called_once_with("EUR", "DKK")

    def test_alert_uses_generic_format_for_other_selected_currencies(self):
        with patch(
            "services.telegram.get_exchange_rate",
            create=True,
            return_value={"rate": 1.25, "stale": False},
        ) as get_rate, patch("services.telegram.send_message", return_value=True) as send_message:
            telegram.send_price_alert(
                "Pikachu", 2.0, 3.0, "below", db=_Database("CAD"), user_id=17
            )

        message = send_message.call_args.args[0]
        self.assertIn("Current price: <b>CAD 2.50</b>", message)
        self.assertIn("Alert threshold (below): <b>CAD 3.75</b>", message)
        self.assertNotIn("DKK", message)
        get_rate.assert_called_once_with("EUR", "CAD")

    def test_alert_marks_selected_currency_unavailable_instead_of_showing_eur(self):
        with patch(
            "services.telegram.get_exchange_rate",
            create=True,
            side_effect=ExchangeRateUnavailable("offline"),
        ) as get_rate, patch("services.telegram.send_message", return_value=True) as send_message:
            telegram.send_price_alert(
                "Pikachu", 2.0, 3.0, "above", db=_Database("DKK"), user_id=17
            )

        message = send_message.call_args.args[0]
        self.assertIn("Current price: <b>Unavailable (DKK)</b>", message)
        self.assertIn("Alert threshold (above): <b>Unavailable (DKK)</b>", message)
        self.assertNotIn("EUR", message)
        self.assertNotIn("USD", message)
        get_rate.assert_called_once_with("EUR", "DKK")


if __name__ == "__main__":
    unittest.main()
