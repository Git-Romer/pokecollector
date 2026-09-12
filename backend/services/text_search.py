"""Text search helpers for user-facing filters."""

from __future__ import annotations

import unicodedata

from sqlalchemy import case, func, literal, or_, select, text
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


def _portable_unaccent_value(value: str) -> str:
    """Mirror ``_portable_unaccent_expr`` without altering other scripts."""
    normalized = unicodedata.normalize("NFC", str(value)).casefold()
    for replacement, characters in _LATIN_REPLACEMENTS.items():
        for character in characters.casefold():
            normalized = normalized.replace(character, replacement)
    return normalized


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

    normalized = _portable_unaccent_value(value)
    if not normalized:
        return None
    return _portable_unaccent_expr(column).like(f"%{normalized}%")


def json_array_text_matches(db: Session, column, fields: tuple[str, ...], value: str):
    """Build a dialect-aware predicate for text fields in a JSON array."""
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        # json_array_elements rejects JSON null and scalar JSON values.
        array_value = case(
            (func.json_typeof(column) == "array", column),
            else_=func.json_build_array(),
        )
        elements = func.json_array_elements(array_value).table_valued("value").alias("json_element")
        text_fields = [elements.c.value.op("->>")(field) for field in fields]
    elif dialect == "sqlite":
        # json_each accepts JSON null, but guard it to mirror PostgreSQL semantics.
        array_value = case(
            (func.json_type(column) == "array", column),
            else_=func.json_array(),
        )
        elements = func.json_each(array_value).table_valued("value").alias("json_element")
        text_fields = [func.json_extract(elements.c.value, f"$.{field}") for field in fields]
    else:
        # Search uses SQLite and PostgreSQL; unsupported dialects simply yield no JSON matches.
        return False

    return select(1).select_from(elements).where(
        or_(*(accent_insensitive_contains(db, field, value) for field in text_fields))
    ).exists()
