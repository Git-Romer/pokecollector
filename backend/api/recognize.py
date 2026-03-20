import base64
import httpx
import os
import json
import re
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session
from api.auth import get_current_user
from database import get_db
from models import Setting, User

logger = logging.getLogger(__name__)

router = APIRouter()


def get_gemini_key(db: Session) -> str:
    """Read Gemini API key from DB settings, fallback to env var."""
    row = db.query(Setting).filter(Setting.key == "gemini_api_key").first()
    if row and row.value:
        return row.value
    return os.environ.get("GEMINI_API_KEY", "")


@router.post("/recognize")
async def recognize_card(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Accepts a card image, uses Gemini Vision to extract card details
    including the card's language, then searches TCGdex in that language.
    Supports both German and English (and other) cards automatically.
    """
    api_key = get_gemini_key(db)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        )

    # Read image
    image_bytes = await file.read()
    image_b64 = base64.b64encode(image_bytes).decode()
    mime_type = file.content_type or "image/jpeg"

    # Call Gemini Vision — ask for language detection too
    gemini_url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.5-flash:generateContent?key={api_key}"
    )

    prompt = """Look at this Pokemon Trading Card Game card image. Extract the following:
1. Card name (exactly as printed on the card, in the card's language)
2. Card name in English (if the card is German, give the English name; if already English, same as above)
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
            resp = await client.post(gemini_url, json={
                "contents": [{
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": mime_type, "data": image_b64}}
                    ]
                }]
            })

        if resp.status_code == 429:
            raise HTTPException(
                status_code=429,
                detail="Rate Limit erreicht – bitte 15 Minuten warten und nochmal versuchen."
            )
        if resp.status_code == 400:
            raise HTTPException(
                status_code=400,
                detail="Ungültiger Gemini API Key. Bitte in den Einstellungen prüfen."
            )
        resp.raise_for_status()

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

    # Use detected language for TCGdex search
    detected_lang = card_info.get("language", "en").lower().strip()
    # TCGdex supports: en, fr, es, it, pt, de, nl, pl, ru, ko, zh-hans, zh-hant, ja
    supported_langs = {"en", "de", "fr", "es", "it", "pt", "nl", "pl", "ru", "ko", "ja"}
    if detected_lang not in supported_langs:
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
    recognized_number = card_info.get("number")
    number_match_count = 0
    number_match_clear = False
    if recognized_number:
        # Normalize: "136/182" -> "136", "001" -> "1"
        num_match = re.match(r"(\d+)", str(recognized_number).strip())
        if num_match:
            target_num = str(int(num_match.group(1)))  # strip leading zeros

            def number_sort_key(card):
                card_num = card.get("number", "")
                if card_num:
                    cn_match = re.match(r"(\d+)", str(card_num).strip())
                    if cn_match and str(int(cn_match.group(1))) == target_num:
                        return 0  # exact match first
                return 1  # non-matches after

            deduped.sort(key=number_sort_key)
            number_match_count = sum(1 for card in deduped if number_sort_key(card) == 0)
            number_match_clear = (
                len(deduped) > 0 and number_sort_key(deduped[0]) == 0 and number_match_count == 1
            )
            logger.info(f"Ranked results by number match (target: {target_num})")

    # Visual verification: ask Gemini to pick the best match from candidate images
    top_candidates = deduped[:5]  # max 5 to keep costs low
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

                verify_resp = await client.post(gemini_url, json={
                    "contents": [{"parts": candidate_parts}]
                })

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
