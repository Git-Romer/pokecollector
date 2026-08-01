import base64
import asyncio
import httpx
import os
import json
import re
from typing import List, Optional
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language
from services.card_composite import build_composite, chunk_for_composite, GRID_SIZE as BATCH_GRID_SIZE
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
            resp = await client.post(
                gemini_url,
                headers={"x-goog-api-key": api_key},
                json=payload,
            )

            if resp.status_code == 429:
                raise HTTPException(
                    status_code=429,
                    detail="Gemini Rate Limit erreicht – bitte kurz warten und nochmal versuchen.",
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
            return resp
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


# ─── Prompts ─────────────────────────────────────────────────────────────────
# Both extract the same core identity fields, but set_code carries an explicit
# anti-hallucination rule: real-card testing found Gemini would sometimes report
# a set_code it recognized from training data (e.g. "BRS" for a Brilliant Stars
# card) even when no code is actually printed on the card. The rule below was
# confirmed to eliminate that at single-card and 4-card-grid scale.

RECOGNIZE_PROMPT = """Look at this Pokemon Trading Card Game card image. Extract the following.

IMPORTANT ACCURACY RULES:
- Only report what is ACTUALLY VISIBLE as printed text/symbols in THIS image.
- For number_local, number_total, set_code, and regulation_mark specifically: these are
  small printed characters near the bottom of the card. Read them character by character.
  If you are not fully confident in every character, return null for that field rather
  than guessing — a null is far better than a wrong value.
- For set_code in particular: only report a value if you can see actual printed
  alphanumeric characters near the card number that form a code. Do NOT fill this in
  because you recognize the Pokemon, the artwork, or the set by name — recognizing the
  card is not the same as reading a printed code, and guessing from memory is not allowed
  here even if you are confident which set it is.
- set_name is different: you MAY infer this from visual style, symbol, or copyright era
  even with no explicit set code printed, since that is a legitimate visual inference —
  just don't invent a set_code to go with it if none is printed.

Extract:
1. Card name, exactly as printed, in the card's own language
2. Card name in English (same as above if already English)
3. Local card number as printed at the bottom, or null
4. Total/denominator as printed at the bottom, or null
5. Set code/abbreviation, per the accuracy rules above, or null
6. Set name if you can infer it (from a symbol, copyright era, or other visual cue), or null
7. Regulation mark: the single boxed letter near the number on Sword/Shield-era-onward cards, or null
8. Card type: "Pokemon", "Trainer", or "Energy"
9. HP value if it's a Pokemon card, or null
10. Language as a 2-letter ISO code
11. Artist name as printed, or null
12. Rarity symbol shape: "circle", "diamond", "star", "other", or null
13. Is this card a promo card? true/false
14. Does the card art window show holographic foil? true/false
15. Does the card background/border show a reverse-holo foil pattern? true/false
16. Is there a "1st Edition" stamp visible? true/false

Respond ONLY with this exact JSON (no markdown, no explanation):
{
  "name": "...",
  "name_en": "...",
  "number_local": "... or null",
  "number_total": "... or null",
  "set_code": "... or null",
  "set_name": "... or null",
  "regulation_mark": "... or null",
  "card_type": "Pokemon/Trainer/Energy",
  "hp": "... or null",
  "language": "en",
  "artist": "... or null",
  "rarity_symbol": "circle/diamond/star/other/null",
  "is_promo": false,
  "holo_foil_visible": false,
  "reverse_holo_pattern_visible": false,
  "first_edition_stamp_visible": false
}"""

BATCH_PROMPT_TEMPLATE = """This image is a grid of {n} separate Pokemon Trading Card Game cards, laid
out left-to-right then top-to-bottom (reading order), each with a small white index number
burned into its top-left corner ("1" through "{n}"). Identify EVERY card in the grid.

For each card, report which index number is printed in its corner (read the burned-in
digit, do not assume order), plus the fields below.

IMPORTANT ACCURACY RULES:
- number_local, number_total, set_code, and regulation_mark are small printed characters
  near the bottom of each card. In a grid this dense, they are easy to misread. Read each
  one character by character. If you are not fully confident in every character, return
  null for that field rather than guessing — a null is far better than a wrong value.
- For set_code specifically: only report it if you can see actual printed alphanumeric
  characters forming a code near that card's number. Do NOT fill it in because you
  recognize the Pokemon or the set by name — recognizing a card is not the same as
  reading a printed code on it, and guessing from memory is not allowed even if you are
  confident which set it is. Return null instead.

For each card:
1. index (the burned-in corner number you actually read, as an integer)
2. name (card's own language)
3. name_en
4. number_local (or null)
5. number_total (or null)
6. set_code (or null, per the accuracy rules above)
7. regulation_mark (or null)
8. card_type
9. language (2-letter ISO code)

Respond ONLY with this exact JSON (no markdown, no explanation) — an array with one object
per card you found, in any order, each carrying its own "index":
[
  {{"index": 1, "name": "...", "name_en": "...", "number_local": "... or null", "number_total": "... or null", "set_code": "... or null", "regulation_mark": "... or null", "card_type": "...", "language": "en"}},
  ...
]"""


# ─── Small pure helpers (unit tested directly, no network/DB needed) ────────

def _normalize_number(value) -> Optional[str]:
    """Strip a printed number down to a bare int string for comparison.

    '063' / '63' / 63 / '63/88' (takes the first run of digits) all -> '63'.
    Returns None when no digits are present.
    """
    if value is None:
        return None
    match = re.search(r"\d+", str(value))
    if not match:
        return None
    return str(int(match.group()))


def _numbers_match(a, b) -> bool:
    na, nb = _normalize_number(a), _normalize_number(b)
    return na is not None and na == nb


def _printed_total_mismatch(recognized_total, candidate_printed_total) -> bool:
    """True only when both sides are known and disagree — never flags on missing data."""
    normalized = _normalize_number(recognized_total)
    if normalized is None or not candidate_printed_total:
        return False
    return normalized != str(int(candidate_printed_total))


def _extract_json(text: str, *, array: bool = False):
    """Parse the JSON object/array Gemini returned, tolerating stray markdown fences."""
    pattern = r"\[.*\]" if array else r"\{.*\}"
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        raise ValueError("No JSON found in Gemini response")
    return json.loads(match.group())


_SUFFIXES = re.compile(
    r"[\s-]+(?:EX|ex|GX|gx|V|VMAX|VSTAR|VStar|TAG\s*TEAM|BREAK|LV\.?\s*X)\s*$",
    re.IGNORECASE,
)


def _simplify_name(name: str) -> str:
    # Strip card suffixes for broader TCGdex search — exact variants differ between
    # printed text ("EX") and TCGdex naming ("ex", "-ex"). The number ranking and
    # visual verification will find the exact match from the broader result set.
    return _SUFFIXES.sub("", name).strip()


async def _recognize_single_image(client, gemini_url, api_key, image_b64, mime_type) -> dict:
    """One Gemini call, one photo, the full RECOGNIZE_PROMPT field set."""
    resp = await post_gemini_generate(client, gemini_url, api_key, {
        "contents": [{
            "parts": [
                {"text": RECOGNIZE_PROMPT},
                {"inline_data": {"mime_type": mime_type, "data": image_b64}},
            ]
        }]
    })
    result = resp.json()
    text = result["candidates"][0]["content"]["parts"][0]["text"].strip()
    return _extract_json(text)


async def _match_card_info(db: Session, api_key: str, gemini_url: str, card_info: dict, image_b64: str, mime_type: str) -> dict:
    """Search TCGdex/local DB for candidates matching an already-extracted card_info,
    rank them, and optionally run visual verification. Shared by the single-photo and
    batched (composite) recognize paths — the only difference between them is how
    card_info was produced (one Gemini call per photo, vs one call per composite grid).
    """
    card_name = (card_info.get("name") or "").strip()
    card_name_en = (card_info.get("name_en") or card_name).strip() or card_name
    if not card_name:
        raise HTTPException(status_code=422, detail="Kartenname konnte nicht erkannt werden.")

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
                    for c in tcgdex_cards[:8]:
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

    # Enrich results with set name/abbreviation/printed_total from local DB, and flag
    # candidates whose printed_total disagrees with the recognized number_total — a
    # near-unique identifier per real-card testing, and a strong "wrong match" signal.
    recognized_number_total = card_info.get("number_total")
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
                if local_set.printed_total:
                    card["printed_total_mismatch"] = _printed_total_mismatch(
                        recognized_number_total, local_set.printed_total
                    )

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

    # Rank results: cards with a matching local number first, and among those, a
    # matching set_code as a tie-break (real-card data has cases like printed_total=198
    # matching two different sets, where number alone can't disambiguate but set_code can).
    recognized_number_local = card_info.get("number_local")
    recognized_set_code = (card_info.get("set_code") or "").strip().upper() or None
    target_num = _normalize_number(recognized_number_local)
    number_match_clear = False

    if target_num is not None:
        def rank_key(card):
            number_ok = 0 if _numbers_match(card.get("number"), target_num) else 1
            set_ok = 1
            if recognized_set_code:
                card_abbr = (card.get("set_abbreviation") or "").upper()
                set_ok = 0 if card_abbr == recognized_set_code else 1
            return (number_ok, set_ok)

        deduped.sort(key=rank_key)
        number_matches = [card for card in deduped if rank_key(card)[0] == 0]
        if len(number_matches) == 1:
            number_match_clear = True
        elif len(number_matches) > 1 and recognized_set_code:
            set_matches = [card for card in number_matches if rank_key(card)[1] == 0]
            number_match_clear = len(set_matches) == 1
        logger.info(f"Ranked results by number match (target: {target_num})")

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

    image_bytes = await file.read()
    image_b64 = base64.b64encode(image_bytes).decode()
    mime_type = file.content_type or "image/jpeg"
    gemini_url = build_gemini_generate_url()

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            card_info = await _recognize_single_image(client, gemini_url, api_key, image_b64, mime_type)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erkennung fehlgeschlagen: {str(e)}")

    return await _match_card_info(db, api_key, gemini_url, card_info, image_b64, mime_type)


async def _recognize_composite_chunk(db: Session, api_key: str, gemini_url: str, chunk: list[dict]) -> list[dict]:
    """chunk: list of {filename, bytes, mime_type}, at most BATCH_GRID_SIZE items.
    Returns one result dict per input item, in the same order, each either
    {"filename", "recognized", "matches"} or {"filename", "error"}.
    """
    try:
        composite_bytes = build_composite([item["bytes"] for item in chunk])
        composite_b64 = base64.b64encode(composite_bytes).decode()
        prompt = BATCH_PROMPT_TEMPLATE.format(n=len(chunk))

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await post_gemini_generate(client, gemini_url, api_key, {
                "contents": [{
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": "image/jpeg", "data": composite_b64}},
                    ]
                }]
            })
        result = resp.json()
        text = result["candidates"][0]["content"]["parts"][0]["text"].strip()
        parsed = _extract_json(text, array=True)
    except HTTPException as e:
        return [{"filename": item["filename"], "error": e.detail} for item in chunk]
    except Exception as e:
        return [{"filename": item["filename"], "error": f"Stapel-Erkennung fehlgeschlagen: {e}"} for item in chunk]

    by_index = {entry.get("index"): entry for entry in parsed if isinstance(entry, dict)}

    out = []
    for i, item in enumerate(chunk, start=1):
        card_info = by_index.get(i)
        if not card_info:
            out.append({"filename": item["filename"], "error": "Karte im Stapel nicht erkannt (Index fehlt)."})
            continue
        image_b64 = base64.b64encode(item["bytes"]).decode()
        try:
            match_result = await _match_card_info(db, api_key, gemini_url, card_info, image_b64, item["mime_type"])
            out.append({"filename": item["filename"], **match_result})
        except HTTPException as e:
            out.append({"filename": item["filename"], "error": e.detail})
        except Exception as e:
            out.append({"filename": item["filename"], "error": f"Erkennung fehlgeschlagen: {e}"})

    return out


@router.post("/recognize/batch")
async def recognize_cards_batch(
    files: List[UploadFile] = File(default=[]),
    singles: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Recognize many single-card photos in one request.

    `files` are grouped into composite grids of up to BATCH_GRID_SIZE cards per
    Gemini call — cheaper and faster (confirmed ~4x fewer image tokens and API
    calls per card at this grid size), at a small accuracy cost on hard cards.
    `singles` bypass batching entirely and go through the same one-photo-per-call
    path as /recognize — the manual override for cards (vintage, non-Latin
    script, etc.) where batching has shown lower accuracy on real cards.
    """
    if not files and not singles:
        raise HTTPException(status_code=400, detail="Keine Bilder hochgeladen.")

    api_key = get_gemini_key(db, user_id=current_user.id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        )

    gemini_url = build_gemini_generate_url()
    single_results = []
    batched_results = []

    for f in singles:
        image_bytes = await f.read()
        image_b64 = base64.b64encode(image_bytes).decode()
        mime_type = f.content_type or "image/jpeg"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                card_info = await _recognize_single_image(client, gemini_url, api_key, image_b64, mime_type)
            match_result = await _match_card_info(db, api_key, gemini_url, card_info, image_b64, mime_type)
            single_results.append({"filename": f.filename, **match_result})
        except HTTPException as e:
            single_results.append({"filename": f.filename, "error": e.detail})
        except Exception as e:
            single_results.append({"filename": f.filename, "error": f"Erkennung fehlgeschlagen: {e}"})

    file_payloads = []
    for f in files:
        image_bytes = await f.read()
        file_payloads.append({
            "filename": f.filename,
            "bytes": image_bytes,
            "mime_type": f.content_type or "image/jpeg",
        })

    for chunk in chunk_for_composite(file_payloads, size=BATCH_GRID_SIZE):
        batched_results.extend(await _recognize_composite_chunk(db, api_key, gemini_url, chunk))

    return {"batched": batched_results, "singles": single_results}
