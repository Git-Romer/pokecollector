from decimal import Decimal, InvalidOperation

SUPPORTED_CURRENCIES = {"EUR", "USD"}
FALLBACK_RATES = {
    ("EUR", "USD"): 1.1,
    ("USD", "EUR"): 0.91,
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


def parse_frankfurter_rate(payload: dict, to_currency: str) -> float:
    try:
        raw_rate = payload.get("rates", {}).get(to_currency)
        rate = Decimal(str(raw_rate))
    except (InvalidOperation, TypeError):
        raise ExchangeRateError("missing exchange rate") from None
    if not rate.is_finite() or rate <= 0:
        raise ExchangeRateError("invalid exchange rate")
    return float(rate)
