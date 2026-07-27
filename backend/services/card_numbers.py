import re
from typing import Optional

_DIGITS_RE = re.compile(r"^\d+$")
_NATURAL_SORT_RE = re.compile(r"(\d+|\D+)")


def natural_card_number_key(number: Optional[str]) -> tuple:
    """Sort card numbers naturally while preserving alphanumeric formats.

    Examples:
    - 1, 2, 10 instead of 1, 10, 2
    - 001, 002, 010 still sort correctly
    - 74, 74a, 74b and H04 are handled without converting the display value
    """
    if number is None:
        return ((2, ""),)

    parts = []
    for part in _NATURAL_SORT_RE.findall(str(number).strip()):
        if part.isdigit():
            parts.append((0, int(part), len(part), part))
        else:
            parts.append((1, part.casefold()))
    return tuple(parts) or ((2, ""),)


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
