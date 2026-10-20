import logging
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import httpx
from database import SessionLocal
from models import CurrencyMetadata, CurrencyRate

CURRENCY_CODE_RE = re.compile(r"^[A-Z]{3}$")


class ExchangeRateError(ValueError):
    pass


def normalize_currency_code(value: str | None) -> str:
    code = (value or "").strip().upper()
    if not CURRENCY_CODE_RE.match(code):
        raise ExchangeRateError("invalid currency code")
    return code


def normalize_currency_pair(from_currency: str | None, to_currency: str | None) -> tuple[str, str]:
    return normalize_currency_code(from_currency), normalize_currency_code(to_currency)


def _parse_positive_rate(raw_rate) -> float:
    try:
        rate = Decimal(str(raw_rate))
    except (InvalidOperation, TypeError):
        raise ExchangeRateError("missing exchange rate") from None
    if not rate.is_finite() or rate <= 0:
        raise ExchangeRateError("invalid exchange rate")
    return float(rate)


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


RATE_REFRESH_INTERVAL = timedelta(hours=1)
FRANKFURTER_RATES_URL = "https://api.frankfurter.dev/v2/rates"
logger = logging.getLogger(__name__)


class ExchangeRateUnavailable(ExchangeRateError):
    """Raised when neither Frankfurter nor the local cache has a requested rate."""


def parse_frankfurter_v2_rates(payload, base_currency: str) -> list[dict]:
    base = normalize_currency_code(base_currency)
    if not isinstance(payload, list) or not payload:
        raise ExchangeRateError("invalid exchange-rate list")

    parsed = []
    seen_quotes = set()
    for entry in payload:
        if not isinstance(entry, dict):
            raise ExchangeRateError("invalid exchange-rate record")
        entry_base = normalize_currency_code(entry.get("base"))
        quote = normalize_currency_code(entry.get("quote"))
        if entry_base != base or quote in seen_quotes:
            raise ExchangeRateError("inconsistent exchange-rate list")
        try:
            provider_date = date.fromisoformat(str(entry.get("date")))
        except (TypeError, ValueError):
            raise ExchangeRateError("invalid exchange-rate date") from None
        seen_quotes.add(quote)
        parsed.append({
            "base_currency": base,
            "quote_currency": quote,
            "rate": _parse_positive_rate(entry.get("rate")),
            "provider_date": provider_date,
        })
    return parsed


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _load_cached_rate(session_factory, base: str, quote: str):
    with session_factory() as db:
        return db.query(CurrencyRate).filter_by(
            base_currency=base,
            quote_currency=quote,
        ).one_or_none()


def _load_latest_rate_for_base(session_factory, base: str):
    with session_factory() as db:
        return db.query(CurrencyRate).filter_by(
            base_currency=base,
        ).order_by(CurrencyRate.synced_at.desc()).first()


def _rate_is_fresh(row, now: datetime) -> bool:
    synced_at = _as_utc(row.synced_at)
    return synced_at is not None and now - synced_at < RATE_REFRESH_INTERVAL


def _serialize_cached_rate(row, *, stale: bool) -> dict:
    synced_at = _as_utc(row.synced_at)
    return {
        "rate": float(row.rate),
        "provider_date": row.provider_date.isoformat(),
        "synced_at": synced_at.isoformat().replace("+00:00", "Z") if synced_at else None,
        "stale": stale,
    }


def _fetch_rate_set(base: str) -> list[dict]:
    response = httpx.get(
        f"{FRANKFURTER_RATES_URL}?base={base}",
        timeout=4.0,
    )
    response.raise_for_status()
    return parse_frankfurter_v2_rates(response.json(), base)


def _persist_rate_set(session_factory, rates: list[dict], synced_at: datetime) -> None:
    with session_factory() as db:
        for rate_data in rates:
            row = db.get(
                CurrencyRate,
                (rate_data["base_currency"], rate_data["quote_currency"]),
            )
            if row is None:
                row = CurrencyRate(
                    base_currency=rate_data["base_currency"],
                    quote_currency=rate_data["quote_currency"],
                    rate=rate_data["rate"],
                    provider_date=rate_data["provider_date"],
                    synced_at=synced_at,
                )
                db.add(row)
            else:
                row.rate = rate_data["rate"]
                row.provider_date = rate_data["provider_date"]
                row.synced_at = synced_at
        db.commit()


def get_exchange_rate(
    from_currency: str,
    to_currency: str,
    *,
    session_factory=None,
    now: datetime | None = None,
) -> dict:
    """Return a fresh provider rate or the last locally persisted rate."""
    source, target = normalize_currency_pair(from_currency, to_currency)
    if source == target:
        return {"rate": 1.0, "provider_date": None, "synced_at": None, "stale": False}

    factory = session_factory or SessionLocal
    current_time = _as_utc(now) or datetime.now(timezone.utc)
    cached = _load_cached_rate(factory, source, target)
    if cached is not None and _rate_is_fresh(cached, current_time):
        return _serialize_cached_rate(cached, stale=False)

    cached_base = _load_latest_rate_for_base(factory, source)
    if cached_base is None or not _rate_is_fresh(cached_base, current_time):
        try:
            rates = _fetch_rate_set(source)
            _persist_rate_set(factory, rates, current_time)
        except Exception as exc:
            logger.warning("Could not refresh exchange rates for %s: %s", source, exc)

    cached = _load_cached_rate(factory, source, target)
    if cached is not None:
        return _serialize_cached_rate(
            cached,
            stale=not _rate_is_fresh(cached, current_time),
        )
    raise ExchangeRateUnavailable("currency conversion unavailable") from None


CURRENCY_METADATA_REFRESH_INTERVAL = timedelta(days=1)


class CurrencyMetadataUnavailable(ExchangeRateError):
    """Raised when this installation has never synchronized currency metadata."""


def _load_cached_currency_metadata(session_factory) -> tuple[list[dict], datetime | None]:
    with session_factory() as db:
        rows = db.query(CurrencyMetadata).order_by(CurrencyMetadata.currency_code).all()
        if not rows:
            return [], None
        currencies = [
            {"code": row.currency_code, "name": row.name, "symbol": row.symbol}
            for row in rows
        ]
        synced_times = [_as_utc(row.synced_at) for row in rows]
        synced_at = max(
            (value for value in synced_times if value is not None),
            default=None,
        )
        return currencies, synced_at


def _serialize_currency_metadata(
    currencies: list[dict], synced_at: datetime | None, *, stale: bool
) -> dict:
    return {
        "currencies": currencies,
        "synced_at": (
            synced_at.isoformat().replace("+00:00", "Z") if synced_at else None
        ),
        "stale": stale,
    }


def _persist_currency_metadata(
    session_factory, currencies: list[dict], synced_at: datetime
) -> None:
    current_codes = {item["code"] for item in currencies}
    with session_factory() as db:
        existing = db.query(CurrencyMetadata).all()
        existing_by_code = {row.currency_code: row for row in existing}
        for currency in currencies:
            row = existing_by_code.get(currency["code"])
            if row is None:
                row = CurrencyMetadata(currency_code=currency["code"])
                db.add(row)
            row.name = currency["name"]
            row.symbol = currency["symbol"]
            row.synced_at = synced_at
        for row in existing:
            if row.currency_code not in current_codes:
                db.delete(row)
        db.commit()


def get_currency_metadata(*, session_factory=None, now: datetime | None = None) -> dict:
    """Return provider currency metadata, persisted for offline use."""
    factory = session_factory or SessionLocal
    current_time = _as_utc(now) or datetime.now(timezone.utc)
    currencies, synced_at = _load_cached_currency_metadata(factory)
    is_fresh = (
        synced_at is not None
        and current_time - synced_at < CURRENCY_METADATA_REFRESH_INTERVAL
    )
    if currencies and is_fresh:
        return _serialize_currency_metadata(currencies, synced_at, stale=False)

    try:
        response = httpx.get(
            "https://api.frankfurter.dev/v2/currencies",
            timeout=4.0,
        )
        response.raise_for_status()
        currencies = parse_frankfurter_currencies(response.json())
        _persist_currency_metadata(factory, currencies, current_time)
        return _serialize_currency_metadata(currencies, current_time, stale=False)
    except Exception as exc:
        logger.warning("Could not refresh currency metadata: %s", exc)

    if currencies:
        return _serialize_currency_metadata(currencies, synced_at, stale=True)
    raise CurrencyMetadataUnavailable("currency list unavailable until first sync") from None
