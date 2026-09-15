"""Persistent local cache for National Pokédex sprites and official artwork."""

from __future__ import annotations

import os
import tempfile
import time
from collections.abc import Iterable
from pathlib import Path

import httpx

MAX_DEX_ID = 1025
MAX_IMAGE_ID = 20000  # PokeAPI form IDs currently use the 10000 range.
CACHE_ROOT = Path(os.environ.get("POKEDEX_IMAGE_CACHE_DIR", "/app/data/pokedex-images"))
URLS = {
    "sprites": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{dex_id}.png",
    "artwork": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{dex_id}.png",
}
USER_AGENT = "pokecollector-pokedex-cache/1.0"


def validate_kind(kind: str) -> str:
    if kind not in URLS:
        raise ValueError(f"Unsupported image kind: {kind}")
    return kind


def validate_dex_id(dex_id: int) -> int:
    dex_id = int(dex_id)
    if not 1 <= dex_id <= MAX_IMAGE_ID:
        raise ValueError(f"PokéAPI image ID must be between 1 and {MAX_IMAGE_ID}")
    return dex_id


def cache_path(kind: str, dex_id: int) -> Path:
    validate_kind(kind)
    validate_dex_id(dex_id)
    return CACHE_ROOT / kind / f"{dex_id}.png"


def fetch_image(kind: str, dex_id: int, *, refresh: bool = False, client: httpx.Client | None = None) -> Path | None:
    path = cache_path(kind, dex_id)
    if path.is_file() and not refresh:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    owns_client = client is None
    client = client or httpx.Client(timeout=30.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
    try:
        response = client.get(URLS[kind].format(dex_id=dex_id))
        if response.status_code == 404:
            return None
        response.raise_for_status()
        if not response.content:
            return None
        fd, temp_name = tempfile.mkstemp(prefix=f".{dex_id}-", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(response.content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        return path
    finally:
        if owns_client:
            client.close()


def populate_cache(
    *,
    minimum: int = 1,
    maximum: int = MAX_DEX_ID,
    refresh: bool = False,
    delay: float = 0.05,
) -> dict:
    minimum = validate_dex_id(minimum)
    maximum = validate_dex_id(maximum)
    if minimum > maximum:
        raise ValueError("minimum cannot be greater than maximum")
    return populate_image_ids(
        range(minimum, maximum + 1),
        refresh=refresh,
        delay=delay,
    )


def populate_image_ids(
    image_ids: Iterable[int],
    *,
    refresh: bool = False,
    delay: float = 0.05,
) -> dict:
    image_ids = tuple(dict.fromkeys(validate_dex_id(value) for value in image_ids))
    result = {"cached": 0, "downloaded": 0, "missing": [], "failed": []}
    with httpx.Client(timeout=30.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
        for dex_id in image_ids:
            for kind in ("sprites", "artwork"):
                path = cache_path(kind, dex_id)
                if path.is_file() and not refresh:
                    result["cached"] += 1
                    continue
                try:
                    fetched = fetch_image(kind, dex_id, refresh=refresh, client=client)
                    if fetched:
                        result["downloaded"] += 1
                    else:
                        result["missing"].append({"dex_id": dex_id, "kind": kind})
                except Exception as exc:  # continue a long-running backfill
                    result["failed"].append({"dex_id": dex_id, "kind": kind, "error": str(exc)})
                if delay:
                    time.sleep(delay)
    return result
