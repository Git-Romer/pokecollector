import base64
import httpx
import os
import json
import re
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session
from database import get_db
from models import Setting

logger = logging.getLogger(__name__)

router = APIRouter()


def get_gemini_key(db: Session) -> str:
    """Read Gemini API key from DB settings, fallback to env var."""
    row = db.query(Setting).filter(Setting.key == "gemini_api_key").first()
    if row and row.value:
        return row.value
    return os.environ.get("GEMINI_API_KEY", "")


@router.post("/recognize")
async def recognize_card(file: UploadFile = File(...), db: Session = Depends(get_db)):
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

    # Use detected language for TCGdex search
    detected_lang = card_info.get("language", "en").lower().strip()
    # TCGdex supports: en, fr, es, it, pt, de, nl, pl, ru, ko, zh-hans, zh-hant, ja
    supported_langs = {"en", "de", "fr", "es", "it", "pt", "nl", "pl", "ru", "ko", "ja"}
    if detected_lang not in supported_langs:
        detected_lang = "en"

    # Build (lang, search_name) pairs — use native name for native lang, English name for English fallback
    search_pairs = [(detected_lang, card_name)]
    if detected_lang != "en":
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
                        all_results.append({
                            "id": card_id,
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

    return {
        "recognized": card_info,
        "matches": deduped[:8],
    }
