import re
import time
from decimal import Decimal, InvalidOperation

CURRENCY_CODE_RE = re.compile(r"^[A-Z]{3}$")
CURRENCIES_CACHE_SECONDS = 24 * 60 * 60

# Offline fallbacks for the two currencies the app stores prices in.
FALLBACK_RATES = {
    ("EUR", "USD"): 1.1,
    ("USD", "EUR"): 0.91,
}

_currencies_cache: dict = {"expires": 0.0, "items": None}


class ExchangeRateError(ValueError):
    pass


def normalize_currency_code(value: str | None) -> str:
    code = (value or "").strip().upper()
    if not CURRENCY_CODE_RE.match(code):
        raise ExchangeRateError("invalid currency code")
    return code


def normalize_currency_pair(from_currency: str | None, to_currency: str | None) -> tuple[str, str]:
    return normalize_currency_code(from_currency), normalize_currency_code(to_currency)


def fallback_exchange_rate(from_currency: str, to_currency: str) -> float | None:
    if from_currency == to_currency:
        return 1.0
    return FALLBACK_RATES.get((from_currency, to_currency))


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


def parse_frankfurter_currencies(payload) -> list[dict]:
    if not isinstance(payload, list):
        raise ExchangeRateError("invalid currency list")
    items = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        code = str(entry.get("iso_code") or "").upper()
        if not CURRENCY_CODE_RE.match(code):
            continue
        items.append({
            "code": code,
            "name": entry.get("name") or code,
            "symbol": entry.get("symbol") or code,
        })
    if not items:
        raise ExchangeRateError("empty currency list")
    return sorted(items, key=lambda item: item["code"])


def get_cached_currencies() -> list[dict] | None:
    if _currencies_cache["items"] is not None and _currencies_cache["expires"] > time.monotonic():
        return _currencies_cache["items"]
    return None


def set_cached_currencies(items: list[dict]) -> None:
    _currencies_cache["items"] = items
    _currencies_cache["expires"] = time.monotonic() + CURRENCIES_CACHE_SECONDS


def stale_currencies() -> list[dict] | None:
    return _currencies_cache["items"]
