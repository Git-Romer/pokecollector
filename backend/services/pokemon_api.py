import httpx
from typing import Optional, Dict, Any, List

TCGDEX_BASE = "https://api.tcgdex.net/v2"


def _safe_int(val) -> int:
    """Safely convert a value to int for sorting."""
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0


def _sort_number(val) -> tuple:
    """Sort localId values like '1', '10', 'TG01' — numeric prefix first."""
    if val is None:
        return (9999, 9999, "")
    s = str(val)
    digits = ""
    prefix = ""
    for i, ch in enumerate(s):
        if ch.isdigit():
            digits = s[i:]
            prefix = s[:i]
            break
    else:
        prefix = s
        digits = ""
    return (0 if not prefix else 1, _safe_int(digits), prefix)


def get_base_url(lang: str = "en") -> str:
    """Get the TCGdex base URL for the given language."""
    return f"{TCGDEX_BASE}/{lang}"


def extract_prices(card_data: Dict) -> Dict[str, Optional[float]]:
    """Extract Cardmarket EUR prices from TCGdex card data."""
    prices = {
        "price_market": None,
        "price_low": None,
        "price_mid": None,
        "price_high": None,
        "price_trend": None,
        "price_avg1": None,
        "price_avg7": None,
        "price_avg30": None,
    }

    pricing = card_data.get("pricing") or {}
    cardmarket = pricing.get("cardmarket") or {}
    if cardmarket:
        avg = cardmarket.get("avg")
        prices["price_market"] = avg
        prices["price_low"] = cardmarket.get("low")
        prices["price_mid"] = avg          # Use avg as mid price
        prices["price_high"] = cardmarket.get("avg30")   # avg30 as high
        prices["price_trend"] = cardmarket.get("trend")
        prices["price_avg1"] = cardmarket.get("avg1")
        prices["price_avg7"] = cardmarket.get("avg7")
        prices["price_avg30"] = cardmarket.get("avg30")

    return prices


def search_cards(
    name: Optional[str] = None,
    set_id: Optional[str] = None,
    type_filter: Optional[str] = None,
    rarity: Optional[str] = None,
    artist: Optional[str] = None,
    hp_min: Optional[int] = None,
    hp_max: Optional[int] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    page: int = 1,
    page_size: int = 20,
    local_id: Optional[str] = None,
    lang: str = "en",
) -> Dict[str, Any]:
    """Search for cards using the TCGdex API.

    local_id: if provided, filter results to cards whose localId matches
              (used for number-only searches within a set).
    """
    base_url = get_base_url(lang)
    params = {}
    if name:
        params["name"] = name
    if set_id:
        params["set"] = set_id
    if type_filter:
        params["types"] = type_filter
    if rarity:
        params["rarity"] = rarity
    if local_id:
        params["localId"] = local_id

    with httpx.Client(timeout=30.0) as client:
        response = client.get(f"{base_url}/cards", params=params)
        response.raise_for_status()
        all_cards = response.json()

    if not isinstance(all_cards, list):
        all_cards = []

    # Client-side filters for fields not supported by TCGdex API
    if artist:
        artist_lower = artist.lower()
        all_cards = [c for c in all_cards if artist_lower in (c.get("illustrator") or "").lower()]
    if hp_min is not None:
        all_cards = [c for c in all_cards if c.get("hp") is not None and _safe_int(c.get("hp")) >= hp_min]
    if hp_max is not None:
        all_cards = [c for c in all_cards if c.get("hp") is not None and _safe_int(c.get("hp")) <= hp_max]

    # Sorting
    if sort_by:
        reverse = (sort_order or "asc") == "desc"
        if sort_by == "name":
            all_cards.sort(key=lambda c: (c.get("name") or "").lower(), reverse=reverse)
        elif sort_by == "number":
            all_cards.sort(key=lambda c: _sort_number(c.get("localId")), reverse=reverse)
        elif sort_by == "rarity":
            all_cards.sort(key=lambda c: (c.get("rarity") or "").lower(), reverse=reverse)

    total_count = len(all_cards)
    start = (page - 1) * page_size
    end = start + page_size
    page_cards = all_cards[start:end]

    # Normalize brief card data for frontend (add images_small/images_large fields)
    normalized = []
    for card in page_cards:
        image = card.get("image", "")
        normalized.append({
            **card,
            "images_small": f"{image}/low.webp" if image else None,
            "images_large": f"{image}/high.webp" if image else None,
            "number": card.get("localId"),
        })

    return {
        "data": normalized,
        "totalCount": total_count,
    }


def get_card(card_id: str, lang: str = "en") -> Optional[Dict]:
    """Get a single card by ID from TCGdex."""
    base_url = get_base_url(lang)
    with httpx.Client(timeout=30.0) as client:
        response = client.get(f"{base_url}/cards/{card_id}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()


def get_all_sets(display_lang: str = "en") -> List[Dict]:
    """Get all sets from TCGdex API — fetches EN and DE separately.

    Each language version of a set is returned as a SEPARATE entry.
    No merging/deduplication by set ID — "sv1" appears twice:
      - once as "sv1_de" (German TCGdex) with lang="de"
      - once as "sv1_en" (English TCGdex) with lang="en"

    Each entry has:
      "_db_key": composite DB primary key, e.g. "sv1_de"
      "_lang":   "de" or "en"
    """
    with httpx.Client(timeout=60.0) as client:
        all_sets: List[Dict] = []

        for lang in ["en", "de"]:
            try:
                url = get_base_url(lang)
                response = client.get(f"{url}/sets")
                response.raise_for_status()
                lang_sets = response.json()
                if not isinstance(lang_sets, list):
                    continue

                # Build set→series mapping for this language
                set_to_series: Dict[str, str] = {}
                try:
                    series_response = client.get(f"{url}/series", timeout=30.0)
                    all_series = series_response.json() if series_response.status_code == 200 else []
                    for serie in all_series:
                        try:
                            sr = client.get(f"{url}/series/{serie['id']}", timeout=30.0)
                            if sr.status_code == 200:
                                serie_data = sr.json()
                                serie_name = serie_data.get("name") or serie.get("name") or serie["id"]
                                for s in serie_data.get("sets", []):
                                    set_to_series[s["id"]] = serie_name
                        except Exception:
                            pass
                except Exception:
                    pass

                for s in lang_sets:
                    sid = s.get("id")
                    if not sid:
                        continue
                    entry = dict(s)
                    entry["_lang"] = lang
                    entry["_db_key"] = f"{sid}_{lang}"
                    entry["_series_name"] = set_to_series.get(sid)
                    all_sets.append(entry)

            except Exception:
                continue

        return all_sets


def get_set_detail(set_id: str, lang: str = "en") -> Optional[Dict]:
    """Get full set detail from TCGdex (includes releaseDate, logo, serie, abbreviation).

    Returns the raw TCGdex set object:
      { id, name, logo, symbol, cardCount, releaseDate, serie:{id,name},
        abbreviation:{official,...}, cards:[...] }
    Cards array is included in the response but we don't use it here.
    """
    base_url = get_base_url(lang)
    with httpx.Client(timeout=30.0) as client:
        response = client.get(f"{base_url}/sets/{set_id}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()


def get_set_cards(set_id: str, lang: str = "en") -> Dict:
    """Get full set detail including card list from TCGdex.

    Returns the raw TCGdex set object:
      { id, name, logo, symbol, cardCount, serie, releaseDate, cards: [...] }
    """
    base_url = get_base_url(lang)
    with httpx.Client(timeout=60.0) as client:
        response = client.get(f"{base_url}/sets/{set_id}")
        response.raise_for_status()
        return response.json()


def strip_lang_suffix(card_db_id: str) -> tuple:
    """Return (tcg_card_id, lang) from a composite DB card ID like 'sv1-1_de'."""
    for suffix in ("_de", "_en"):
        if card_db_id.endswith(suffix):
            return card_db_id[:-len(suffix)], suffix[1:]
    return card_db_id, "en"  # fallback for custom/legacy


def parse_card_for_db(card_data: Dict, default_set_id: Optional[str] = None, lang: Optional[str] = None) -> Dict:
    """Parse TCGdex card data into database-ready format.

    ID scheme: "{tcgdex_id}_{lang}", e.g. "sv1-1_de"
    tcg_card_id: original TCGdex ID, e.g. "sv1-1"
    Custom cards are NOT handled here (they set their own IDs).

    Works with both brief card data (id/localId/name/image) returned by /cards
    and full card detail returned by /cards/{id}.

    lang: optional language tag ("en" or "de") to store on the card record.
          Defaults to "en" if not provided.
    """
    prices = extract_prices(card_data)
    set_data = card_data.get("set") or {}
    set_id = set_data.get("id") or default_set_id
    image = card_data.get("image", "")

    # hp may be int in TCGdex; DB stores String
    hp_raw = card_data.get("hp")
    hp = str(hp_raw) if hp_raw is not None else None

    card_lang = card_data.get("_lang") or lang or "en"
    tcgdex_id = card_data.get("id", "")
    db_id = f"{tcgdex_id}_{card_lang}"

    return {
        "id": db_id,
        "tcg_card_id": tcgdex_id,
        "name": card_data.get("name", ""),
        "set_id": set_id,
        "number": card_data.get("localId"),
        "rarity": card_data.get("rarity"),
        "types": card_data.get("types"),
        "supertype": card_data.get("category"),
        "subtypes": None,   # TCGdex uses 'stage' rather than subtypes
        "hp": hp,
        "artist": card_data.get("illustrator"),
        "images_small": f"{image}/low.webp" if image else None,
        "images_large": f"{image}/high.webp" if image else None,
        "lang": card_lang,
        **prices,
    }


def parse_set_for_db(set_data: Dict) -> Dict:
    """Parse TCGdex set data into database-ready format.

    Accepts both brief set data (from /sets list) and full set detail (from /sets/{id}).

    When set_data contains "_db_key" (from get_all_sets), the composite key is used as
    the DB primary key and the original TCGdex ID is stored in "tcg_set_id".
    """
    # Series name: prefer enriched _series_name, fall back to embedded serie object
    serie = set_data.get("serie") or {}
    series_name = (
        set_data.get("_series_name")
        or (serie.get("name") if isinstance(serie, dict) else None)
    )

    card_count = set_data.get("cardCount") or {}

    # Abbreviation: from full set detail only
    abbreviation_obj = set_data.get("abbreviation") or {}
    abbreviation = (
        abbreviation_obj.get("official")
        if isinstance(abbreviation_obj, dict)
        else None
    )

    original_id = set_data["id"]
    db_key = set_data.get("_db_key") or original_id  # composite key if available

    return {
        "id": db_key,
        "tcg_set_id": original_id,
        "name": set_data.get("name", ""),
        "series": series_name,
        "release_date": set_data.get("releaseDate"),
        "total": card_count.get("total", 0),
        "printed_total": card_count.get("official", 0),
        "images_symbol": f"{set_data.get('symbol')}.webp" if set_data.get("symbol") else None,
        "images_logo": f"{set_data.get('logo')}.webp" if set_data.get("logo") else None,
        "abbreviation": abbreviation,
    }
