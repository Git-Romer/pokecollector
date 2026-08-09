import base64
import asyncio
import datetime
import httpx
import io
import math
import os
import json
import re
import warnings
from email.utils import parsedate_to_datetime
from functools import lru_cache
from urllib.parse import urlparse
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language
from services.gemini_rate_limit import (
    GeminiKeyBlockedError,
    acquire_gemini_slot,
    penalize_gemini_key,
    record_gemini_success,
)
from services.scan_storage import MAX_FILE_BYTES, ScanUploadError, read_limited_upload, sanitize_image_bytes
from services.scan_trace import ScanTrace, create_scan_trace
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session
from api.auth import get_current_user
from database import get_db
from models import Card, Setting, UserSetting, User, Set

logger = logging.getLogger(__name__)

router = APIRouter()

GEMINI_TRANSIENT_STATUS_CODES = {502, 503, 504}
DEFAULT_GEMINI_MODEL = "gemini-flash-latest"
GEMINI_MODELS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_GEMINI_RETRY_SECONDS = 14 * 24 * 60 * 60
PHASH_MAX_DISTANCE = 20
PHASH_MIN_MARGIN = 5
PHASH_CANDIDATE_LIMIT = 8
MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REFERENCE_IMAGE_PIXELS = 50_000_000
TRUSTED_REFERENCE_IMAGE_HOSTS = {"assets.tcgdex.net"}


class GeminiRateLimitHTTPException(HTTPException):
    """A 429 carrying machine-readable retry metadata for the scan queue."""

    def __init__(self, *, retry_after_seconds: float, retry_reason: str):
        self.retry_after_seconds = max(0.0, float(retry_after_seconds))
        self.retry_reason = retry_reason
        super().__init__(
            status_code=429,
            detail="Gemini Rate Limit erreicht – bitte nach der angegebenen Wartezeit erneut versuchen.",
            headers={"Retry-After": str(max(1, int(self.retry_after_seconds + 0.999)))},
        )


def _normalize_collector_number(value) -> str | None:
    """Normalize a complete numeric or prefixed collector number."""
    if value is None:
        return None
    local = str(value).split("/", 1)[0].strip()
    compact = re.sub(r"[\s_-]+", "", local)
    match = re.fullmatch(r"([A-Za-z]*)(\d+)([A-Za-z]*)", compact)
    if not match:
        return None
    prefix, digits, suffix = match.groups()
    return f"{prefix.casefold()}{int(digits)}{suffix.casefold()}"


def normalize_scanner_card_number(value) -> str | None:
    """Normalize a collector number while preserving identity prefixes."""
    return _normalize_collector_number(value)


def prioritize_cards_by_number(
    cards: list[dict],
    recognized_number,
    *,
    number_field: str = "number",
) -> tuple[list[dict], int]:
    """Stable-partition cards so recognized collector-number matches come first."""
    target_number = normalize_scanner_card_number(recognized_number)
    if not target_number:
        return cards, 0

    matches = []
    rest = []
    for card in cards:
        candidate_number = normalize_scanner_card_number(card.get(number_field))
        (matches if candidate_number == target_number else rest).append(card)

    if not matches:
        return cards, 0
    return matches + rest, len(matches)


def select_search_candidates(
    cards: list[dict],
    recognized_number,
    *,
    number_field: str = "number",
    baseline_limit: int = 8,
    matching_extra_limit: int = 4,
) -> list[dict]:
    """Keep baseline search results and append bounded number matches."""
    selected = list(cards[:baseline_limit])
    for card in selected:
        card["_number_extra"] = False
    target = normalize_scanner_card_number(recognized_number)
    if not target:
        return selected
    extras = 0
    selected_ids = {id(card) for card in selected}
    for card in cards[baseline_limit:]:
        if extras >= matching_extra_limit:
            break
        if normalize_scanner_card_number(card.get(number_field)) != target:
            continue
        if id(card) not in selected_ids:
            card["_number_extra"] = True
            selected.append(card)
            selected_ids.add(id(card))
            extras += 1
    return selected


def retain_ranked_candidates(
    candidates: list[dict],
    *,
    baseline_limit: int = 8,
    matching_extra_limit: int = 4,
) -> list[dict]:
    """Retain ranked baseline results plus bounded late number matches."""
    baseline = [card for card in candidates if not card.get("_number_extra")][
        :baseline_limit
    ]
    extras = [card for card in candidates if card.get("_number_extra")][
        :matching_extra_limit
    ]
    retained_ids = {id(card) for card in baseline + extras}
    return [card for card in candidates if id(card) in retained_ids]


def split_recognized_card_number(value) -> tuple[str | None, str | None]:
    """Split a legacy combined collector number without losing new split fields."""
    if value is None:
        return None, None
    parts = [part.strip() for part in str(value).split("/", 1)]
    local = parts[0] or None
    total = (parts[1] or None) if len(parts) > 1 else None
    return local, total


def normalize_recognized_card_info(card_info: dict | None) -> dict:
    """Keep one canonical split identity while preserving the UI's combined number."""
    normalized = dict(card_info or {})
    legacy_local, legacy_total = split_recognized_card_number(normalized.get("number"))
    local = normalized.get("number_local") or legacy_local
    total = normalized.get("number_total") or legacy_total
    normalized["number_local"] = local
    normalized["number_total"] = total
    normalized["number"] = (
        f"{local}/{total}" if local and total else (str(local) if local else None)
    )
    return normalized


def _normalize_number(value) -> str | None:
    return _normalize_collector_number(value)


def _numbers_match(left, right) -> bool:
    normalized_left = _normalize_number(left)
    normalized_right = _normalize_number(right)
    return normalized_left is not None and normalized_left == normalized_right


def _printed_total_signal(recognized_total, candidate_total) -> int:
    """Return 0 for agreement, 1 for unknown, and 2 for contradiction."""
    normalized = _normalize_number(recognized_total)
    candidate_normalized = _normalize_number(candidate_total)
    if normalized is None or candidate_normalized is None:
        return 1
    return 0 if normalized == candidate_normalized else 2


_ARTIST_PREFIX = re.compile(
    r"^\s*(?:illus|illustrator|art|artwork)(?:\s*[.:]\s*|\s+by\s+|\s+)",
    re.IGNORECASE,
)


def _normalize_artist(value) -> str | None:
    if not value:
        return None
    stripped = _ARTIST_PREFIX.sub("", str(value))
    collapsed = " ".join(stripped.split()).strip().casefold()
    return collapsed or None


def _artists_match(left, right) -> bool:
    normalized_left = _normalize_artist(left)
    normalized_right = _normalize_artist(right)
    return normalized_left is not None and normalized_left == normalized_right


def get_gemini_model() -> str:
    """Return the configured Gemini model name without the optional models/ prefix."""
    model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    if not model:
        model = DEFAULT_GEMINI_MODEL
    if model.startswith("models/"):
        model = model.removeprefix("models/")
    return model


def build_gemini_generate_url(model: str | None = None) -> str:
    """Build the Gemini generateContent endpoint for the configured scanner model."""
    gemini_model = (model or get_gemini_model()).strip()
    if gemini_model.startswith("models/"):
        gemini_model = gemini_model.removeprefix("models/")
    return f"{GEMINI_MODELS_BASE_URL}/{gemini_model}:generateContent"


def gemini_error_message(resp: httpx.Response) -> str:
    """Extract the useful upstream Gemini error body when available."""
    try:
        data = resp.json()
    except ValueError:
        return resp.text.strip()
    error = data.get("error") if isinstance(data, dict) else None
    message = error.get("message") if isinstance(error, dict) else None
    return str(message or "").strip()


def gemini_retry_after_seconds(resp: httpx.Response) -> float | None:
    """Read Gemini's retry hint from a header or google.rpc.RetryInfo body."""
    def valid_delay(value: float) -> float | None:
        return (
            value
            if math.isfinite(value) and 0 < value <= MAX_GEMINI_RETRY_SECONDS
            else None
        )

    header = str(resp.headers.get("retry-after", "")).strip()
    if header:
        try:
            value = valid_delay(float(header))
            if value is not None:
                return value
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(header)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=datetime.timezone.utc)
                response_date = str(resp.headers.get("date", "")).strip()
                baseline = (
                    parsedate_to_datetime(response_date)
                    if response_date
                    else datetime.datetime.now(datetime.timezone.utc)
                )
                if baseline.tzinfo is None:
                    baseline = baseline.replace(tzinfo=datetime.timezone.utc)
                value = valid_delay((retry_at - baseline).total_seconds())
                if value is not None:
                    return value
            except (TypeError, ValueError, OverflowError):
                pass
    try:
        payload = resp.json()
    except ValueError:
        return None
    details = payload.get("error", {}).get("details", []) if isinstance(payload, dict) else []
    for detail in details if isinstance(details, list) else []:
        if not isinstance(detail, dict):
            continue
        delay = str(detail.get("retryDelay", "")).strip()
        match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)s", delay)
        if match:
            value = valid_delay(float(match.group(1)))
            if value is not None:
                return value
    return None


def gemini_rate_limit_reason(resp: httpx.Response) -> str:
    """Classify reliable requests-per-day quota signals; default to short-term."""
    try:
        payload = resp.json()
    except ValueError:
        payload = {}
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    details = error.get("details", []) if isinstance(error, dict) else []
    signals = []
    for detail in details if isinstance(details, list) else []:
        if not isinstance(detail, dict):
            continue
        detail_type = str(detail.get("@type") or "")
        if not detail_type.endswith("google.rpc.QuotaFailure"):
            continue
        violations = detail.get("violations", [])
        for violation in violations if isinstance(violations, list) else []:
            if not isinstance(violation, dict):
                continue
            signals.extend(
                str(violation.get(key) or "")
                for key in ("quotaId", "quotaMetric", "subject")
            )

    normalized = " ".join(signals).lower()
    compact = re.sub(r"[^a-z0-9]+", "", normalized)
    daily_markers = (
        "requestsperday",
        "requestperday",
        "generatedrequestsperday",
        "perdayperproject",
        "perdayperuser",
        "dailyquota",
    )
    return "daily_quota" if any(marker in compact for marker in daily_markers) else "rate_limit"


def get_gemini_key(db: Session, user_id: int = None) -> str:
    """Read Gemini API key from user settings only. No cross-user fallback."""
    if user_id is not None:
        row = db.query(UserSetting).filter(
            UserSetting.user_id == user_id, UserSetting.key == "gemini_api_key"
        ).first()
        if row and row.value:
            return row.value
    # No global/env fallback — each user must configure their own key
    return ""


async def post_gemini_generate(
    client: httpx.AsyncClient,
    gemini_url: str,
    api_key: str,
    payload: dict,
    *,
    max_attempts: int = 3,
) -> httpx.Response:
    """Call Gemini with small retries for transient capacity errors."""
    last_error = None

    for attempt in range(max_attempts):
        try:
            await acquire_gemini_slot(api_key)
            resp = await client.post(
                gemini_url,
                headers={"x-goog-api-key": api_key},
                json=payload,
            )

            if resp.status_code == 429:
                retry_reason = gemini_rate_limit_reason(resp)
                retry_after = penalize_gemini_key(
                    api_key,
                    seconds=gemini_retry_after_seconds(resp),
                    reason=retry_reason,
                )
                raise GeminiRateLimitHTTPException(
                    retry_after_seconds=retry_after,
                    retry_reason=retry_reason,
                )
            if resp.status_code in {400, 401, 403}:
                raise HTTPException(
                    status_code=400,
                    detail="Ungültiger Gemini API Key. Bitte in den Einstellungen prüfen.",
                )
            if resp.status_code == 404:
                upstream_message = gemini_error_message(resp)
                detail = "Gemini Modell nicht verfügbar. Bitte GEMINI_MODEL auf ein unterstütztes Modell setzen."
                if upstream_message:
                    detail = f"{detail} Google meldet: {upstream_message}"
                raise HTTPException(status_code=502, detail=detail)
            if resp.status_code in GEMINI_TRANSIENT_STATUS_CODES:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise HTTPException(
                    status_code=503,
                    detail="Gemini ist gerade temporär überlastet oder nicht verfügbar. Bitte gleich nochmal versuchen.",
                )
            if resp.is_error:
                upstream_message = gemini_error_message(resp)
                detail = f"Gemini Anfrage fehlgeschlagen ({resp.status_code})."
                if upstream_message:
                    detail = f"{detail} Google meldet: {upstream_message}"
                raise HTTPException(status_code=502, detail=detail)
            try:
                record_gemini_success(api_key)
            except Exception:
                logger.exception("Could not reset Gemini quota state after a successful response")
            return resp
        except GeminiKeyBlockedError as error:
            raise GeminiRateLimitHTTPException(
                retry_after_seconds=error.retry_after_seconds,
                retry_reason=error.reason,
            )
        except HTTPException:
            raise
        except httpx.RequestError as e:
            last_error = e
            if attempt < max_attempts - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            raise HTTPException(
                status_code=503,
                detail="Gemini konnte gerade nicht erreicht werden. Bitte Verbindung prüfen oder später erneut versuchen.",
            )

    raise HTTPException(status_code=500, detail=f"Gemini Anfrage fehlgeschlagen: {last_error}")


RECOGNIZE_PROMPT = """Look at this Pokemon Trading Card Game card image.

IMPORTANT ACCURACY RULES:
- Only report text or symbols that are actually visible in this image.
- number_local, number_total, set_code, regulation_mark, and artist are small printed
  details. If any character is unclear, return null instead of guessing.
- Only return set_code when printed alphanumeric characters are visible near the card
  number. Do not infer a code from the artwork or from recognizing the set.

Extract:
1. Card name exactly as printed, in the card's language
2. English card name (same value when already English)
3. Local collector number, or null
4. Printed set total/denominator, or null
5. Printed set code/abbreviation, or null
6. Regulation mark, or null
7. Card type: Pokemon, Trainer, or Energy
8. HP value, or null
9. Two-letter ISO language code
10. Artist/illustrator credit, or null

Respond ONLY with this exact JSON:
{
  "name": "...",
  "name_en": "...",
  "number_local": null,
  "number_total": null,
  "set_code": null,
  "regulation_mark": null,
  "card_type": "Pokemon/Trainer/Energy",
  "hp": null,
  "language": "en",
  "artist": null
}
Replace a null only when that exact value is clearly visible."""


_SUFFIXES = re.compile(
    r"[\s-]+(?:EX|ex|GX|gx|V|VMAX|VSTAR|VStar|TAG\s*TEAM|BREAK|LV\.?\s*X)\s*$",
    re.IGNORECASE,
)


def _simplify_name(name: str) -> str:
    return _SUFFIXES.sub("", name).strip()


def _identity_signal(target, candidate, matcher) -> int:
    """Return 0 for agreement, 1 for unknown, and 2 for contradiction."""
    if target in (None, "") or candidate in (None, ""):
        return 1
    return 0 if matcher(target, candidate) else 2


def _candidate_rank_key(card_info: dict, candidate: dict) -> tuple[int, ...]:
    return (
        _identity_signal(card_info.get("number_local"), candidate.get("number"), _numbers_match),
        _identity_signal(
            normalize_tcgdex_language(card_info.get("language"))
            if card_info.get("language") else None,
            normalize_tcgdex_language(candidate.get("_lang"))
            if candidate.get("_lang") else None,
            lambda left, right: left == right,
        ),
        _printed_total_signal(
            card_info.get("number_total"), candidate.get("printed_total")
        ),
        _identity_signal(
            str(card_info.get("set_code") or "").strip().casefold() or None,
            str(candidate.get("set_abbreviation") or "").strip().casefold() or None,
            lambda left, right: left == right,
        ),
        _identity_signal(
            str(card_info.get("regulation_mark") or "").strip().casefold() or None,
            str(candidate.get("regulation_mark") or "").strip().casefold() or None,
            lambda left, right: left == right,
        ),
        _identity_signal(card_info.get("artist"), candidate.get("artist"), _artists_match),
        _identity_signal(card_info.get("hp"), candidate.get("hp"), _numbers_match),
    )


def _confirmed_identity_signals(card_info: dict, candidate: dict) -> set[str]:
    names = ("number", "language", "total", "set", "regulation", "artist", "hp")
    return {
        name
        for name, score in zip(names, _candidate_rank_key(card_info, candidate))
        if score == 0
    }


def _metadata_decision(card_info: dict, candidates: list[dict]) -> tuple[bool, str | None]:
    """Decide only when reliable metadata isolates one candidate."""
    if not candidates:
        return False, None
    ranked = sorted(candidates, key=lambda card: _candidate_rank_key(card_info, card))
    top = ranked[0]
    top_key = _candidate_rank_key(card_info, top)
    if sum(1 for card in ranked if _candidate_rank_key(card_info, card) == top_key) != 1:
        return False, None

    # Contradictory known metadata cannot identify one clear printing. An
    # individual scan may still use visual verification; a composite safely
    # falls back to recognizing only that source photo again.
    if 2 in top_key:
        return False, None

    signals = _confirmed_identity_signals(card_info, top)
    number_matches = sum(
        1
        for card in ranked
        if _identity_signal(card_info.get("number_local"), card.get("number"), _numbers_match) == 0
    )
    if "number" in signals and number_matches == 1:
        return True, "number_unique"
    if "number" in signals and signals.intersection(
        {"language", "total", "set", "regulation"}
    ):
        return True, "number_metadata"
    if not card_info.get("number_local") and {"artist", "hp"}.issubset(signals):
        return True, "artist_hp"
    return False, None


async def _download_candidate_images(
    client: httpx.AsyncClient,
    candidates: list[dict],
    existing: dict[str, bytes] | None = None,
) -> dict[str, bytes]:
    """Download each candidate image at most once for pHash/Gemini reuse."""
    downloaded = dict(existing or {})

    async def fetch(candidate: dict) -> tuple[str, bytes] | None:
        candidate_id = str(candidate.get("id") or "")
        image_url = candidate.get("image")
        if not candidate_id or not image_url or candidate_id in downloaded:
            return None
        parsed_url = urlparse(str(image_url))
        if (
            parsed_url.scheme != "https"
            or parsed_url.hostname not in TRUSTED_REFERENCE_IMAGE_HOSTS
        ):
            return None
        try:
            async with client.stream("GET", image_url, timeout=5) as response:
                if response.status_code != 200:
                    return None
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        if int(content_length) > MAX_REFERENCE_IMAGE_BYTES:
                            return None
                    except ValueError:
                        return None

                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > MAX_REFERENCE_IMAGE_BYTES:
                        return None
                    content.extend(chunk)
                if content:
                    return candidate_id, bytes(content)
        except Exception:
            return None
        return None

    results = await asyncio.gather(*(fetch(candidate) for candidate in candidates))
    downloaded.update(result for result in results if result is not None)
    return downloaded


@lru_cache(maxsize=1)
def _phash_dct_matrix():
    """Build the unnormalised DCT-II matrix used by imagehash.phash."""
    import numpy as np

    size = 32
    positions = np.arange(size)
    frequencies = np.arange(size)[:, None]
    return 2 * np.cos(
        np.pi * frequencies * (2 * positions + 1) / (2 * size)
    )


def _perceptual_hash(image_bytes: bytes | None) -> tuple[bool, ...] | None:
    """Return the same 64-bit pHash as imagehash without its SciPy dependency."""
    if not image_bytes:
        return None
    try:
        import numpy as np
        from PIL import Image

        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as image:
                width, height = image.size
                if (
                    width <= 0
                    or height <= 0
                    or width * height > MAX_REFERENCE_IMAGE_PIXELS
                ):
                    return None
                pixels = np.asarray(
                    image.convert("L").resize(
                        (32, 32),
                        Image.Resampling.LANCZOS,
                    ),
                    dtype=float,
                )
        transform = _phash_dct_matrix()
        low_frequencies = (transform @ pixels @ transform.T)[:8, :8]
        median = np.median(low_frequencies)
        return tuple(bool(value) for value in (low_frequencies > median).flat)
    except Exception:
        return None


def _phash_best_match(
    candidates: list[dict],
    photo_bytes: bytes | None,
    candidate_images: dict[str, bytes],
    trace: ScanTrace | None = None,
) -> dict | None:
    """Return a clearly separated perceptual match, otherwise abstain."""
    photo_hash = _perceptual_hash(photo_bytes)
    if photo_hash is None:
        return None

    scored: list[tuple[int, dict]] = []
    for candidate in candidates[:PHASH_CANDIDATE_LIMIT]:
        image_bytes = candidate_images.get(str(candidate.get("id") or ""))
        if not image_bytes:
            continue
        candidate_hash = _perceptual_hash(image_bytes)
        if candidate_hash is None:
            continue
        distance = sum(left != right for left, right in zip(photo_hash, candidate_hash))
        scored.append((distance, candidate))

    if len(scored) < 2:
        if trace:
            trace.record_phash(
                [
                    (distance, str(candidate.get("tcg_card_id") or ""))
                    for distance, candidate in scored
                ],
                accepted=None,
                reason="insufficient_images",
            )
        return None
    scored.sort(key=lambda pair: pair[0])
    best_distance, best_candidate = scored[0]
    runner_up_distance = scored[1][0]
    too_far = best_distance > PHASH_MAX_DISTANCE
    too_close = runner_up_distance - best_distance < PHASH_MIN_MARGIN
    accepted = None if too_far or too_close else best_candidate
    if trace:
        trace.record_phash(
            [
                (distance, str(candidate.get("tcg_card_id") or ""))
                for distance, candidate in scored
            ],
            accepted=(
                str(accepted.get("tcg_card_id") or "") if accepted else None
            ),
            reason=(
                "too_far" if too_far else "ambiguous_margin" if too_close else "accepted"
            ),
        )
    if accepted is None:
        return None
    return accepted


async def _fill_candidate_details(
    db: Session,
    candidates: list[dict],
    card_info: dict,
    *,
    limit: int = 8,
) -> None:
    """Fill only metadata needed by the deterministic ranker, local DB first."""
    targets = candidates[:limit]
    required_fields = {
        candidate_field
        for recognized_field, candidate_field in (
            ("artist", "artist"),
            ("hp", "hp"),
            ("regulation_mark", "regulation_mark"),
            ("number_total", "printed_total"),
        )
        if card_info.get(recognized_field) not in (None, "")
    }
    if not targets or not required_fields:
        return

    ids = [card["id"] for card in targets if card.get("id")]
    if ids and required_fields.intersection({"artist", "hp", "regulation_mark"}):
        rows = db.query(Card.id, Card.artist, Card.hp, Card.regulation_mark).filter(
            Card.id.in_(ids)
        ).all()
        local = {row.id: row for row in rows}
        for card in targets:
            row = local.get(card.get("id"))
            if row:
                card["artist"] = card.get("artist") or row.artist
                card["hp"] = card.get("hp") or row.hp
                card["regulation_mark"] = card.get("regulation_mark") or row.regulation_mark

    missing = [
        card
        for card in targets
        if any(not card.get(field) for field in required_fields)
    ]
    if not missing:
        return

    async with httpx.AsyncClient(timeout=8) as client:
        async def fetch(card):
            tcg_id = card.get("tcg_card_id")
            language = card.get("_lang", "en")
            if not tcg_id:
                return
            try:
                response = await client.get(
                    f"https://api.tcgdex.net/v2/{language}/cards/{tcg_id}"
                )
                if response.status_code != 200:
                    return
                detail = response.json()
                card["artist"] = card.get("artist") or detail.get("illustrator")
                card["hp"] = card.get("hp") or detail.get("hp")
                card["regulation_mark"] = (
                    card.get("regulation_mark") or detail.get("regulationMark")
                )
                official_total = ((detail.get("set") or {}).get("cardCount") or {}).get("official")
                card["printed_total"] = card.get("printed_total") or official_total
            except Exception:
                return

        await asyncio.gather(*(fetch(card) for card in missing))


async def _search_and_rank_candidates(
    db: Session,
    card_info: dict,
    trace: ScanTrace | None = None,
) -> tuple[list[dict], int]:
    card_name = str(card_info.get("name") or "").strip()
    card_name_en = str(card_info.get("name_en") or card_name).strip() or card_name
    if not card_name:
        raise HTTPException(status_code=422, detail="Kartenname konnte nicht erkannt werden.")

    simple_name = _simplify_name(card_name)
    simple_name_en = _simplify_name(card_name_en)
    language = normalize_tcgdex_language(card_info.get("language", "en"))
    if not is_supported_tcgdex_language(language):
        language = "en"
    search_pairs = [(language, simple_name)]
    if simple_name != card_name:
        search_pairs.append((language, card_name))
    if language != "en":
        search_pairs.append(("en", simple_name_en))
        if simple_name_en != card_name_en:
            search_pairs.append(("en", card_name_en))

    candidates = []
    for search_language, search_name in search_pairs:
        if len(candidates) >= 15:
            break
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.get(
                    f"https://api.tcgdex.net/v2/{search_language}/cards",
                    params={"name": search_name},
                )
            cards = response.json() if response.status_code == 200 else []
            if trace:
                trace.record_tcgdex(
                    language=search_language,
                    query=search_name,
                    status=response.status_code,
                    count=len(cards) if isinstance(cards, list) else None,
                )
            if not isinstance(cards, list):
                continue
            selected_cards = select_search_candidates(
                cards,
                card_info.get("number_local"),
                number_field="localId",
            )
            for card in selected_cards:
                card_id = card.get("id")
                if not card_id:
                    continue
                candidates.append({
                    "id": f"{card_id}_{search_language}",
                    "tcg_card_id": card_id,
                    "name": card.get("name"),
                    "set": card.get("set", {}).get("name")
                    if isinstance(card.get("set"), dict) else None,
                    "number": card.get("localId"),
                    "image": f"{card.get('image')}/low.webp" if card.get("image") else None,
                    "rarity": card.get("rarity"),
                    "lang": search_language,
                    "_lang": search_language,
                    "_number_extra": bool(card.get("_number_extra")),
                })
        except Exception as exc:
            if trace:
                trace.record_tcgdex(
                    language=search_language,
                    query=search_name,
                    status=None,
                    count=None,
                    error=type(exc).__name__,
                )
            continue

    candidate_set_ids = {
        tcg_card_id.rsplit("-", 1)[0]
        for candidate in candidates
        if "-" in (tcg_card_id := candidate.get("tcg_card_id", ""))
    }
    local_sets = {}
    if candidate_set_ids:
        rows = db.query(Set).filter(Set.tcg_set_id.in_(candidate_set_ids)).all()
        local_sets = {(row.tcg_set_id, row.lang): row for row in rows}
    for candidate in candidates:
        tcg_card_id = candidate.get("tcg_card_id", "")
        if "-" not in tcg_card_id:
            continue
        set_id = tcg_card_id.rsplit("-", 1)[0]
        language = candidate.get("_lang", "en")
        local_set = local_sets.get((set_id, language))
        if local_set:
            candidate["set"] = local_set.name
            candidate["set_abbreviation"] = local_set.abbreviation
            candidate["printed_total"] = local_set.printed_total or None

    seen = set()
    deduped = []
    for candidate in candidates:
        key = (candidate.get("id"), candidate.get("_lang", "en"))
        if key not in seen:
            seen.add(key)
            deduped.append(candidate)

    await _fill_candidate_details(db, deduped, card_info)
    deduped.sort(key=lambda card: _candidate_rank_key(card_info, card))
    number_match_count = sum(
        1
        for card in deduped
        if _identity_signal(card_info.get("number_local"), card.get("number"), _numbers_match) == 0
    )
    if trace:
        trace.record_prefilter(
            card_info.get("number_local"),
            number_match_count,
            len(deduped),
        )
        trace.record_candidates(deduped, lambda card: _candidate_rank_key(card_info, card))
    return deduped, number_match_count


async def match_card_info(
    db: Session,
    card_info: dict,
    *,
    api_key: str | None = None,
    image_b64: str | None = None,
    mime_type: str | None = None,
    allow_visual_verification: bool = False,
    photo_bytes: bytes | None = None,
    trace: ScanTrace | None = None,
) -> dict:
    """Shared deterministic matcher for both individual and composite scans."""
    card_info = normalize_recognized_card_info(card_info)
    candidates, number_match_count = await _search_and_rank_candidates(db, card_info, trace)
    confident, decision = _metadata_decision(card_info, candidates)

    top_candidates = retain_ranked_candidates(candidates)
    can_compare = sum(1 for card in top_candidates if card.get("image")) >= 2
    if photo_bytes is None and image_b64:
        try:
            photo_bytes = base64.b64decode(image_b64, validate=True)
        except (ValueError, TypeError):
            photo_bytes = None

    should_try_phash = not confident and can_compare and bool(photo_bytes)
    should_try_visual = (
        allow_visual_verification
        and not confident
        and can_compare
        and bool(api_key)
        and bool(image_b64)
        and bool(mime_type)
    )
    if should_try_phash or should_try_visual:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                candidate_images = await _download_candidate_images(
                    client,
                    top_candidates[:PHASH_CANDIDATE_LIMIT],
                )
                if should_try_phash:
                    try:
                        winner = _phash_best_match(
                            top_candidates,
                            photo_bytes,
                            candidate_images,
                            trace,
                        )
                        if (
                            winner is not None
                            and 2 not in _candidate_rank_key(card_info, winner)
                        ):
                            candidates.remove(winner)
                            candidates.insert(0, winner)
                            confident = True
                            decision = "phash"
                        elif winner is not None and trace:
                            trace.reject_phash("metadata_contradiction")
                    except Exception as exc:
                        logger.warning("pHash matching failed (non-blocking): %s", exc)

                if not confident and should_try_visual:
                    candidate_images = await _download_candidate_images(
                        client,
                        top_candidates,
                        candidate_images,
                    )
                    parts = [
                        {"text": "Here is the original card photo:"},
                        {"inline_data": {"mime_type": mime_type, "data": image_b64}},
                        {"text": (
                            "Choose the matching candidate using artwork and printed "
                            "identity details. Respond with only its number, or 0 if "
                            "none match.\n"
                        )},
                    ]
                    for index, candidate in enumerate(top_candidates, start=1):
                        parts.append({"text": (
                            f"\nCandidate {index}: {candidate.get('name', '?')} "
                            f"#{candidate.get('number', '?')}"
                        )})
                        candidate_bytes = candidate_images.get(
                            str(candidate.get("id") or "")
                        )
                        if candidate_bytes:
                            parts.append({"inline_data": {
                                "mime_type": "image/webp",
                                "data": base64.b64encode(candidate_bytes).decode(),
                            }})
                        else:
                            parts.append({"text": " (image unavailable)"})

                    response = await post_gemini_generate(
                        client,
                        build_gemini_generate_url(),
                        api_key,
                        {"contents": [{"parts": parts}]},
                        max_attempts=2,
                    )
                    response_text = response.json()["candidates"][0]["content"][
                        "parts"
                    ][0]["text"]
                    pick_match = re.search(r"(\d+)", response_text)
                    selected_position = int(pick_match.group(1)) if pick_match else None
                    if trace:
                        trace.record_visual_verification(
                            raw_response=response_text,
                            selected=selected_position,
                        )
                    if pick_match:
                        pick = selected_position
                        if 1 <= pick <= len(top_candidates):
                            winner = top_candidates[pick - 1]
                            candidates.remove(winner)
                            candidates.insert(0, winner)
                            confident = True
                            decision = "gemini_visual"
        except Exception as exc:
            logger.warning("Visual matching failed (non-blocking): %s", exc)

    public_matches = [
        {key: value for key, value in card.items() if key != "_number_extra"}
        for card in retain_ranked_candidates(candidates)
    ]
    if trace:
        selected = (
            str(candidates[0].get("tcg_card_id") or "")
            if confident and candidates
            else None
        )
        trace.record_decision(decision or "undecided", selected or None)
    return {
        "recognized": card_info,
        "matches": public_matches,
        "_number_match_count": number_match_count,
        "_identity_confident": confident,
        "_identity_decision": decision,
    }


async def recognize_sanitized_card(
    db: Session,
    user_id: int,
    image_bytes: bytes,
    content_type: str,
    *,
    trace: ScanTrace | None = None,
) -> dict:
    """Recognize one already-sanitized image for direct and queued scans."""
    api_key = get_gemini_key(db, user_id=user_id)
    if not api_key:
        if trace:
            trace.record_error("No Gemini API key is configured.")
        raise HTTPException(
            status_code=400,
            detail="Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen.",
        )

    image_b64 = base64.b64encode(image_bytes).decode()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await post_gemini_generate(
                client,
                build_gemini_generate_url(),
                api_key,
                {"contents": [{"parts": [
                    {"text": RECOGNIZE_PROMPT},
                    {"inline_data": {
                        "mime_type": content_type,
                        "data": image_b64,
                    }},
                ]}]},
            )
        payload = response.json()
        response_text = payload["candidates"][0]["content"]["parts"][0]["text"].strip()
        if trace:
            trace.record_extraction(
                prompt=RECOGNIZE_PROMPT,
                raw_response=response_text,
                usage=payload.get("usageMetadata"),
            )
        json_match = re.search(r"\{.*\}", response_text, re.DOTALL)
        if not json_match:
            raise ValueError("No JSON found in Gemini response")
        card_info = normalize_recognized_card_info(json.loads(json_match.group()))
        if trace:
            trace.record_extraction(parsed=card_info)
    except HTTPException as exc:
        if trace:
            trace.record_error(str(exc.detail))
        raise
    except Exception as exc:
        if trace:
            trace.record_error(f"Recognition parsing failed: {type(exc).__name__}")
        raise HTTPException(status_code=500, detail=f"Erkennung fehlgeschlagen: {exc}")

    try:
        return await match_card_info(
            db,
            card_info,
            api_key=api_key,
            image_b64=image_b64,
            mime_type=content_type,
            allow_visual_verification=True,
            photo_bytes=image_bytes,
            trace=trace,
        )
    except HTTPException as exc:
        if trace:
            trace.record_error(str(exc.detail))
        raise
    except Exception as exc:
        if trace:
            trace.record_error(f"Candidate matching failed: {type(exc).__name__}")
        raise


@router.post("/recognize")
async def recognize_card(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        raw_image = await read_limited_upload(file, remaining_job_bytes=MAX_FILE_BYTES)
        sanitized = sanitize_image_bytes(raw_image)
    except ScanUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    trace = create_scan_trace(
        db,
        current_user.id,
        mode="single",
        filename="sanitized-upload.jpg",
        model=get_gemini_model(),
    )
    trace.set_image(sanitized.data)
    try:
        return await recognize_sanitized_card(
            db,
            current_user.id,
            sanitized.data,
            sanitized.content_type,
            trace=trace,
        )
    finally:
        trace.save()


COMPOSITE_PROMPT = """This image contains {count} separate Pokemon Trading Card Game cards.
They are arranged left-to-right, then top-to-bottom, and each card has a white index number
on a black square directly above it. Identify every card. Read that index label instead of
relying on response order.

For each card return the same information as an individual scan:
- index: the printed corner number
- name: exact card name in the card's language
- name_en: English card name
- number_local: printed local collector number, or null
- number_total: printed set total/denominator, or null
- set_code: printed alphanumeric set code near the number, or null
- regulation_mark: boxed regulation letter, or null
- card_type: Pokemon, Trainer, or Energy
- hp: HP value or null
- language: two-letter ISO language code
- artist: printed illustrator credit, or null

Only report small identity text when every character is visible. Never infer set_code from
the artwork or from recognizing the set. If a detail is unclear, use null rather than
guessing. Respond ONLY with a JSON array containing one object per card, without markdown
or explanation.
"""


class CompositeRecognitionError(ValueError):
    """The composite response could not be mapped safely to its source photos."""


async def recognize_composite_card_info(
    api_key: str,
    image_bytes: bytes,
    count: int,
    *,
    traces: list[ScanTrace] | None = None,
) -> dict[int, dict]:
    """Return Gemini card information keyed by zero-based composite position."""
    image_b64 = base64.b64encode(image_bytes).decode()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await post_gemini_generate(
                client,
                build_gemini_generate_url(),
                api_key,
                {
                    "contents": [{
                        "parts": [
                            {"text": COMPOSITE_PROMPT.format(count=count)},
                            {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
                        ]
                    }]
                },
            )
        payload = response.json()
        response_text = payload["candidates"][0]["content"]["parts"][0]["text"].strip()
        for trace in traces or []:
            trace.record_extraction(
                prompt=COMPOSITE_PROMPT.format(count=count),
                raw_response=response_text,
                usage=payload.get("usageMetadata"),
            )
        array_match = re.search(r"\[.*\]", response_text, re.DOTALL)
        if not array_match:
            raise CompositeRecognitionError("Gemini returned no card list for the composite.")
        rows = json.loads(array_match.group())
        if not isinstance(rows, list):
            raise CompositeRecognitionError("Gemini returned an invalid composite card list.")
    except HTTPException:
        raise
    except CompositeRecognitionError:
        raise
    except Exception as exc:
        raise CompositeRecognitionError(f"Could not parse the composite result: {exc}") from exc

    mapped: dict[int, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            position = int(row.get("index")) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= position < count and position not in mapped:
            mapped[position] = normalize_recognized_card_info(row)
            if traces and position < len(traces):
                traces[position].record_extraction(parsed=mapped[position])
    return mapped


async def match_composite_card_info(
    db: Session,
    card_info: dict,
    *,
    photo_bytes: bytes | None = None,
    trace: ScanTrace | None = None,
) -> dict:
    """Use local pHash before an uncertain composite falls back individually."""
    return await match_card_info(
        db,
        card_info,
        allow_visual_verification=False,
        photo_bytes=photo_bytes,
        trace=trace,
    )
