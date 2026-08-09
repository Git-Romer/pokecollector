"""Normalise extracted card fields before they reach matching.

Every rule here fixes a mistake that recurred on *every* run of a real card set,
not a one-off, and every rule is conservative: it only ever discards a value that
cannot be what the field means, so a correct extraction is never altered.
"""

from __future__ import annotations

import re
from typing import Optional

_EMPTY = {"", "null", "none", "n/a", "-"}

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip().casefold() in _EMPTY)


# The elemental type of a basic Energy card is printed ONLY as a symbol — the
# card's own name is the generic "Basic Energy" or just "Energy". TCGdex names the
# same cards "Water Energy" / "Basic Darkness Energy", so searching what is printed
# returns nothing at all and the prefix fallback then drops into a pool of every
# card containing "Basic". Measured on a real 72-card set: every wrongly-matched
# card was a basic Energy, and this was why.
_ENERGY_TYPES = (
    "Grass", "Fire", "Water", "Lightning", "Psychic", "Fighting",
    "Darkness", "Metal", "Fairy", "Dragon", "Colorless",
)
_ENERGY_TYPE_LOOKUP = {t.casefold(): t for t in _ENERGY_TYPES}

# Only these printed names are generic enough to replace. A special energy names
# itself properly ("Double Turbo Energy", "Reversal Energy") and searching that
# name already works, so it must be left alone.
_GENERIC_ENERGY_NAMES = {"energy", "basicenergy"}


def is_generic_energy_name(name) -> bool:
    """True for the placeholder names basic Energy cards print.

    These match nothing in TCGdex, and trimming the tail to find a near-miss is
    actively harmful here: "Basic Energy" reduces to "Basic", which matches every
    card whose name contains that word.
    """
    if _blank(name):
        return False
    return _NON_ALNUM.sub("", str(name).casefold()) in _GENERIC_ENERGY_NAMES


def energy_type_name(value) -> Optional[str]:
    """Canonical capitalisation for a recognised elemental type, else None."""
    if _blank(value):
        return None
    return _ENERGY_TYPE_LOOKUP.get(str(value).strip().casefold())


def energy_search_name(card_info: dict) -> Optional[str]:
    """The name to search TCGdex with for a basic Energy card, or None.

    Returns "Water Energy" for a card printed as "Basic Energy" whose symbol was
    read as Water. Substring search then matches both catalogue spellings
    ("Water Energy" and "Basic Water Energy"). Returns None whenever the
    substitution would not clearly help, so the normal name search is used.
    """
    if not isinstance(card_info, dict):
        return None
    if str(card_info.get("card_type") or "").strip().casefold() != "energy":
        return None
    energy_type = energy_type_name(card_info.get("energy_type"))
    if not energy_type:
        return None
    if not is_generic_energy_name(card_info.get("name_en") or card_info.get("name")):
        return None
    return f"{energy_type} Energy"


def clean_card_info(card_info: dict) -> dict:
    """Return a copy with the cleanup rules applied. Never mutates the input, so
    the raw extraction stays available for tracing and debugging."""
    if not isinstance(card_info, dict):
        return card_info
    cleaned = dict(card_info)
    if "energy_type" in cleaned:
        # Drop anything outside the eleven real types so a hallucinated value
        # cannot become a search term.
        cleaned["energy_type"] = energy_type_name(cleaned.get("energy_type"))
    return cleaned
