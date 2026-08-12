import httpx
import math
import re
from functools import lru_cache
from typing import Optional, Dict, Any, List
from services.card_gameplay import playable_fingerprint
from services.pokedex import load_pokedex
from services.text_search import strip_diacritics
from services.tcgdex_languages import (
    DEFAULT_TCGDEX_SYNC_LANGUAGES,
    is_supported_tcgdex_language,
    normalize_tcgdex_language,
    normalize_tcgdex_sync_languages,
    strip_lang_suffix as _strip_lang_suffix,
)
from services.digital_sets import is_digital_set_data

TCGDEX_BASE = "https://api.tcgdex.net/v2"
_POKEMON_CATEGORY_VALUES = {"pokemon", "pokémon"}
_NAME_SUFFIX_TOKENS = {"ex", "gx", "v", "vmax", "vstar"}
_MEGA_FORM_TOKENS = {"x", "y"}


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
    normalized_lang = normalize_tcgdex_language(lang)
    if not is_supported_tcgdex_language(normalized_lang):
        normalized_lang = "en"
    return f"{TCGDEX_BASE}/{normalized_lang}"


def extract_prices(card_data: Dict) -> Dict[str, Optional[float]]:
    """Extract Cardmarket EUR and TCGPlayer USD prices from TCGdex card data."""
    prices = {
        # Cardmarket non-holo
        "price_market": None,
        "price_low": None,
        "price_mid": None,
        "price_high": None,
        "price_trend": None,
        "price_avg1": None,
        "price_avg7": None,
        "price_avg30": None,
        # Cardmarket holo
        "price_market_holo": None,
        "price_low_holo": None,
        "price_trend_holo": None,
        "price_avg1_holo": None,
        "price_avg7_holo": None,
        "price_avg30_holo": None,
        # TCGPlayer normal
        "price_tcg_normal_low": None,
        "price_tcg_normal_mid": None,
        "price_tcg_normal_high": None,
        "price_tcg_normal_market": None,
        # TCGPlayer reverse holofoil
        "price_tcg_reverse_low": None,
        "price_tcg_reverse_mid": None,
        "price_tcg_reverse_market": None,
        # TCGPlayer holofoil
        "price_tcg_holo_low": None,
        "price_tcg_holo_mid": None,
        "price_tcg_holo_market": None,
    }

    pricing = card_data.get("pricing") or {}

    # Cardmarket
    cardmarket = pricing.get("cardmarket") or {}
    if cardmarket:
        avg = cardmarket.get("avg")
        prices["price_market"] = avg
        prices["price_low"] = cardmarket.get("low")
        prices["price_mid"] = avg
        prices["price_high"] = cardmarket.get("avg30")
        prices["price_trend"] = cardmarket.get("trend")
        prices["price_avg1"] = cardmarket.get("avg1")
        prices["price_avg7"] = cardmarket.get("avg7")
        prices["price_avg30"] = cardmarket.get("avg30")
        # Holo prices
        prices["price_market_holo"] = cardmarket.get("avg-holo")
        prices["price_low_holo"] = cardmarket.get("low-holo")
        prices["price_trend_holo"] = cardmarket.get("trend-holo")
        prices["price_avg1_holo"] = cardmarket.get("avg1-holo")
        prices["price_avg7_holo"] = cardmarket.get("avg7-holo")
        prices["price_avg30_holo"] = cardmarket.get("avg30-holo")

    # TCGPlayer
    tcgplayer = pricing.get("tcgplayer") or {}
    if tcgplayer:
        normal = tcgplayer.get("normal") or {}
        if normal:
            prices["price_tcg_normal_low"] = normal.get("lowPrice")
            prices["price_tcg_normal_mid"] = normal.get("midPrice")
            prices["price_tcg_normal_high"] = normal.get("highPrice")
            prices["price_tcg_normal_market"] = normal.get("marketPrice")
        reverse = tcgplayer.get("reverse-holofoil") or {}
        if reverse:
            prices["price_tcg_reverse_low"] = reverse.get("lowPrice")
            prices["price_tcg_reverse_mid"] = reverse.get("midPrice")
            prices["price_tcg_reverse_market"] = reverse.get("marketPrice")
        holo = tcgplayer.get("holofoil") or {}
        if holo:
            prices["price_tcg_holo_low"] = holo.get("lowPrice")
            prices["price_tcg_holo_mid"] = holo.get("midPrice")
            prices["price_tcg_holo_market"] = holo.get("marketPrice")

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


def get_all_sets(languages: Optional[List[str]] = None, *, include_digital: bool = False) -> List[Dict]:
    """Get all sets from TCGdex API for the requested languages.

    Each language version of a set is returned as a SEPARATE entry.
    No merging/deduplication by set ID — "sv1" appears twice:
      - once as "sv1_de" (German TCGdex) with lang="de"
      - once as "sv1_en" (English TCGdex) with lang="en"

    Each entry has:
      "_db_key": composite DB primary key, e.g. "sv1_de"
      "_lang":   TCGdex language code, e.g. "de" or "zh-tw"
    """
    normalized_csv = normalize_tcgdex_sync_languages(languages or DEFAULT_TCGDEX_SYNC_LANGUAGES)
    requested_languages = normalized_csv.split(",") if normalized_csv else list(DEFAULT_TCGDEX_SYNC_LANGUAGES)

    with httpx.Client(timeout=60.0) as client:
        all_sets: List[Dict] = []

        for lang in requested_languages:
            try:
                url = get_base_url(lang)
                response = client.get(f"{url}/sets")
                response.raise_for_status()
                lang_sets = response.json()
                if not isinstance(lang_sets, list):
                    continue

                # Build set→series mapping for this language
                set_to_series: Dict[str, Dict[str, str]] = {}
                try:
                    series_response = client.get(f"{url}/series", timeout=30.0)
                    all_series = series_response.json() if series_response.status_code == 200 else []
                    for serie in all_series:
                        try:
                            sr = client.get(f"{url}/series/{serie['id']}", timeout=30.0)
                            if sr.status_code == 200:
                                serie_data = sr.json()
                                serie_name = serie_data.get("name") or serie.get("name") or serie["id"]
                                serie_id = serie_data.get("id") or serie.get("id")
                                for s in serie_data.get("sets", []):
                                    set_to_series[s["id"]] = {"id": serie_id, "name": serie_name}
                        except Exception:
                            pass
                except Exception:
                    pass

                for s in lang_sets:
                    sid = s.get("id")
                    if not sid:
                        continue
                    series_entry = set_to_series.get(sid) or {}
                    if not include_digital and series_entry.get("id") == "tcgp":
                        continue
                    # Fetch full detail to populate abbreviation and other fields
                    try:
                        detail = client.get(f"{url}/sets/{sid}", timeout=30.0)
                        entry = detail.json() if detail.status_code == 200 else dict(s)
                    except Exception:
                        entry = dict(s)
                    entry["_lang"] = lang
                    entry["_db_key"] = f"{sid}_{lang}"
                    entry["_series_id"] = series_entry.get("id")
                    entry["_series_name"] = series_entry.get("name")
                    if not include_digital and is_digital_set_data(entry):
                        continue
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
    return _strip_lang_suffix(card_db_id)


def extract_dex_ids(card_data: Dict) -> list[int] | None:
    """Normalize TCGdex ``dexId`` into a unique list of positive integers."""
    raw = card_data.get("dexId")
    if raw is None:
        raw = card_data.get("dex_ids")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raw = [raw]
    result: list[int] = []
    for value in raw:
        try:
            dex_id = int(value)
        except (TypeError, ValueError):
            continue
        if dex_id > 0 and dex_id not in result:
            result.append(dex_id)
    return result or None


def _normalized_species_name(value: str | None) -> str:
    normalized = strip_diacritics(value)
    normalized = normalized.replace("♀", " f ").replace("♂", " m ")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(normalized.split())


@lru_cache(maxsize=1)
def _pokedex_name_index() -> dict[str, int]:
    result: dict[str, int] = {}
    for entry in load_pokedex():
        dex_id = int(entry["dex_id"])
        for key in ("name_en", "name_de"):
            name = _normalized_species_name(entry.get(key))
            if name:
                result.setdefault(name, dex_id)
    return result


def _species_name_candidates(card_name: str | None) -> list[str]:
    normalized = _normalized_species_name(card_name)
    if not normalized:
        return []

    candidates = [normalized]
    tokens = normalized.split()
    had_mega_prefix = bool(tokens and tokens[0] in {"mega", "m"})
    if had_mega_prefix:
        tokens = tokens[1:]
        if tokens:
            candidates.append(" ".join(tokens))
    if tokens and tokens[-1] in _NAME_SUFFIX_TOKENS:
        tokens = tokens[:-1]
        if tokens:
            candidates.append(" ".join(tokens))
    if had_mega_prefix and tokens and tokens[-1] in _MEGA_FORM_TOKENS:
        tokens = tokens[:-1]
        if tokens:
            candidates.append(" ".join(tokens))

    result = []
    for candidate in candidates:
        if candidate and candidate not in result:
            result.append(candidate)
    return result


def infer_dex_ids_from_name(card_data: Dict) -> list[int] | None:
    """Infer base species when full TCGdex Pokémon details omit ``dexId``."""
    category = str(card_data.get("category") or "").strip().casefold()
    if category not in _POKEMON_CATEGORY_VALUES:
        return None

    name_index = _pokedex_name_index()
    for candidate in _species_name_candidates(card_data.get("name")):
        dex_id = name_index.get(candidate)
        if dex_id:
            return [dex_id]
    return None


def _product_id(value) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, dict):
        for key in ("idProduct", "productId", "product_id", "id"):
            if key in value:
                return _product_id(value.get(key))
        return None
    try:
        product_id = int(value)
    except (TypeError, ValueError):
        return None
    return product_id if product_id > 0 else None


def extract_cardmarket_products(card_data: Dict) -> list[dict] | None:
    """Return variant-aware Cardmarket product mappings from TCGdex data.

    TCGdex historically represented ``variants`` as a boolean object and now
    also exposes richer variant entries in its source data. This parser accepts
    both without treating Cardmarket price values as product identifiers.
    """
    products: list[dict] = []

    def add(product, variant=None, foil=None):
        product_id = _product_id(product)
        if not product_id:
            return
        row = {
            "variant": str(variant) if variant not in (None, "") else None,
            "foil": str(foil) if foil not in (None, "") else None,
            "product_id": product_id,
        }
        if row not in products:
            products.append(row)

    variants = card_data.get("variants")
    if isinstance(variants, list):
        for entry in variants:
            if not isinstance(entry, dict):
                continue
            third_party = entry.get("thirdParty") or entry.get("third_party") or {}
            add(
                third_party.get("cardmarket") if isinstance(third_party, dict) else None,
                entry.get("type") or entry.get("variant") or entry.get("name"),
                entry.get("foil") or entry.get("finish"),
            )
    elif isinstance(variants, dict):
        # Some database exports use variant-name keys with nested metadata.
        for variant_name, entry in variants.items():
            if not isinstance(entry, dict):
                continue
            third_party = entry.get("thirdParty") or entry.get("third_party") or {}
            add(
                third_party.get("cardmarket") if isinstance(third_party, dict) else None,
                entry.get("type") or variant_name,
                entry.get("foil") or entry.get("finish"),
            )

    third_party = card_data.get("thirdParty") or card_data.get("third_party") or {}
    if isinstance(third_party, dict):
        value = third_party.get("cardmarket")
        if isinstance(value, list):
            for entry in value:
                if isinstance(entry, dict):
                    add(entry, entry.get("type") or entry.get("variant"), entry.get("foil"))
                else:
                    add(entry)
        else:
            add(value)

    # Forward-compatible support if the public API adds the catalogue ID to
    # the pricing object alongside prices.
    pricing = card_data.get("pricing") or {}
    cardmarket = pricing.get("cardmarket") if isinstance(pricing, dict) else None
    if isinstance(cardmarket, dict):
        add(cardmarket.get("idProduct") or cardmarket.get("productId"))

    products.sort(key=lambda row: (row["product_id"], row.get("variant") or "", row.get("foil") or ""))
    return products or None


def parse_card_for_db(card_data: Dict, default_set_id: Optional[str] = None, lang: Optional[str] = None) -> Dict:
    """Parse TCGdex card data into database-ready format.

    ID scheme: "{tcgdex_id}_{lang}", e.g. "sv1-1_de"
    tcg_card_id: original TCGdex ID, e.g. "sv1-1"
    Custom cards are NOT handled here (they set their own IDs).

    Works with both brief card data (id/localId/name/image) returned by /cards
    and full card detail returned by /cards/{id}.

    lang: optional TCGdex language tag to store on the card record.
          Defaults to "en" if not provided or unsupported.
    """
    prices = extract_prices(card_data)
    set_data = card_data.get("set") or {}
    set_id = set_data.get("id") or default_set_id
    image = card_data.get("image", "")

    # hp may be int in TCGdex; DB stores String
    hp_raw = card_data.get("hp")
    hp = str(hp_raw) if hp_raw is not None else None

    card_lang = normalize_tcgdex_language(card_data.get("_lang") or lang or "en")
    if not is_supported_tcgdex_language(card_lang):
        card_lang = "en"
    tcgdex_id = card_data.get("id", "")
    db_id = f"{tcgdex_id}_{card_lang}"

    raw_variants = card_data.get("variants") or {}
    variants = raw_variants if isinstance(raw_variants, dict) else {}
    variant_types = {
        str(entry.get("type") or "").replace("_", "").replace("-", "").lower()
        for entry in raw_variants
        if isinstance(raw_variants, list) and isinstance(entry, dict)
    }
    pricing = card_data.get("pricing") or {}
    tcgplayer = pricing.get("tcgplayer") if isinstance(pricing, dict) else {}
    tcgplayer = tcgplayer if isinstance(tcgplayer, dict) else {}

    def available_variant(flag_name: str, list_name: str, price_name: str):
        """Union TCGdex variant flags with contradictory TCGplayer evidence."""
        flag = variants.get(flag_name) if variants else (list_name in variant_types or None)
        price_row = tcgplayer.get(price_name)
        def is_positive_price(value):
            if isinstance(value, bool):
                return False
            try:
                numeric_value = float(value)
            except (TypeError, ValueError):
                return False
            return math.isfinite(numeric_value) and numeric_value > 0

        positive_price = (
            any(is_positive_price(value) for value in price_row.values())
            if isinstance(price_row, dict)
            else False
        )
        if positive_price:
            return True
        return flag

    is_full_detail = "category" in card_data
    dex_ids = extract_dex_ids(card_data)
    if dex_ids is None and is_full_detail:
        dex_ids = infer_dex_ids_from_name(card_data)
    cardmarket_products = extract_cardmarket_products(card_data)
    # NULL means a brief set-list row still needs enrichment. An empty list
    # means a full TCGdex card response was checked and no mapping exists.
    if is_full_detail and dex_ids is None:
        dex_ids = []
    if is_full_detail and cardmarket_products is None:
        cardmarket_products = []
    retreat_raw = card_data.get("retreat")
    try:
        retreat = int(retreat_raw) if retreat_raw is not None else None
    except (TypeError, ValueError):
        retreat = None

    subtypes = card_data.get("subtypes")
    if subtypes is None:
        subtypes = [
            value
            for value in (
                card_data.get("trainerType"),
                card_data.get("energyType"),
                card_data.get("stage"),
                card_data.get("suffix"),
            )
            if value
        ] or None

    return {
        "id": db_id,
        "tcg_card_id": tcgdex_id,
        "name": card_data.get("name", ""),
        "set_id": set_id,
        "number": card_data.get("localId"),
        "rarity": card_data.get("rarity"),
        "types": card_data.get("types"),
        "supertype": card_data.get("category"),
        "subtypes": subtypes,
        "hp": hp,
        "artist": card_data.get("illustrator"),
        "images_small": f"{image}/low.webp" if image else None,
        "images_large": f"{image}/high.webp" if image else None,
        "image_source_lang": None,
        "data_source_lang": None,
        "is_digital": is_digital_set_data(set_data),
        "lang": card_lang,
        "stage": card_data.get("stage"),
        "evolve_from": card_data.get("evolveFrom"),
        "suffix": card_data.get("suffix"),
        "trainer_type": card_data.get("trainerType"),
        "energy_type": card_data.get("energyType"),
        "card_effect": card_data.get("effect"),
        "regulation_mark": card_data.get("regulationMark"),
        "attacks": card_data.get("attacks"),
        "abilities": card_data.get("abilities"),
        "weaknesses": card_data.get("weaknesses"),
        "resistances": card_data.get("resistances"),
        "dex_ids": dex_ids,
        "cardmarket_products": cardmarket_products,
        "retreat": retreat,
        "playable_fingerprint": playable_fingerprint(card_data),
        "variants_normal": available_variant("normal", "normal", "normal"),
        "variants_reverse": available_variant("reverse", "reverse", "reverse-holofoil"),
        "variants_holo": available_variant("holo", "holo", "holofoil"),
        "variants_first_edition": variants.get("firstEdition") if variants else ("firstedition" in variant_types or None),
        "price_source_lang": None,
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
        "is_digital": is_digital_set_data(set_data),
    }
