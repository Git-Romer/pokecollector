import csv
from datetime import date
from decimal import Decimal, InvalidOperation
import io

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
