import re
from typing import Optional

_DIGITS_RE = re.compile(r"^\d+$")


def normalize_card_number(value: object) -> str:
    """Normalize numeric card numbers so 44 and 044 compare equally."""
    text = "" if value is None else str(value).strip()
    if not text:
        return ""
    if _DIGITS_RE.fullmatch(text):
        return text.lstrip("0") or "0"
    return text.lower()


def card_number_matches(stored_number: Optional[str], requested_number: object) -> bool:
    stored = "" if stored_number is None else str(stored_number).strip()
    requested = "" if requested_number is None else str(requested_number).strip()
    if not stored or not requested:
        return False
    if stored == requested:
        return True
    return normalize_card_number(stored) == normalize_card_number(requested)
