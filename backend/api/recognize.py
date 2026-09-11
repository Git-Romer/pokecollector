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
from services.scan_candidate_images import prewarm_candidate_images
from services.scan_storage import MAX_FILE_BYTES, ScanUploadError, read_limited_upload, sanitize_image_bytes
from services.scan_trace import ScanTrace, create_scan_trace
from services.text_search import accent_insensitive_contains, strip_diacritics
from services.scan_providers import (
    DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS,
    GEMINI,
    SCANNER_CAPABILITY_DEGRADED,
    ScanProvider,
    get_provider,
    image_part,
    image_part_from_bytes,
    require_scanner_capability_mode,
    resolve_scanner_request_timeout,
    text_part,
)
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session
from api.auth import get_current_user
from database import get_db
from models import Card, Setting, UserSetting, User, Set

logger = logging.getLogger(__name__)

router = APIRouter()

# The event loop only keeps weak references to fire-and-forget tasks. Retain
# candidate prewarms until completion so they cannot disappear mid-download.
_candidate_prewarm_tasks: set[asyncio.Task] = set()

GEMINI_TRANSIENT_STATUS_CODES = {408, 425, 500, 502, 503, 504}
DEFAULT_GEMINI_MODEL = "gemini-flash-latest"
GEMINI_MODELS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_GEMINI_RETRY_SECONDS = 14 * 24 * 60 * 60
PHASH_MAX_DISTANCE = 20
PHASH_MIN_MARGIN = 5
PHASH_CANDIDATE_LIMIT = 8
# Deliberately generous relative to select_search_candidates' baseline_limit=8.
# Exact collector-number matches are retained separately, so this cap bounds the
# non-number baseline without risking that a heavily reprinted card name hides
# the scanned printing beyond the local window.
SEARCH_CANDIDATE_QUERY_LIMIT = 50
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


_POKEDEX_NUMBER_TEXT = re.compile(r"\bno\.?\s*\d", re.IGNORECASE)


def _drop_pokedex_number(value) -> str | None:
    """Discard only an explicit ``No. 123``-style Pokedex reference."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return None if _POKEDEX_NUMBER_TEXT.search(text) else text


def normalize_recognized_card_info(card_info: dict | None) -> dict:
    """Keep one canonical split identity while preserving the UI's combined number."""
    normalized = dict(card_info or {})
    legacy_local, legacy_total = split_recognized_card_number(normalized.get("number"))
    local = (
        _drop_pokedex_number(normalized.get("number_local"))
        or _drop_pokedex_number(legacy_local)
    )
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


def _apply_printed_total_mismatch(card_info: dict, candidates: list[dict]) -> None:
    """Surface the ranker's printed-total contradiction as a plain boolean.

    `_candidate_rank_key` already scores this (see `_printed_total_signal`
    above) to rank a contradicting printing lower, but that score never
    reaches the public candidate dict. The review grid needs it as a visible
    badge, not just a silent ranking effect, so mark each candidate in place.
    """
    for candidate in candidates:
        candidate["printed_total_mismatch"] = (
            _printed_total_signal(card_info.get("number_total"), candidate.get("printed_total")) == 2
        )


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
            return row.value.strip()
    # No global/env fallback — each user must configure their own key
    return ""


def _requested_gemini_model(gemini_url: str) -> str:
    """The model the failing request actually asked for, read back off the URL."""
    tail = gemini_url.rsplit("/", 1)[-1]
    return tail.split(":", 1)[0] or get_gemini_model()


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
            if resp.status_code in {401, 403}:
                raise HTTPException(
                    status_code=400,
                    detail="Ungültiger Gemini API Key. Bitte in den Einstellungen prüfen.",
                )
            if resp.status_code == 400:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Gemini hat die Scanner-Anfrage abgelehnt. Bitte Bild und "
                        "Modell in den Einstellungen prüfen."
                    ),
                )
            if resp.status_code == 404:
                # A user can now name their own model, so pointing everyone at
                # GEMINI_MODEL would send them after a setting they cannot see.
                # The installation default is still named for administrators.
                requested = _requested_gemini_model(gemini_url)
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Gemini Modell \"{requested}\" nicht verfügbar. Bitte in den "
                        "Einstellungen ein anderes Modell wählen, oder GEMINI_MODEL auf "
                        "ein unterstütztes Modell setzen."
                    ),
                )
            if resp.status_code in GEMINI_TRANSIENT_STATUS_CODES:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise HTTPException(
                    status_code=503,
                    detail="Gemini ist gerade temporär überlastet oder nicht verfügbar. Bitte gleich nochmal versuchen.",
                )
            if resp.is_error:
                if 400 <= resp.status_code < 500:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "Gemini hat die Scanner-Anfrage abgelehnt "
                            f"({resp.status_code}). Bitte Bild und Modell prüfen."
                        ),
                    )
                raise HTTPException(
                    status_code=503,
                    detail="Gemini ist gerade nicht verfügbar. Bitte später erneut versuchen.",
                )
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
- Some cards, especially older ones, print a "No. 0094" or "No.94"-style reference
  near the artwork or flavor text. That is the species' National Pokedex number, not
  this card's collector number, and must never be used as number_local. Only use
  number_local for a small index printed for this specific card, usually alongside
  a "/" and a set total (like "094/165") or next to a set code. If the only number
  on the card is a "No." Pokedex reference, or you cannot find a distinct collector
  number, return null for number_local rather than reusing it.

Extract:
1. Card name exactly as printed, in the card's language
2. English card name (same value when already English)
3. Local collector number (never a "No." Pokedex reference), or null
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


def _normalized_scanner_name(name: object) -> str:
    value = str(name or "").strip()
    return re.sub(r"\s+", " ", strip_diacritics(value)).strip()


def _scanner_names_compatible(expected: object, candidate: object) -> bool:
    """Match complete printed names across accents, case, and whitespace."""
    expected_name = _normalized_scanner_name(expected)
    candidate_name = _normalized_scanner_name(candidate)
    return bool(expected_name and expected_name == candidate_name)


def _normalized_card_type(value: object) -> str:
    normalized = strip_diacritics(str(value or "")).strip()
    return normalized if normalized in {"pokemon", "trainer", "energy"} else ""


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

    # Trainer and Energy cards cannot use the Pokemon-only HP corroboration
    # path above. English translation fallback can add other-language
    # printings after one exact native result, so uniqueness is measured only
    # among exact native-language candidates. The model and catalogue must
    # still agree on the type. Pokemon cards keep their existing safeguards.
    card_type = _normalized_card_type(card_info.get("card_type"))
    native_language = normalize_tcgdex_language(card_info.get("language"))
    native_candidates = [
        candidate
        for candidate in ranked
        if native_language
        and normalize_tcgdex_language(candidate.get("_lang")) == native_language
        and _scanner_names_compatible(card_info.get("name"), candidate.get("name"))
    ]
    if (
        len(native_candidates) == 1
        and native_candidates[0] is top
        and card_type in {"trainer", "energy"}
        and _normalized_card_type(top.get("card_type")) == card_type
        and "language" in signals
    ):
        return True, "sole_candidate"
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


async def _api_search_fallback(
    search_language: str,
    search_name: str,
    expected_name: str,
    trace: ScanTrace | None,
) -> list[dict]:
    """Live TCGdex search for a compatible local miss or missing number.

    TCGdex name search is substring-based, so results must still match the
    complete expected printed name before they can enter metadata ranking.
    Either fallback case is genuinely ambiguous: the card may not exist, the
    local sync may not have reached its set yet, or a new set may reuse a name
    that already has older local printings. Live TCGdex answers those cases
    the same way a plain catalogue lookup did before local-first search.

    Best-effort and silent on failure: this runs only after the local search
    could not supply the requested printing for this pair, so a network error
    just means no fallback candidates, not a broken scan. Existing local rows
    and results from other pairs remain available.
    """
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"https://api.tcgdex.net/v2/{search_language}/cards",
                params={"name": search_name},
            )
        api_cards = response.json() if response.status_code == 200 else []
        if trace:
            trace.record_tcgdex(
                language=search_language,
                query=search_name,
                status=response.status_code,
                count=len(api_cards) if isinstance(api_cards, list) else None,
                source="api_fallback",
            )
        if not isinstance(api_cards, list):
            return []
        return [
            {
                # Composite id in the same "{tcg_id}_{lang}" shape the local
                # rows already carry (Card.id), so downstream code (dedup,
                # candidate_set_ids parsing) does not need to know which
                # source a candidate came from.
                "id": f"{card.get('id')}_{search_language}",
                "tcg_card_id": card.get("id"),
                "name": card.get("name"),
                "card_type": card.get("category") or card.get("supertype"),
                "number": card.get("localId"),
                "image": f"{card.get('image')}/low.webp" if card.get("image") else None,
                "image_hd": f"{card.get('image')}/high.webp" if card.get("image") else None,
                "rarity": card.get("rarity"),
            }
            for card in api_cards
            if card.get("id")
            and _scanner_names_compatible(expected_name, card.get("name"))
        ]
    except Exception as exc:
        if trace:
            trace.record_tcgdex(
                language=search_language,
                query=search_name,
                status=None,
                count=None,
                error=type(exc).__name__,
                source="api_fallback",
            )
        return []


ENGLISH_FALLBACK_MIN_CANDIDATES = 3
ENGLISH_FALLBACK_TOTAL_CANDIDATE_LIMIT = ENGLISH_FALLBACK_MIN_CANDIDATES * 2


async def _search_and_rank_candidates(
    db: Session,
    card_info: dict,
    trace: ScanTrace | None = None,
) -> tuple[list[dict], int]:
    card_name = re.sub(r"\s+", " ", str(card_info.get("name") or "").strip())
    card_name_en = (
        re.sub(r"\s+", " ", str(card_info.get("name_en") or card_name).strip())
        or card_name
    )
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

    target_number = normalize_scanner_card_number(card_info.get("number_local"))
    candidates = []
    candidate_keys = set()
    native_candidate_count = 0
    for search_language, search_name in search_pairs:
        if len(candidates) >= 15:
            break
        is_english_fallback = language != "en" and search_language == "en"
        if is_english_fallback:
            # name_en is an AI translation rather than text read directly
            # from the card. Use it only when native-language search is thin,
            # and cap the total review grid so noisy translated matches cannot
            # bury the native candidates already found.
            if native_candidate_count >= ENGLISH_FALLBACK_MIN_CANDIDATES:
                break
            if len(candidates) >= ENGLISH_FALLBACK_TOTAL_CANDIDATE_LIMIT:
                break
        expected_name = card_name if search_language == language else card_name_en
        try:
            name_filter = accent_insensitive_contains(db, Card.name, search_name)
            if name_filter is None:
                rows = []
            else:
                local_query = (
                    db.query(Card)
                    .filter(
                        Card.tcg_card_id.isnot(None),
                        # Existing upgraded databases may still contain NULL
                        # here. database.py already treats NULL and false as
                        # catalogue rows, while true is always a user-created
                        # card and must not become a scanner candidate.
                        Card.is_custom.isnot(True),
                        Card.lang == search_language,
                        name_filter,
                    )
                )
                rows = []
                matching_rows = []
                projected_rows = local_query.with_entities(
                    Card.id,
                    Card.tcg_card_id,
                    Card.name,
                    Card.supertype,
                    Card.number,
                    Card.images_small,
                    Card.images_large,
                    Card.rarity,
                ).order_by(Card.id)
                for row in projected_rows.yield_per(200):
                    if not _scanner_names_compatible(expected_name, row.name):
                        continue
                    if len(rows) < SEARCH_CANDIDATE_QUERY_LIMIT:
                        rows.append(row)
                    if (
                        target_number
                        and normalize_scanner_card_number(row.number) == target_number
                        and len(matching_rows) < 12
                    ):
                        matching_rows.append(row)

                    # Once both bounded windows are full, later rows cannot
                    # change the selected local candidates.
                    if (
                        len(rows) >= SEARCH_CANDIDATE_QUERY_LIMIT
                        and (not target_number or len(matching_rows) >= 12)
                    ):
                        break

                present_ids = {row.id for row in rows}
                rows.extend(
                    row
                    for row in matching_rows
                    if row.id not in present_ids
                )
                rows = rows[:SEARCH_CANDIDATE_QUERY_LIMIT + 4]
        except Exception as exc:
            if trace:
                trace.record_tcgdex(
                    language=search_language,
                    query=search_name,
                    status=None,
                    count=None,
                    error=type(exc).__name__,
                )
            raise

        cards = [
            {
                "id": row.id,
                "tcg_card_id": row.tcg_card_id,
                "name": row.name,
                "card_type": row.supertype,
                "number": row.number,
                "image": row.images_small,
                "image_hd": row.images_large,
                "rarity": row.rarity,
            }
            for row in rows
        ]
        if trace:
            trace.record_tcgdex(
                language=search_language,
                query=search_name,
                status=200,
                count=len(cards),
            )

        # A reused name can already have many local printings while the
        # newly released printing is not synced yet. With a recognized
        # collector number, the local result is therefore sufficient only
        # when at least one name-compatible row actually has that number.
        # The live result is appended so the bounded selector retains the
        # local baseline and promotes matching new printings from fallback.
        local_has_number_match = bool(target_number and any(
            normalize_scanner_card_number(card.get("number")) == target_number
            for card in cards
        ))
        if not cards or (target_number and not local_has_number_match):
            fallback_cards = await _api_search_fallback(
                search_language, search_name, expected_name, trace
            )
            cards.extend(fallback_cards)

        selected_cards = select_search_candidates(
            cards,
            card_info.get("number_local"),
            number_field="number",
        )
        if is_english_fallback:
            # The fallback has a tighter total cap than native search. Put an
            # exact collector-number hit first so the cap cannot discard it
            # behind the baseline name matches selected above.
            selected_cards, _ = prioritize_cards_by_number(
                selected_cards,
                card_info.get("number_local"),
                number_field="number",
            )
        for card in selected_cards:
            if (
                is_english_fallback
                and len(candidates) >= ENGLISH_FALLBACK_TOTAL_CANDIDATE_LIMIT
            ):
                break
            card_id = card.get("id")
            if not card_id:
                continue
            candidate_key = (card_id, search_language)
            if candidate_key in candidate_keys:
                continue
            candidate_keys.add(candidate_key)
            candidates.append({
                "id": card_id,
                "tcg_card_id": card.get("tcg_card_id"),
                "name": card.get("name"),
                "card_type": card.get("card_type"),
                "set": None,
                "number": card.get("number"),
                "image": card.get("image"),
                "image_hd": card.get("image_hd"),
                "rarity": card.get("rarity"),
                "lang": search_language,
                "_lang": search_language,
                "_number_extra": bool(card.get("_number_extra")),
            })
            if not is_english_fallback:
                native_candidate_count += 1

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
    _apply_printed_total_mismatch(card_info, deduped)
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
    provider: ScanProvider | None = None,
    request_timeout_seconds: int = DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS,
    prewarm_candidates: bool = False,
) -> dict:
    """Shared deterministic matcher for both individual and composite scans.

    provider defaults to Gemini so existing callers, including the tests, behave
    exactly as before.
    """
    provider = provider or ScanProvider(GEMINI)
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
        # A credential is required only where the provider requires one. A local
        # endpoint has no key by design, so testing the key here would silently
        # disable this for exactly the setups the toggle exists for.
        and (bool(api_key) or not provider.requires_credential())
        and bool(image_b64)
        and bool(mime_type)
    )
    if should_try_phash or should_try_visual:
        try:
            # Reference-image hosts keep their short download timeout. A user
            # choosing a slower AI response budget must not make external image
            # downloads hang for the same duration.
            async with httpx.AsyncClient(timeout=20) as download_client:
                candidate_images = await _download_candidate_images(
                    download_client,
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
                        download_client,
                        top_candidates,
                        candidate_images,
                    )
                    parts = [
                        {"text": "Here is the original card photo:"},
                        image_part(mime_type, image_b64),
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
                            parts.append(image_part_from_bytes("image/webp", candidate_bytes))
                        else:
                            parts.append({"text": " (image unavailable)"})

                    async with httpx.AsyncClient(
                        timeout=request_timeout_seconds
                    ) as vision_client:
                        response_text, _visual_usage = await provider.generate_text(
                            vision_client,
                            api_key,
                            parts,
                            max_attempts=2,
                        )
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
                            # Unchanged for Gemini: this value is persisted in
                            # diagnostics and asserted by the existing tests.
                            decision = (
                                "gemini_visual" if provider.is_gemini
                                else f"{provider.name}_visual"
                            )
        except Exception as exc:
            logger.warning("Visual matching failed (non-blocking): %s", exc)

    public_matches = [
        {key: value for key, value in card.items() if key != "_number_extra"}
        for card in retain_ranked_candidates(candidates)
    ]

    # Warm the review's first clicks while the reviewer is still working
    # through the rest of the batch. Fired rather than awaited, and against
    # its own database session (see prewarm_candidate_images), so a slow or
    # failing CDN fetch here can never add latency to recognition itself.
    if public_matches and prewarm_candidates:
        try:
            task = asyncio.create_task(prewarm_candidate_images(public_matches))
            _candidate_prewarm_tasks.add(task)
            task.add_done_callback(_candidate_prewarm_tasks.discard)
        except RuntimeError:
            # No running event loop (e.g. certain sync test harnesses) — a
            # cold cache on first review is the only consequence.
            pass

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
    prewarm_candidates: bool = False,
) -> dict:
    """Recognize one already-sanitized image for direct and queued scans."""
    provider = get_provider(db, user_id)
    request_timeout_seconds = resolve_scanner_request_timeout(
        db, user_id, provider.name
    )
    capability_mode = require_scanner_capability_mode(
        db, user_id, provider.name, provider.model()
    )
    api_key = provider.credential(db, user_id)
    if trace:
        trace.add_secret(api_key)
    if provider.requires_credential() and not api_key:
        if trace:
            trace.record_error(f"No {provider.name} API key is configured.")
        raise HTTPException(
            status_code=400,
            detail=provider.missing_credential_message(),
        )

    image_b64 = base64.b64encode(image_bytes).decode()
    try:
        async with httpx.AsyncClient(timeout=request_timeout_seconds) as client:
            response_text, usage = await provider.generate_text(
                client,
                api_key,
                [text_part(RECOGNIZE_PROMPT), image_part(content_type, image_b64)],
            )
        response_text = response_text.strip()
        if trace:
            trace.record_extraction(
                prompt=RECOGNIZE_PROMPT,
                raw_response=response_text,
                usage=usage,
            )
        json_match = re.search(r"\{.*\}", response_text, re.DOTALL)
        if not json_match:
            raise ValueError("No JSON found in the scanner response")
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
            allow_visual_verification=(
                capability_mode != SCANNER_CAPABILITY_DEGRADED
            ),
            photo_bytes=image_bytes,
            trace=trace,
            provider=provider,
            request_timeout_seconds=request_timeout_seconds,
            prewarm_candidates=prewarm_candidates,
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

    provider = get_provider(db, current_user.id)
    trace = create_scan_trace(
        db,
        current_user.id,
        mode="single",
        filename="sanitized-upload.jpg",
        # Stamped with whichever provider will actually run, so diagnostics do not
        # attribute an OpenAI scan to the Gemini model.
        provider=provider.name,
        model=provider.model(),
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
- number_local: printed local collector number, or null (never a "No." Pokedex
  reference near the artwork or flavor text — that is the species' National Pokedex
  number, not this card's collector number)
- number_total: printed set total/denominator, or null
- set_code: printed alphanumeric set code near the number, or null
- regulation_mark: boxed regulation letter, or null
- card_type: Pokemon, Trainer, or Energy
- hp: HP value or null
- language: two-letter ISO language code
- artist: printed illustrator credit, or null

Only report small identity text when every character is visible. Never infer set_code from
the artwork or from recognizing the set. If a detail is unclear, or the only number visible
is a "No." Pokedex reference rather than a distinct collector number, use null rather than
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
    provider: ScanProvider | None = None,
    request_timeout_seconds: int = DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS,
) -> dict[int, dict]:
    """Return recognized card information keyed by zero-based composite position."""
    provider = provider or ScanProvider(GEMINI)
    image_b64 = base64.b64encode(image_bytes).decode()
    try:
        async with httpx.AsyncClient(timeout=request_timeout_seconds) as client:
            response_text, usage = await provider.generate_text(
                client,
                api_key,
                [
                    text_part(COMPOSITE_PROMPT.format(count=count)),
                    image_part("image/jpeg", image_b64),
                ],
            )
        response_text = response_text.strip()
        for trace in traces or []:
            trace.record_extraction(
                prompt=COMPOSITE_PROMPT.format(count=count),
                raw_response=response_text,
                usage=usage,
            )
        array_match = re.search(r"\[.*\]", response_text, re.DOTALL)
        if not array_match:
            raise CompositeRecognitionError("The scanner returned no card list for the composite.")
        rows = json.loads(array_match.group())
        if not isinstance(rows, list):
            raise CompositeRecognitionError("The scanner returned an invalid composite card list.")
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
    prewarm_candidates: bool = False,
) -> dict:
    """Use local pHash before an uncertain composite falls back individually."""
    return await match_card_info(
        db,
        card_info,
        allow_visual_verification=False,
        photo_bytes=photo_bytes,
        trace=trace,
        prewarm_candidates=prewarm_candidates,
    )
