"""Text search helpers for user-facing filters."""

from __future__ import annotations

import unicodedata

from sqlalchemy import func, literal, text
from sqlalchemy.orm import Session

# Keep a small per-engine cache so PostgreSQL extension probing is cheap and so
# installs where CREATE EXTENSION is not permitted gracefully use the portable
# fallback instead of failing every search request.
_UNACCENT_AVAILABLE_BY_BIND: dict[int, bool] = {}

# Portable fallback used for SQLite tests and PostgreSQL installs where the
# unaccent extension cannot be enabled. Keep this deliberately small to avoid
# creating overly deep SQL expression trees on SQLite; PostgreSQL unaccent is
# still the full production path when available.
_LATIN_REPLACEMENTS = {
    "a": "áàâäãåÁÀÂÄÃÅ",
    "c": "çÇ",
    "e": "éèêëÉÈÊË",
    "i": "íìîïÍÌÎÏ",
    "n": "ñÑ",
    "o": "óòôöõøÓÒÔÖÕØ",
    "u": "úùûüÚÙÛÜ",
    "y": "ýÿÝŸ",
}


def strip_diacritics(value: str | None) -> str:
    """Return a case-folded, accent-insensitive representation of text."""
    if value is None:
        return ""
    normalized = unicodedata.normalize("NFKD", str(value))
    stripped = "".join(char for char in normalized if not unicodedata.combining(char))
    return stripped.casefold()


def _portable_unaccent_expr(column):
    expr = func.lower(column)
    for replacement, characters in _LATIN_REPLACEMENTS.items():
        for character in characters:
            expr = func.replace(expr, character, replacement)
    return expr


def _postgres_unaccent_available(db: Session) -> bool:
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        return False

    cache_key = id(bind)
    if cache_key in _UNACCENT_AVAILABLE_BY_BIND:
        return _UNACCENT_AVAILABLE_BY_BIND[cache_key]

    try:
        db.execute(text("SELECT unaccent('Pokégear')")).scalar()
        available = True
    except Exception:
        db.rollback()
        available = False

    _UNACCENT_AVAILABLE_BY_BIND[cache_key] = available
    return available


def accent_insensitive_contains(db: Session, column, value: str | None):
    """Build a SQL predicate for accent-insensitive substring search."""
    if not value:
        return None

    if _postgres_unaccent_available(db):
        pattern = f"%{value}%"
        return func.unaccent(func.lower(column)).like(func.unaccent(func.lower(literal(pattern))))

    normalized = strip_diacritics(value)
    if not normalized:
        return None
    return _portable_unaccent_expr(column).like(f"%{normalized}%")
