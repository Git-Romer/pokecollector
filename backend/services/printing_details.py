import hashlib
import re
import unicodedata


PRINTING_DETAIL_MAX_LENGTH = 80
PRINTING_DETAIL_MAX_TAGS = 10
PRINTING_DETAIL_CSV_SEPARATOR = "|"


def clean_printing_detail_name(value: str) -> str:
    name = " ".join(str(value or "").strip().split())
    if not name:
        raise ValueError("printing detail cannot be blank")
    if len(name) > PRINTING_DETAIL_MAX_LENGTH:
        raise ValueError(
            f"printing detail must be at most {PRINTING_DETAIL_MAX_LENGTH} characters"
        )
    if PRINTING_DETAIL_CSV_SEPARATOR in name:
        raise ValueError(
            f"printing detail cannot contain '{PRINTING_DETAIL_CSV_SEPARATOR}'"
        )
    return name


def normalize_printing_detail_name(value: str) -> str:
    """Build the user-scoped uniqueness key for a printing-detail tag.

    Preserve the first-entered display spelling while treating differences in
    case, accents, punctuation, and repeated whitespace as the same tag.
    """
    name = clean_printing_detail_name(value)
    decomposed = unicodedata.normalize("NFKD", name.casefold())
    without_marks = "".join(char for char in decomposed if not unicodedata.combining(char))
    normalized = re.sub(r"[\W_]+", " ", without_marks, flags=re.UNICODE)
    normalized = " ".join(normalized.split())
    if not normalized:
        raise ValueError("printing detail must contain at least one letter or number")
    return normalized


def printing_detail_normalized_key(normalized_name: str) -> str:
    """Return a fixed-size uniqueness key safe for PostgreSQL indexes."""
    return hashlib.sha256(normalized_name.encode("utf-8")).hexdigest()


def normalize_printing_details(values: list[str] | tuple[str, ...] | None) -> list[tuple[str, str]]:
    """Return unique ``(display_name, normalized_name)`` pairs in input order."""
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for value in values or []:
        display_name = clean_printing_detail_name(value)
        normalized_name = normalize_printing_detail_name(display_name)
        if normalized_name in seen:
            continue
        seen.add(normalized_name)
        result.append((display_name, normalized_name))
    if len(result) > PRINTING_DETAIL_MAX_TAGS:
        raise ValueError(
            f"a collection item can have at most {PRINTING_DETAIL_MAX_TAGS} printing details"
        )
    return result


def parse_printing_details_csv(value: str | None) -> list[str]:
    if not str(value or "").strip():
        return []
    return [
        display_name
        for display_name, _normalized_name in normalize_printing_details(
            str(value).split(PRINTING_DETAIL_CSV_SEPARATOR)
        )
    ]


def format_printing_details_csv(values) -> str:
    names = [getattr(value, "name", value) for value in (values or [])]
    return PRINTING_DETAIL_CSV_SEPARATOR.join(
        display_name for display_name, _normalized_name in normalize_printing_details(names)
    )
