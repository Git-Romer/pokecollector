from __future__ import annotations

import asyncio
from datetime import date
import ipaddress
import json
import logging
import re
import unicodedata
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Response
import httpx


router = APIRouter()
logger = logging.getLogger(__name__)

SUPPORTERS_API_URL = "https://pokecollector.romerg.de/api/v1/supporters"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_SUPPORTERS = 10_000
MAX_SAFE_INTEGER = 2**53 - 1
ALLOWED_CROWNS = {"gold", "silver", "bronze"}
CONTROL_OR_BIDI = re.compile(
    r"[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]"
)
DANGEROUS_NAME_PREFIX = re.compile(r"^[=+\-@]")
CURRENCY_PATTERN = re.compile(r"^[A-Z]{3}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SupporterSnapshotError(ValueError):
    """The public supporter response did not match the fixed v1 contract."""


def _has_exact_keys(value: object, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def _normalize_name(value: object) -> str:
    if not isinstance(value, str) or CONTROL_OR_BIDI.search(value):
        raise SupporterSnapshotError("invalid supporter name")
    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()
    if not 1 <= len(normalized) <= 60 or DANGEROUS_NAME_PREFIX.search(normalized):
        raise SupporterSnapshotError("invalid supporter name")
    return normalized


def _name_key(value: str) -> str:
    return (
        unicodedata.normalize("NFKC", value)
        .lower()
        .replace("ß", "ss")
        .replace("ς", "σ")
    )


def _normalize_url(value: object) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 500 or CONTROL_OR_BIDI.search(value):
        raise SupporterSnapshotError("invalid supporter URL")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise SupporterSnapshotError("invalid supporter URL") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise SupporterSnapshotError("invalid supporter URL")
    hostname = parsed.hostname.lower()
    if hostname == "localhost" or hostname.endswith(".local"):
        raise SupporterSnapshotError("invalid supporter URL")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    # Deliberately fail closed for every non-global literal, including reserved
    # ranges that a browser must never treat as a supporter profile target.
    if address and not address.is_global:
        raise SupporterSnapshotError("invalid supporter URL")
    return value


def _safe_nonnegative_integer(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_SAFE_INTEGER:
        raise SupporterSnapshotError("invalid supporter number")
    return value


def _normalize_date(value: object) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise SupporterSnapshotError("invalid supporter date")
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError
    except ValueError as exc:
        raise SupporterSnapshotError("invalid supporter date") from exc
    return value


def _validate_support(value: object) -> dict | None:
    if value is None:
        return None
    if not _has_exact_keys(
        value,
        {"total_amount_cents", "currency", "donation_count", "latest_supported_on"},
    ):
        raise SupporterSnapshotError("invalid support details")
    amount = _safe_nonnegative_integer(value["total_amount_cents"])
    donation_count = _safe_nonnegative_integer(value["donation_count"])
    if donation_count < 1:
        raise SupporterSnapshotError("invalid donation count")
    currency = value["currency"]
    if not isinstance(currency, str) or not (
        CURRENCY_PATTERN.fullmatch(currency) or currency == "MIXED"
    ):
        raise SupporterSnapshotError("invalid supporter currency")
    return {
        "total_amount_cents": amount,
        "currency": currency,
        "donation_count": donation_count,
        "latest_supported_on": _normalize_date(value["latest_supported_on"]),
    }


def validate_public_snapshot(value: object) -> list[dict]:
    if (
        not _has_exact_keys(value, {"version", "supporters"})
        or isinstance(value["version"], bool)
        or value["version"] != 1
    ):
        raise SupporterSnapshotError("invalid supporter snapshot")
    raw_supporters = value["supporters"]
    if not isinstance(raw_supporters, list) or len(raw_supporters) > MAX_SUPPORTERS:
        raise SupporterSnapshotError("invalid supporter list")

    seen_names: set[str] = set()
    supporters: list[dict] = []
    for item in raw_supporters:
        if not _has_exact_keys(item, {"name", "url", "crown", "support"}):
            raise SupporterSnapshotError("invalid supporter entry")
        name = _normalize_name(item["name"])
        name_key = _name_key(name)
        if name_key in seen_names:
            raise SupporterSnapshotError("duplicate supporter")
        seen_names.add(name_key)
        crown = item["crown"]
        if crown is not None and (not isinstance(crown, str) or crown not in ALLOWED_CROWNS):
            raise SupporterSnapshotError("invalid supporter crown")
        supporters.append(
            {
                "name": name,
                "url": _normalize_url(item["url"]),
                "crown": crown,
                "support": _validate_support(item["support"]),
            }
        )

    supporters.sort(
        key=lambda supporter: (
            -(supporter["support"] or {}).get("total_amount_cents", 0),
            -(supporter["support"] or {}).get("donation_count", 0),
            _name_key(supporter["name"]),
        )
    )
    return supporters


async def _read_bounded_json(response: httpx.Response) -> object:
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise SupporterSnapshotError("invalid content length") from exc
        if declared_length < 0:
            raise SupporterSnapshotError("invalid content length")
        if declared_length > MAX_RESPONSE_BYTES:
            raise SupporterSnapshotError("supporter response too large")

    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise SupporterSnapshotError("supporter response too large")
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SupporterSnapshotError("invalid supporter JSON") from exc


async def fetch_public_supporters(client: httpx.AsyncClient) -> list[dict]:
    async with client.stream(
        "GET",
        SUPPORTERS_API_URL,
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "PokeCollector supporter client",
        },
    ) as response:
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise SupporterSnapshotError("invalid supporter content type")
        cache_directives = {
            directive.split("=", 1)[0].strip().lower()
            for directive in response.headers.get("cache-control", "").split(",")
        }
        if "no-store" not in cache_directives:
            raise SupporterSnapshotError("supporter response is cacheable")
        return validate_public_snapshot(await _read_bounded_json(response))


@router.get("/supporters")
async def get_supporters(response: Response):
    """Return only a fresh, strictly validated projection of the public registry."""
    try:
        timeout = httpx.Timeout(5.0, connect=3.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            async with asyncio.timeout(5.0):
                supporters = await fetch_public_supporters(client)
    except Exception as exc:
        logger.warning("Public supporter registry unavailable (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="Supporter registry temporarily unavailable",
            headers={"Cache-Control": "no-store, max-age=0"},
        ) from exc
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return supporters
