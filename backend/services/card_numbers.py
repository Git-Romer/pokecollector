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


_PRINTED_NUMBER_RE = re.compile(r"^\s*([A-Za-z0-9]+)\s*(?:/\s*[A-Za-z0-9]+)?\s*$")
COMMON_PAD_WIDTH = 3


def printed_number_variants(number: object) -> list:
    """Forms of a printed number worth querying, most literal first.

    The set total after the slash is dropped and the rest is kept **verbatim**,
    so alphanumeric numbers survive: "74a" stays "74a" and "TG01" stays "TG01".
    Only a purely numeric value gains an unpadded alternative, because TCGdex is
    inconsistent about zero padding between sets - Base Set Charizard is localId
    "4" while Phantasmal Flames Charmeleon is "012".

    Reducing "74a" to "74" would name a different, real card, so it is not done.
    """
    if not number:
        return []
    match = _PRINTED_NUMBER_RE.match(str(number))
    if not match:
        return []
    printed = match.group(1)
    variants = [printed]
    if printed.isdigit():
        unpadded = printed.lstrip("0") or printed
        if unpadded != printed:
            variants.append(unpadded)
    return variants


def card_number_variants(number: object) -> list:
    """Every plausible localId for a printed number, most literal first.

    Adds the zero-padded form for numeric values, because a number typed by hand
    as "12" belongs to a card TCGdex stores as "012". Non-numeric values are
    offered unchanged rather than being coerced into a numeric shape.
    """
    variants = []
    for variant in printed_number_variants(number):
        candidates = [variant]
        if variant.isdigit():
            unpadded = variant.lstrip("0") or variant
            candidates += [unpadded, unpadded.zfill(COMMON_PAD_WIDTH)]
        for candidate in candidates:
            if candidate not in variants:
                variants.append(candidate)
    return variants
