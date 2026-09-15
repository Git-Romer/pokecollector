"""Curated Pokédex form catalogue and deterministic card classification.

TCGdex exposes National Pokédex numbers but no stable form identifier.  Keep
the upstream ``dex_ids`` as the grouped truth and derive these entry keys from
the card name.  This module is deliberately pure so existing rows can be
reclassified whenever the rules improve without touching collection data.
"""

from __future__ import annotations

import re
from functools import lru_cache

from services.pokedex import load_pokedex, pokedex_by_id
from services.text_search import strip_diacritics

FORM_FAMILIES = ("base", "mega", "alola", "galar", "hisui", "paldea")
FORM_FAMILY_PATTERN = "^(all|" + "|".join(FORM_FAMILIES) + ")$"

# (National Dex number, form slug, PokéAPI image id).  A form is only exposed
# by the overview after at least one locally synced printing maps to it.
_MEGA_FORMS = (
    (3, "mega", 10033), (6, "mega-x", 10034), (6, "mega-y", 10035),
    (9, "mega", 10036), (65, "mega", 10037), (94, "mega", 10038),
    (115, "mega", 10039), (127, "mega", 10040), (130, "mega", 10041),
    (142, "mega", 10042), (150, "mega-x", 10043), (150, "mega-y", 10044),
    (181, "mega", 10045), (212, "mega", 10046), (214, "mega", 10047),
    (229, "mega", 10048), (248, "mega", 10049), (257, "mega", 10050),
    (282, "mega", 10051), (303, "mega", 10052), (306, "mega", 10053),
    (308, "mega", 10054), (310, "mega", 10055), (354, "mega", 10056),
    (359, "mega", 10057), (445, "mega", 10058), (448, "mega", 10059),
    (460, "mega", 10060), (380, "mega", 10062), (381, "mega", 10063),
    (260, "mega", 10064), (254, "mega", 10065), (302, "mega", 10066),
    (334, "mega", 10067), (475, "mega", 10068), (531, "mega", 10069),
    (319, "mega", 10070), (80, "mega", 10071), (208, "mega", 10072),
    (18, "mega", 10073), (362, "mega", 10074), (719, "mega", 10075),
    (376, "mega", 10076), (384, "mega", 10079), (323, "mega", 10087),
    (428, "mega", 10088), (373, "mega", 10089), (15, "mega", 10090),
    # Pokémon Legends: Z-A additions. They remain hidden until a matching
    # physical TCG printing exists in the local catalogue.
    (36, "mega", 10278), (71, "mega", 10279), (121, "mega", 10280),
    (149, "mega", 10281), (154, "mega", 10282), (160, "mega", 10283),
    (227, "mega", 10284), (478, "mega", 10285), (500, "mega", 10286),
    (530, "mega", 10287), (545, "mega", 10288), (560, "mega", 10289),
    (604, "mega", 10290), (609, "mega", 10291), (652, "mega", 10292),
    (655, "mega", 10293), (658, "mega", 10294), (668, "mega", 10295),
    (670, "mega", 10296), (687, "mega", 10297), (689, "mega", 10298),
    (691, "mega", 10299), (701, "mega", 10300), (718, "mega", 10301),
    (780, "mega", 10302), (870, "mega", 10303),
    (26, "mega-x", 10304), (26, "mega-y", 10305), (358, "mega", 10306),
    (359, "mega-z", 10307), (398, "mega", 10308), (445, "mega-z", 10309),
    (448, "mega-z", 10310), (485, "mega", 10311), (491, "mega", 10312),
    (623, "mega", 10313), (678, "mega", 10314), (740, "mega", 10315),
    (768, "mega", 10316), (801, "mega", 10317), (807, "mega", 10319),
    (952, "mega", 10320), (970, "mega", 10321), (978, "mega", 10322),
    (998, "mega", 10325),
)

_REGIONAL_FORMS = {
    "alola": (
        (19, 10091), (20, 10092), (26, 10100), (27, 10101), (28, 10102),
        (37, 10103), (38, 10104), (50, 10105), (51, 10106), (52, 10107),
        (53, 10108), (74, 10109), (75, 10110), (76, 10111), (88, 10112),
        (89, 10113), (103, 10114), (105, 10115),
    ),
    "galar": (
        (52, 10161), (77, 10162), (78, 10163), (79, 10164), (80, 10165),
        (83, 10166), (110, 10167), (122, 10168), (144, 10169),
        (145, 10170), (146, 10171), (199, 10172), (222, 10173),
        (263, 10174), (264, 10175), (554, 10176), (555, 10177),
        (562, 10179), (618, 10180),
    ),
    "hisui": (
        (58, 10229), (59, 10230), (100, 10231), (101, 10232),
        (157, 10233), (211, 10234), (215, 10235), (503, 10236),
        (549, 10237), (550, 10247), (570, 10238), (571, 10239),
        (628, 10240), (704, 10241), (705, 10242), (713, 10243),
        (724, 10244),
    ),
    # Tauros breeds are not identified by TCG card names. Track the reliably
    # detectable Paldean form as one entry and use Combat Breed artwork.
    "paldea": ((128, 10250), (194, 10253)),
}

_FAMILY_LABELS = {
    "mega": ("Mega", "Mega"),
    "alola": ("Alolan", "Alola"),
    "galar": ("Galarian", "Galar"),
    "hisui": ("Hisuian", "Hisui"),
    "paldea": ("Paldean", "Paldea"),
}
_ENTRY_SUFFIX = {
    "mega": "M", "mega-x": "MX", "mega-y": "MY", "mega-z": "MZ",
    "alola": "A", "galar": "G", "hisui": "H", "paldea": "P",
}
_REGION_MARKERS = {
    "alola": ("alola", "alolan", "アローラ", "阿羅拉", "阿罗拉", "알로라", "อโลลา", "алола", "алоль"),
    "galar": ("galar", "galarian", "ガラル", "伽勒爾", "伽勒尔", "가라르", "กาลาร์", "галар"),
    "hisui": ("hisui", "hisuian", "ヒスイ", "洗翠", "히스이", "ฮิซุย", "хису"),
    "paldea": ("paldea", "paldean", "パルデア", "帕底亞", "帕底亚", "팔데아", "พัลเดีย", "палде"),
}
_MEGA_MARKERS = ("mega", "メガ", "超級", "超级", "메가", "เมก้า", "мега")

# Legacy M-Pokémon names do not say which Charizard/Mewtwo form the artwork
# depicts. These stable TCGdex IDs are language independent.
_CARD_OVERRIDES = {
    "g1-12": {6: "mega-y"}, "xy2-13": {6: "mega-y"},
    "xy2-107": {6: "mega-y"}, "xy12-13": {6: "mega-y"},
    "xy12-101": {6: "mega-y"}, "xy2-69": {6: "mega-x"},
    "xy2-108": {6: "mega-x"}, "xy8-63": {150: "mega-x"},
    "xy8-159": {150: "mega-x"}, "xy8-64": {150: "mega-y"},
    "xy8-160": {150: "mega-y"},
}


def entry_key(dex_id: int, form: str = "base") -> str:
    return str(int(dex_id)) if form == "base" else f"{int(dex_id)}:{form}"


def split_entry_key(value: str | int) -> tuple[int, str] | None:
    match = re.fullmatch(r"([1-9]\d{0,3})(?::([a-z]+(?:-[xyz])?))?", str(value or ""))
    if not match:
        return None
    dex_id = int(match.group(1))
    if dex_id not in pokedex_by_id():
        return None
    return dex_id, match.group(2) or "base"


def form_family(form: str) -> str:
    return "mega" if form.startswith("mega") else form


@lru_cache(maxsize=1)
def form_catalogue() -> tuple[dict, ...]:
    rows: list[dict] = []
    for dex_id, form, image_id in _MEGA_FORMS:
        rows.append(_form_row(dex_id, form, image_id))
    for family, entries in _REGIONAL_FORMS.items():
        for dex_id, image_id in entries:
            rows.append(_form_row(dex_id, family, image_id))
    return tuple(sorted(rows, key=lambda row: (row["dex_id"], row["form"])))


def _form_row(dex_id: int, form: str, image_id: int) -> dict:
    base = pokedex_by_id()[dex_id]
    family = form_family(form)
    en_prefix, de_prefix = _FAMILY_LABELS[family]
    variant = form.rsplit("-", 1)[-1].upper() if form in {"mega-x", "mega-y", "mega-z"} else ""
    name_en = f"{en_prefix} {base['name_en']}{f' {variant}' if variant else ''}"
    if family == "mega":
        name_de = f"Mega-{base['name_de']}{f' {variant}' if variant else ''}"
    else:
        name_de = f"{de_prefix}-{base['name_de']}"
    return {
        **base,
        "entry_id": entry_key(dex_id, form),
        "form": form,
        "form_family": family,
        "form_label_en": en_prefix + (f" {variant}" if variant else ""),
        "form_label_de": de_prefix + (f" {variant}" if variant else ""),
        "name_en": name_en,
        "name_de": name_de,
        "display_number": f"#{dex_id:03d}-{_ENTRY_SUFFIX[form]}",
        "image_id": image_id,
    }


@lru_cache(maxsize=1)
def form_catalogue_by_key() -> dict[str, dict]:
    return {row["entry_id"]: row for row in form_catalogue()}


@lru_cache(maxsize=1)
def forms_by_dex_id() -> dict[int, tuple[dict, ...]]:
    result: dict[int, list[dict]] = {}
    for row in form_catalogue():
        result.setdefault(row["dex_id"], []).append(row)
    return {dex_id: tuple(rows) for dex_id, rows in result.items()}


def base_entry(dex_id: int) -> dict:
    row = dict(pokedex_by_id()[int(dex_id)])
    row.update(
        entry_id=str(int(dex_id)), form="base", form_family="base",
        form_label_en="Base", form_label_de="Basis",
        display_number=f"#{int(dex_id):03d}", image_id=int(dex_id),
    )
    return row


def get_entry(value: str | int) -> dict | None:
    parsed = split_entry_key(value)
    if not parsed:
        return None
    dex_id, form = parsed
    return base_entry(dex_id) if form == "base" else form_catalogue_by_key().get(entry_key(dex_id, form))


def _normalize(value: str | None) -> str:
    value = strip_diacritics(value).replace("♀", " f ").replace("♂", " m ")
    return " ".join(re.sub(r"[\W_]+", " ", value, flags=re.UNICODE).split())


@lru_cache(maxsize=1)
def _aliases_by_dex() -> dict[int, tuple[str, ...]]:
    aliases = {}
    for row in load_pokedex():
        values = tuple(dict.fromkeys(_normalize(row.get(key)) for key in ("name_en", "name_de")))
        aliases[int(row["dex_id"])] = tuple(value for value in values if value)
    return aliases


def _segments_for_dex(
    name: str,
    dex_id: int,
    *,
    allow_unmatched: bool = False,
    fallback_index: int | None = None,
    fallback_count: int | None = None,
) -> list[str]:
    # Split before punctuation normalization. Do not treat the standalone X/Y/Z
    # tokens as conjunctions because they identify specific Mega forms.
    # TCGdex returns localized card names, so include the conjunctions used by
    # supported catalogue languages that can name a mixed card. Short words
    # such as Spanish ``y`` are only separators when the same species name is
    # present on both sides; this preserves the Y in ``Mega Charizard Y ex``.
    aliases = _aliases_by_dex()[dex_id]
    segments: list[str] = []
    for segment in re.split(
        r"\s+(?:and|und|et|och|dan)\s+|\s*&\s*|\s*\+\s*|\s*/\s*",
        str(name or ""),
        flags=re.IGNORECASE,
    ):
        localized_parts = re.split(r"\s+(?:y|e|en|i)\s+", segment, flags=re.IGNORECASE)
        matching_parts = [
            part for part in localized_parts
            if any(alias in _normalize(part) for alias in aliases)
        ]
        segments.extend(localized_parts if len(matching_parts) >= 2 else [segment])
    segments = [_normalize(segment) for segment in segments]
    matched = [segment for segment in segments if any(alias in segment for alias in aliases)]
    if matched:
        return matched
    if allow_unmatched:
        return segments
    # Non-Latin card names cannot be matched against the bundled English and
    # German aliases. TCGdex keeps dex IDs in depicted-name order, so use the
    # corresponding segment when the two lists align.
    if fallback_count == len(segments) and fallback_index is not None:
        return [segments[fallback_index]]
    return [segments[0]] if len(segments) == 1 else []


def _contains_marker(segment: str, marker: str) -> bool:
    return marker in segment if not marker.isascii() else bool(re.search(rf"\b{re.escape(marker)}\b", segment))


def _detect_form(segment: str, dex_id: int, tcg_card_id: str | None) -> str | None:
    override = _CARD_OVERRIDES.get(str(tcg_card_id or "").casefold(), {}).get(dex_id)
    if override:
        return override
    available = {row["form"] for row in forms_by_dex_id().get(dex_id, ())}
    for family, markers in _REGION_MARKERS.items():
        if family in available and any(_contains_marker(segment, marker) for marker in markers):
            return family
    is_mega = bool(any(_contains_marker(segment, marker) for marker in _MEGA_MARKERS) or re.match(r"^m\s+", segment))
    if not is_mega:
        return "base"
    mega_forms = {form for form in available if form.startswith("mega")}
    if not mega_forms:
        return "base"
    for suffix in ("x", "y", "z"):
        candidate = f"mega-{suffix}"
        if candidate in mega_forms and re.search(
            rf"(?<![a-z0-9]){suffix}(?:\s*(?:ex|gx|v|vmax|vstar))?$",
            segment,
        ):
            return candidate
    return "mega" if "mega" in mega_forms else None


def classify_pokedex_entries(
    name: str | None,
    dex_ids,
    *,
    tcg_card_id: str | None = None,
    is_pokemon: bool = True,
) -> list[str]:
    """Return stable entry keys represented by a physical Pokémon card."""
    if not is_pokemon or not isinstance(dex_ids, list):
        return []
    normalized_name = _normalize(name)
    valid_dex_ids: list[int] = []
    for raw_dex_id in dex_ids:
        try:
            dex_id = int(raw_dex_id)
        except (TypeError, ValueError):
            continue
        if dex_id in pokedex_by_id() and dex_id not in valid_dex_ids:
            valid_dex_ids.append(dex_id)

    result: list[str] = []
    for index, dex_id in enumerate(valid_dex_ids):
        segments = _segments_for_dex(
            str(name or ""),
            dex_id,
            allow_unmatched=len(valid_dex_ids) == 1,
            fallback_index=index,
            fallback_count=len(valid_dex_ids),
        )
        if not segments:
            segments = [normalized_name]
        for segment in segments:
            form = _detect_form(segment, dex_id, tcg_card_id)
            if form is None:
                continue
            key = entry_key(dex_id, form)
            if key not in result:
                result.append(key)
    return result
