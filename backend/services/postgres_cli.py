"""Shared helpers for PostgreSQL command-line tools."""

from __future__ import annotations

from urllib.parse import unquote, urlparse


def parse_database_url(database_url: str) -> dict[str, str] | None:
    """Return connection fields accepted by pg_dump and psql."""
    try:
        parsed = urlparse(database_url)
        scheme = parsed.scheme.split("+", 1)[0]
        if scheme not in {"postgresql", "postgres"}:
            return None
        if not parsed.hostname or not parsed.path or parsed.path == "/":
            return None
        return {
            "user": unquote(parsed.username or ""),
            "password": unquote(parsed.password or ""),
            "host": parsed.hostname,
            "port": str(parsed.port or 5432),
            "dbname": unquote(parsed.path.lstrip("/")),
        }
    except (TypeError, ValueError):
        return None
