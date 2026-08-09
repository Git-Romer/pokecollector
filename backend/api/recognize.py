import base64
import asyncio
import datetime
import httpx
import math
import os
import json
import re
from email.utils import parsedate_to_datetime
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language
from services.gemini_rate_limit import (
    GeminiKeyBlockedError,
    acquire_gemini_slot,
    penalize_gemini_key,
    record_gemini_success,
)
from services.scan_storage import MAX_FILE_BYTES, ScanUploadError, read_limited_upload, sanitize_image_bytes
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session
from api.auth import get_current_user
from database import get_db
from models import Setting, UserSetting, User, Set

logger = logging.getLogger(__name__)

router = APIRouter()

GEMINI_TRANSIENT_STATUS_CODES = {502, 503, 504}
DEFAULT_GEMINI_MODEL = "gemini-flash-latest"
GEMINI_MODELS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_GEMINI_RETRY_SECONDS = 14 * 24 * 60 * 60


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


def normalize_scanner_card_number(value) -> str | None:
    """Return the leading collector number without zeros, if one is present."""
    if value is None:
        return None
    match = re.match(r"(\d+)", str(value).strip())
    return str(int(match.group(1))) if match else None


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


@router.post("/recognize")
async def recognize_card(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Accepts a card image, uses Gemini Vision to extract card details
    including the card's language, then searches TCGdex in that language.
    Supports configured TCGdex card languages automatically.
    """
    api_key = get_gemini_key(db, user_id=current_user.id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        )

    # Decode and normalize every scanner upload before sending it upstream.
    # This applies the same format, size, pixel, orientation, and metadata rules
    # as the persistent background queue.
    try:
        raw_image = await read_limited_upload(file, remaining_job_bytes=MAX_FILE_BYTES)
        sanitized_image = sanitize_image_bytes(raw_image)
    except ScanUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    image_bytes = sanitized_image.data
    image_b64 = base64.b64encode(image_bytes).decode()
    mime_type = sanitized_image.content_type

    # Call Gemini Vision — ask for language detection too
    gemini_url = build_gemini_generate_url()

    prompt = """Look at this Pokemon Trading Card Game card image. Extract the following:
1. Card name (exactly as printed on the card, in the card's language)
2. Card name in English (if the card is not English, give the English name; if already English, same as above)
3. Card number (e.g. "136/182" — printed at the bottom)
4. Set name or abbreviation if visible
5. Card type (Pokemon, Trainer, or Energy)
6. HP value if it's a Pokemon card
7. Language of the card (2-letter ISO code: "en" for English, "de" for German, "fr" for French, "es" for Spanish, "it" for Italian, "pt" for Portuguese, "ja" for Japanese, etc.)

Respond ONLY with this exact JSON (no markdown, no explanation):
{
  "name": "card name in card's language",
  "name_en": "card name in English (same as name if card is English)",
  "number": "card number or null",
  "set_hint": "set name or abbreviation or null",
  "card_type": "Pokemon/Trainer/Energy",
  "hp": "HP value or null",
  "language": "en"
}"""

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await post_gemini_generate(client, gemini_url, api_key, {
                "contents": [{
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": mime_type, "data": image_b64}}
                    ]
                }]
            })

        result = resp.json()
        text = result["candidates"][0]["content"]["parts"][0]["text"].strip()

        # Parse JSON from Gemini response (handles markdown code blocks too)
        json_match = re.search(r'\{.*\}', text, re.DOTALL)
        if not json_match:
            raise ValueError("No JSON found in Gemini response")
        card_info = json.loads(json_match.group())

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erkennung fehlgeschlagen: {str(e)}")

    card_name = card_info.get("name", "").strip()
    card_name_en = card_info.get("name_en", card_name).strip() or card_name
    if not card_name:
        raise HTTPException(status_code=422, detail="Kartenname konnte nicht erkannt werden.")

    # Strip card suffixes for broader TCGdex search — exact variants differ between
    # printed text ("EX") and TCGdex naming ("ex", "-ex"). The number ranking and
    # visual verification will find the exact match from the broader result set.
    _SUFFIXES = re.compile(
        r"[\s-]+(?:EX|ex|GX|gx|V|VMAX|VSTAR|VStar|TAG\s*TEAM|BREAK|LV\.?\s*X)\s*$",
        re.IGNORECASE,
    )

    def _simplify_name(name: str) -> str:
        return _SUFFIXES.sub("", name).strip()

    card_name_simple = _simplify_name(card_name)
    card_name_en_simple = _simplify_name(card_name_en)

    # Use detected language for TCGdex search.
    detected_lang = normalize_tcgdex_language(card_info.get("language", "en"))
    if not is_supported_tcgdex_language(detected_lang):
        detected_lang = "en"

    # Build (lang, search_name) pairs — try simplified name first (broader), then original as fallback
    search_pairs = [(detected_lang, card_name_simple)]
    if card_name_simple != card_name:
        search_pairs.append((detected_lang, card_name))
    if detected_lang != "en":
        search_pairs.append(("en", card_name_en_simple))
        if card_name_en_simple != card_name_en:
            search_pairs.append(("en", card_name_en))

    # TCGdex returns search results sorted ascending by card number, so a plain
    # head slice keeps only the lowest-numbered printings and discards the
    # target card for anything numbered above them. Float printings that match
    # the recognized number to the front so they survive the per-search cap.
    recognized_number = card_info.get("number")

    # Collect all raw results first, setting _lang on each card
    all_results = []
    for lang, search_name in search_pairs:
        if len(all_results) >= 15:
            break
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                search_resp = await client.get(
                    f"https://api.tcgdex.net/v2/{lang}/cards",
                    params={"name": search_name}
                )
            if search_resp.status_code == 200:
                tcgdex_cards = search_resp.json()
                if isinstance(tcgdex_cards, list):
                    logger.info(f"TCGdex {lang} search for '{search_name}': {len(tcgdex_cards)} results")
                    prioritized_cards, match_count = prioritize_cards_by_number(
                        tcgdex_cards,
                        recognized_number,
                        number_field="localId",
                    )
                    if match_count:
                        logger.info(
                            "Number pre-filter: %s of %s results match #%s",
                            match_count,
                            len(tcgdex_cards),
                            normalize_scanner_card_number(recognized_number),
                        )
                    for c in prioritized_cards[:8]:
                        card_id = c.get("id")
                        if not card_id:
                            continue
                        composite_id = f"{card_id}_{lang}"
                        all_results.append({
                            "id": composite_id,
                            "tcg_card_id": card_id,
                            "name": c.get("name"),
                            "set": c.get("set", {}).get("name") if isinstance(c.get("set"), dict) else None,
                            "number": c.get("localId"),
                            "image": f"{c.get('image')}/low.webp" if c.get("image") else None,
                            "rarity": c.get("rarity"),
                            "lang": lang,
                            "_lang": lang,  # internal dedup key field
                        })
        except Exception:
            continue

    # Enrich results with set name from local DB
    for card in all_results:
        tcg_card_id = card.get("tcg_card_id", "")
        card_lang = card.get("_lang", "en")
        # Extract set_id from card_id: "me02.5-022" -> "me02.5"
        if "-" in tcg_card_id:
            set_id = tcg_card_id.rsplit("-", 1)[0]
            local_set = db.query(Set).filter(
                Set.tcg_set_id == set_id, Set.lang == card_lang
            ).first()
            if not local_set:
                # Fallback: try without language filter
                local_set = db.query(Set).filter(Set.tcg_set_id == set_id).first()
            if local_set:
                card["set"] = local_set.name
                if local_set.abbreviation:
                    card["set_abbreviation"] = local_set.abbreviation

    # Dedup by (card_id, _lang) composite key — same card in different languages counts once per lang
    seen = set()
    deduped = []
    for card in all_results:
        key = (card.get('id'), card.get('_lang', 'en'))
        if key not in seen:
            seen.add(key)
            deduped.append(card)

    logger.info(
        f"Recognize dedup: {len(all_results)} before -> {len(deduped)} after dedup by (card_id, _lang)"
    )

    # Rank results: cards with matching number first
    deduped, number_match_count = prioritize_cards_by_number(
        deduped,
        recognized_number,
    )
    number_match_clear = number_match_count == 1
    if number_match_count:
        logger.info(
            "Ranked results by number match (target: %s)",
            normalize_scanner_card_number(recognized_number),
        )

    # Visual verification: ask Gemini to pick the best match from candidate images.
    # Skip this second Gemini call when number ranking is decisive or there
    # are not enough candidate images to compare visually.
    top_candidates = [card for card in deduped[:5] if card.get("image")]  # max 5 to keep costs low
    if len(top_candidates) >= 2 and not number_match_clear:
        try:
            # Download candidate images
            candidate_parts = [
                {"text": "Here is the original card photo the user took:"},
                {"inline_data": {"mime_type": mime_type, "data": image_b64}},
                {
                    "text": (
                        "Below are candidate cards from our database. Which one matches the photo "
                        "above? Look at the artwork, card name, and card number. Respond with ONLY "
                        "the number (1, 2, 3...) of the best match, or 0 if none match.\n"
                    )
                },
            ]

            async with httpx.AsyncClient(timeout=20) as client:
                for i, candidate in enumerate(top_candidates):
                    img_url = candidate.get("image")
                    if not img_url:
                        candidate_parts.append({
                            "text": f"\nCandidate {i + 1}: {candidate.get('name', '?')} (no image available)"
                        })
                        continue
                    try:
                        img_resp = await client.get(img_url, timeout=5)
                        if img_resp.status_code == 200:
                            img_b64 = base64.b64encode(img_resp.content).decode()
                            candidate_parts.append({
                                "text": (
                                    f"\nCandidate {i + 1}: {candidate.get('name', '?')} "
                                    f"#{candidate.get('number', '?')}"
                                )
                            })
                            candidate_parts.append({
                                "inline_data": {"mime_type": "image/webp", "data": img_b64}
                            })
                        else:
                            candidate_parts.append({
                                "text": (
                                    f"\nCandidate {i + 1}: {candidate.get('name', '?')} "
                                    "(image unavailable)"
                                )
                            })
                    except Exception:
                        candidate_parts.append({
                            "text": (
                                f"\nCandidate {i + 1}: {candidate.get('name', '?')} "
                                "(image fetch failed)"
                            )
                        })

                verify_resp = await post_gemini_generate(client, gemini_url, api_key, {
                    "contents": [{"parts": candidate_parts}]
                }, max_attempts=2)

            if verify_resp.status_code == 200:
                verify_result = verify_resp.json()
                verify_text = verify_result["candidates"][0]["content"]["parts"][0]["text"].strip()
                # Extract the number from response
                pick_match = re.search(r"(\d+)", verify_text)
                if pick_match:
                    pick = int(pick_match.group(1))
                    if 1 <= pick <= len(top_candidates):
                        # Move the picked candidate to the front
                        winner = top_candidates[pick - 1]
                        deduped.remove(winner)
                        deduped.insert(0, winner)
                        logger.info(
                            f"Visual verification picked candidate {pick}: "
                            f"{winner.get('name')} #{winner.get('number')}"
                        )
                    elif pick == 0:
                        logger.info("Visual verification: no match found among candidates")
        except Exception as e:
            logger.warning(f"Visual verification failed (non-blocking): {e}")

    return {
        "recognized": card_info,
        "matches": deduped[:8],
    }


COMPOSITE_PROMPT = """This image contains {count} separate Pokemon Trading Card Game cards.
They are arranged left-to-right, then top-to-bottom, and each card has a white index number
on a black square directly above it. Identify every card. Read that index label instead of
relying on response order.

For each card return the same information as an individual scan:
- index: the printed corner number
- name: exact card name in the card's language
- name_en: English card name
- number: printed collector number, including the total when visible
- set_hint: visible set name or abbreviation, or null
- card_type: Pokemon, Trainer, or Energy
- hp: HP value or null
- language: two-letter ISO language code

If a small printed detail is unclear, use null rather than guessing. Respond ONLY with a
JSON array containing one object per card, without markdown or explanation.
"""


class CompositeRecognitionError(ValueError):
    """The composite response could not be mapped safely to its source photos."""


async def recognize_composite_card_info(
    api_key: str,
    image_bytes: bytes,
    count: int,
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
            mapped[position] = row
    return mapped


async def match_composite_card_info(db: Session, card_info: dict) -> dict:
    """Find the normal ordered candidate list for one composite-recognized card.

    This deliberately uses only the currently approved name, language, and collector
    number ranking. Expanded prompt fields and ranking remain outside this checkpoint.
    """
    card_name = str(card_info.get("name") or "").strip()
    card_name_en = str(card_info.get("name_en") or card_name).strip() or card_name
    if not card_name:
        return {"recognized": card_info, "matches": []}

    suffixes = re.compile(
        r"[\s-]+(?:EX|ex|GX|gx|V|VMAX|VSTAR|VStar|TAG\s*TEAM|BREAK|LV\.?\s*X)\s*$",
        re.IGNORECASE,
    )
    simple_name = suffixes.sub("", card_name).strip()
    simple_name_en = suffixes.sub("", card_name_en).strip()
    detected_language = normalize_tcgdex_language(card_info.get("language", "en"))
    if not is_supported_tcgdex_language(detected_language):
        detected_language = "en"

    search_pairs = [(detected_language, simple_name)]
    if simple_name != card_name:
        search_pairs.append((detected_language, card_name))
    if detected_language != "en":
        search_pairs.append(("en", simple_name_en))
        if simple_name_en != card_name_en:
            search_pairs.append(("en", card_name_en))

    recognized_number = card_info.get("number")
    candidates: list[dict] = []
    for language, search_name in search_pairs:
        if len(candidates) >= 15:
            break
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.get(
                    f"https://api.tcgdex.net/v2/{language}/cards",
                    params={"name": search_name},
                )
            if response.status_code != 200 or not isinstance(response.json(), list):
                continue
            cards, _match_count = prioritize_cards_by_number(
                response.json(),
                recognized_number,
                number_field="localId",
            )
            for card in cards[:8]:
                card_id = card.get("id")
                if not card_id:
                    continue
                candidates.append({
                    "id": f"{card_id}_{language}",
                    "tcg_card_id": card_id,
                    "name": card.get("name"),
                    "set": card.get("set", {}).get("name")
                    if isinstance(card.get("set"), dict) else None,
                    "number": card.get("localId"),
                    "image": f"{card.get('image')}/low.webp" if card.get("image") else None,
                    "rarity": card.get("rarity"),
                    "lang": language,
                    "_lang": language,
                })
        except Exception:
            continue

    for candidate in candidates:
        tcg_card_id = candidate.get("tcg_card_id", "")
        if "-" not in tcg_card_id:
            continue
        set_id = tcg_card_id.rsplit("-", 1)[0]
        local_set = db.query(Set).filter(
            Set.tcg_set_id == set_id,
            Set.lang == candidate.get("_lang", "en"),
        ).first() or db.query(Set).filter(Set.tcg_set_id == set_id).first()
        if local_set:
            candidate["set"] = local_set.name
            if local_set.abbreviation:
                candidate["set_abbreviation"] = local_set.abbreviation

    seen = set()
    deduped = []
    for candidate in candidates:
        key = (candidate.get("id"), candidate.get("_lang", "en"))
        if key not in seen:
            seen.add(key)
            deduped.append(candidate)
    deduped, number_match_count = prioritize_cards_by_number(deduped, recognized_number)
    return {
        "recognized": card_info,
        "matches": deduped[:8],
        "_number_match_count": number_match_count,
    }
