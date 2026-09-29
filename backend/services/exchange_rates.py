from decimal import Decimal, InvalidOperation

SUPPORTED_CURRENCIES = {"EUR", "USD", "DKK"}
FALLBACK_RATES = {
    ("EUR", "USD"): 1.1,
    ("USD", "EUR"): 0.91,
    ("EUR", "DKK"): 7.46,
    ("DKK", "EUR"): 0.134,
    ("USD", "DKK"): 6.78,
    ("DKK", "USD"): 0.147,
}


class ExchangeRateError(ValueError):
    pass


def normalize_currency_pair(from_currency: str | None, to_currency: str | None) -> tuple[str, str]:
    source = (from_currency or "").strip().upper()
    target = (to_currency or "").strip().upper()
    if source not in SUPPORTED_CURRENCIES or target not in SUPPORTED_CURRENCIES:
        raise ExchangeRateError("unsupported currency pair")
    return source, target


def fallback_exchange_rate(from_currency: str, to_currency: str) -> float:
    if from_currency == to_currency:
        return 1.0
    return FALLBACK_RATES[(from_currency, to_currency)]


def _parse_positive_rate(raw_rate) -> float:
    try:
        rate = Decimal(str(raw_rate))
    except (InvalidOperation, TypeError):
        raise ExchangeRateError("missing exchange rate") from None
    if not rate.is_finite() or rate <= 0:
        raise ExchangeRateError("invalid exchange rate")
    return float(rate)


def parse_frankfurter_v2_rate(payload: dict) -> float:
    return _parse_positive_rate(payload.get("rate"))
