"""Supported TCGdex language helpers.

Keep language validation, ordering, and composite ID suffix parsing in one place so
new TCGdex languages do not require scattered en/de checks.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

DEFAULT_TCGDEX_SYNC_LANGUAGES: tuple[str, ...] = ("en", "de")
ENGLISH_FALLBACK_LANGUAGE = "en"
SUPPORTED_TCGDEX_LANGUAGES: tuple[str, ...] = (
    "en",
    "fr",
    "es",
    "es-mx",
    "it",
    "pt",
    "pt-br",
    "pt-pt",
    "de",
    "nl",
    "pl",
    "ru",
    "ja",
    "ko",
    "zh-tw",
    "id",
    "th",
    "zh-cn",
)

_LANGUAGE_ALIASES = {
    "zh": "zh-cn",
    "zh-hans": "zh-cn",
    "zh_hans": "zh-cn",
    "zh-cn": "zh-cn",
    "zh_cn": "zh-cn",
    "zh-hant": "zh-tw",
    "zh_hant": "zh-tw",
    "zh-tw": "zh-tw",
    "zh_tw": "zh-tw",
    "jp": "ja",
    "kr": "ko",
    "br": "pt-br",
}

_LANGUAGE_SUFFIX_RE = re.compile(
    r"_(" + "|".join(re.escape(lang) for lang in sorted(SUPPORTED_TCGDEX_LANGUAGES, key=len, reverse=True)) + r")$"
)


def normalize_tcgdex_language(value: Any) -> str:
    """Normalize one language code for TCGdex lookups."""
    code = str(value or "").strip().lower().replace("_", "-")
    return _LANGUAGE_ALIASES.get(code, code)


def is_supported_tcgdex_language(value: Any) -> bool:
    return normalize_tcgdex_language(value) in SUPPORTED_TCGDEX_LANGUAGES


def iter_tcgdex_language_parts(value: Any) -> list[str]:
    """Return normalized language parts from CSV/list input, preserving repeats."""
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[,\s]+", value)
    elif isinstance(value, Iterable):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.extend(re.split(r"[,\s]+", item))
            else:
                parts.append(str(item))
    else:
        parts = [str(value)]
    return [normalize_tcgdex_language(part) for part in parts if str(part or "").strip()]


def normalize_tcgdex_sync_languages(value: Any, *, default_on_empty: bool = True) -> str:
    """Normalize configured sync languages to a stable CSV string.

    Unknown values are ignored so Docker/env typos cannot break startup. If no
    valid values remain and default_on_empty is true, the default en,de pair is
    returned. The special value "all" expands to every known TCGdex language.
    """
    raw_parts = iter_tcgdex_language_parts(value)
    if "all" in raw_parts:
        selected = list(SUPPORTED_TCGDEX_LANGUAGES)
    else:
        selected = []
        for lang in SUPPORTED_TCGDEX_LANGUAGES:
            if lang in raw_parts and lang not in selected:
                selected.append(lang)

    if not selected and default_on_empty:
        selected = list(DEFAULT_TCGDEX_SYNC_LANGUAGES)

    return ",".join(selected)


def validate_tcgdex_sync_languages(value: Any) -> str:
    """Normalize user-provided sync languages or raise ValueError if none are valid."""
    normalized = normalize_tcgdex_sync_languages(value, default_on_empty=False)
    if not normalized:
        allowed = ", ".join(SUPPORTED_TCGDEX_LANGUAGES)
        raise ValueError(f"tcgdex_sync_languages must include at least one supported language: {allowed}")
    return normalized


def strip_lang_suffix(value: str | None) -> tuple[str, str]:
    """Return (base_id, lang) for composite IDs like sv1-1_zh-tw.

    Legacy IDs without a supported suffix default to English for backward
    compatibility.
    """
    identifier = str(value or "")
    match = _LANGUAGE_SUFFIX_RE.search(identifier)
    if match:
        lang = match.group(1)
        return identifier[: match.start()], lang
    return identifier, ENGLISH_FALLBACK_LANGUAGE


def has_lang_suffix(value: str | None) -> bool:
    return bool(_LANGUAGE_SUFFIX_RE.search(str(value or "")))


def with_lang_suffix(base_id: str, lang: str) -> str:
    return f"{base_id}_{normalize_tcgdex_language(lang)}"


def english_fallback_languages(target_lang: str | None) -> list[str]:
    """Preferred data fallback order for missing card/set data.

    English is the global fallback source. For English rows there is no stronger
    fallback source, so return an empty list instead of guessing from another
    language.
    """
    lang = normalize_tcgdex_language(target_lang)
    if lang and lang != ENGLISH_FALLBACK_LANGUAGE:
        return [ENGLISH_FALLBACK_LANGUAGE]
    return []


def supported_tcgdex_language_payload() -> list[dict[str, str]]:
    names = {
        "en": "English",
        "fr": "French",
        "es": "Spanish",
        "es-mx": "Spanish Mexico",
        "it": "Italian",
        "pt": "Portuguese",
        "pt-br": "Portuguese Brazil",
        "pt-pt": "Portuguese Portugal",
        "de": "German",
        "nl": "Dutch",
        "pl": "Polish",
        "ru": "Russian",
        "ja": "Japanese",
        "ko": "Korean",
        "zh-tw": "Chinese Traditional",
        "id": "Indonesian",
        "th": "Thai",
        "zh-cn": "Chinese Simplified",
    }
    return [{"code": code, "name": names[code]} for code in SUPPORTED_TCGDEX_LANGUAGES]
