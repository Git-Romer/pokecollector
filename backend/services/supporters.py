import csv
from datetime import date
from decimal import Decimal, InvalidOperation
import io

SUPPORTER_CROWNS = ["gold", "silver", "bronze"]


def _parse_supporter_amount(value: str | None) -> Decimal:
    cleaned = (value or "0").strip().replace(",", ".")
    if not cleaned:
        return Decimal("0")
    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return Decimal("0")
    return max(amount, Decimal("0"))


def _clean_supporter_date(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    if not cleaned:
        return None
    try:
        return date.fromisoformat(cleaned).isoformat()
    except ValueError:
        return cleaned


def _supporter_name_key(name: str) -> str:
    return name.strip().casefold()


def _supporter_url_key(url: str | None) -> str | None:
    cleaned = (url or "").strip().casefold()
    return cleaned or None


def parse_rescue_donations_csv(text: str) -> dict:
    """Parse actual animal rescue donation batches and return public totals."""
    reader = csv.DictReader(io.StringIO(text))
    total_amount = Decimal("0")
    donation_count = 0
    currency = "EUR"
    donations = []

    for row in reader:
        amount = _parse_supporter_amount(row.get("amount"))
        if amount <= 0:
            continue

        row_currency = (row.get("currency") or "EUR").strip().upper() or "EUR"
        donation = {
            "date": _clean_supporter_date(row.get("date")),
            "amount": float(amount),
            "currency": row_currency,
            "organization": (row.get("organization") or "").strip() or None,
            "url": (row.get("url") or "").strip() or None,
            "note": (row.get("note") or "").strip() or None,
        }
        total_amount += amount
        donation_count += 1
        donations.append(donation)
        if donation_count == 1:
            currency = row_currency
        elif currency != row_currency:
            currency = "MIXED"

    donations.sort(key=lambda donation: donation["date"] or "", reverse=True)
    dated_donations = [donation["date"] for donation in donations if donation["date"]]

    return {
        "total_amount": float(total_amount),
        "currency": currency,
        "donation_count": donation_count,
        "latest_donation_at": max(dated_donations) if dated_donations else None,
        "donations": donations,
    }


def parse_supporters_csv(text: str) -> list[dict]:
    """Parse timeline donation rows and return supporter leaderboard entries."""
    reader = csv.DictReader(io.StringIO(text))
    supporters_by_key: dict[str, dict] = {}
    name_to_key: dict[str, str] = {}
    url_to_key: dict[str, str] = {}

    for row in reader:
        name = (row.get("name") or "").strip()
        if not name:
            continue

        url = (row.get("url") or "").strip() or None
        name_key = _supporter_name_key(name)
        url_key = _supporter_url_key(url)
        key = name_to_key.get(name_key) or (url_to_key.get(url_key) if url_key else None) or name_key

        currency = (row.get("currency") or "EUR").strip().upper() or "EUR"
        amount = _parse_supporter_amount(row.get("amount"))
        donation = {
            "date": _clean_supporter_date(row.get("date")),
            "amount": float(amount),
            "currency": currency,
        }

        if key not in supporters_by_key:
            supporters_by_key[key] = {
                "name": name,
                "url": url,
                "currency": currency,
                "_total_amount": Decimal("0"),
                "donations": [],
            }

        supporter = supporters_by_key[key]
        supporter["_total_amount"] += amount
        supporter["donations"].append(donation)
        if not supporter.get("url") and url:
            supporter["url"] = url
        name_to_key[name_key] = key
        if url_key:
            url_to_key[url_key] = key
        if supporter.get("currency") != currency:
            supporter["currency"] = "MIXED"

    supporters = list(supporters_by_key.values())
    for supporter in supporters:
        dated_donations = [donation["date"] for donation in supporter["donations"] if donation["date"]]
        supporter["donations"].sort(key=lambda donation: donation["date"] or "", reverse=True)
        supporter["donation_count"] = len(supporter["donations"])
        supporter["first_supported_at"] = min(dated_donations) if dated_donations else None
        supporter["latest_supported_at"] = max(dated_donations) if dated_donations else None
        supporter["total_amount"] = float(supporter.pop("_total_amount"))

    supporters.sort(
        key=lambda supporter: (
            -supporter["total_amount"],
            -(supporter["donation_count"]),
            supporter["name"].lower(),
        )
    )

    for index, supporter in enumerate(supporters):
        supporter["rank"] = index + 1
        supporter["crown"] = SUPPORTER_CROWNS[index] if index < len(SUPPORTER_CROWNS) else None

    return supporters
