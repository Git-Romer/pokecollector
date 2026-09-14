from enum import Enum


class CollectionVariant(str, Enum):
    NORMAL = "Normal"
    HOLO = "Holo"
    REVERSE_HOLO = "Reverse Holo"
    FIRST_EDITION = "First Edition"


CANONICAL_VARIANTS = tuple(variant.value for variant in CollectionVariant)
CANONICAL_VARIANT_SET = frozenset(CANONICAL_VARIANTS)


def normalize_collection_variant(variant: str | CollectionVariant | None) -> str:
    """Return a canonical collection variant or reject the value.

    Blank legacy inputs remain equivalent to Normal, but non-blank values must
    exactly match the public enum. This keeps pricing, effects, imports, and
    inventory identity on the same four-value contract.
    """
    value = str(variant.value if isinstance(variant, CollectionVariant) else (variant or "")).strip()
    value = value or CollectionVariant.NORMAL.value
    if value not in CANONICAL_VARIANT_SET:
        raise ValueError(
            "variant must be blank or one of: "
            + ", ".join(CANONICAL_VARIANTS)
            + ". Put specific physical printing descriptions in printing_details."
        )
    return value
