"""Visibility and sync pinning helpers for localized TCGdex data.

Configured sync languages control the global catalogue. Cards that are tracked in
collections, wishlists, or binders pin their localized set so the app can keep
that set visible and fully synced even after the language is removed from the
global catalogue setting.
"""

from __future__ import annotations

from sqlalchemy import and_, false, or_
from sqlalchemy.orm import Session

from models import Binder, BinderCard, Card, CollectionItem, Set, Setting, WishlistItem
from services.tcgdex_languages import normalize_tcgdex_language, normalize_tcgdex_sync_languages, with_lang_suffix

SetLangPair = tuple[str, str]


def get_configured_sync_languages(db: Session) -> list[str]:
    """Return globally enabled TCGdex catalogue languages in stable order."""
    row = db.query(Setting).filter(Setting.key == "tcgdex_sync_languages").first()
    normalized = normalize_tcgdex_sync_languages(row.value if row else "en,de")
    return normalized.split(",") if normalized else ["en", "de"]


def _normalize_pair(set_id: str | None, lang: str | None) -> SetLangPair | None:
    if not set_id:
        return None
    normalized_lang = normalize_tcgdex_language(lang or "en")
    if not normalized_lang:
        return None
    return (str(set_id), normalized_lang)


def _add_pairs(rows, pairs: set[SetLangPair]) -> None:
    for set_id, lang in rows:
        pair = _normalize_pair(set_id, lang)
        if pair:
            pairs.add(pair)


def get_pinned_set_language_pairs(db: Session, user_id: int | None = None) -> set[SetLangPair]:
    """Return localized set pairs pinned by collection, wishlist, or binder cards.

    ``user_id=None`` means app-wide pins for background sync. Passing a user id
    returns only the pairs that should remain visible for that user.
    """
    pairs: set[SetLangPair] = set()

    collection_query = (
        db.query(Card.set_id, Card.lang)
        .join(CollectionItem, CollectionItem.card_id == Card.id)
        .filter(Card.is_custom == False, Card.set_id.isnot(None))
    )
    if user_id is not None:
        collection_query = collection_query.filter(CollectionItem.user_id == user_id)
    _add_pairs(collection_query.distinct().all(), pairs)

    wishlist_query = (
        db.query(Card.set_id, Card.lang)
        .join(WishlistItem, WishlistItem.card_id == Card.id)
        .filter(Card.is_custom == False, Card.set_id.isnot(None))
    )
    if user_id is not None:
        wishlist_query = wishlist_query.filter(WishlistItem.user_id == user_id)
    _add_pairs(wishlist_query.distinct().all(), pairs)

    binder_query = (
        db.query(Card.set_id, Card.lang)
        .join(BinderCard, BinderCard.card_id == Card.id)
        .join(Binder, Binder.id == BinderCard.binder_id)
        .filter(Card.is_custom == False, Card.set_id.isnot(None))
    )
    if user_id is not None:
        binder_query = binder_query.filter(Binder.user_id == user_id)
    _add_pairs(binder_query.distinct().all(), pairs)

    return pairs


def set_pair_filter(pairs: set[SetLangPair] | list[SetLangPair] | tuple[SetLangPair, ...]):
    """SQLAlchemy predicate for localized Set rows matching any pair."""
    clauses = []
    for set_id, lang in sorted(set(pairs)):
        clauses.append(and_(
            Set.lang == lang,
            or_(
                Set.tcg_set_id == set_id,
                Set.id == set_id,
                Set.id == with_lang_suffix(set_id, lang),
            ),
        ))
    return or_(*clauses) if clauses else false()


def card_pair_filter(pairs: set[SetLangPair] | list[SetLangPair] | tuple[SetLangPair, ...]):
    """SQLAlchemy predicate for localized Card rows inside any pinned set pair."""
    clauses = [and_(Card.set_id == set_id, Card.lang == lang) for set_id, lang in sorted(set(pairs))]
    return or_(*clauses) if clauses else false()


def visible_set_filter(db: Session, user_id: int, requested_lang: str | None = "all"):
    """Predicate for sets visible to the current user.

    Globally enabled languages are visible in full. Disabled languages are only
    visible for set/language pairs pinned by this user's collection, wishlist, or
    binders.
    """
    active_languages = set(get_configured_sync_languages(db))
    pinned_pairs = get_pinned_set_language_pairs(db, user_id=user_id)
    lang = normalize_tcgdex_language(requested_lang or "all")

    if lang != "all":
        if lang in active_languages:
            return Set.lang == lang
        return set_pair_filter({pair for pair in pinned_pairs if pair[1] == lang})

    return or_(Set.lang.in_(active_languages), set_pair_filter(pinned_pairs))


def visible_card_filter(db: Session, user_id: int, requested_lang: str | None = "all"):
    """Predicate for catalogue cards visible to the current user."""
    active_languages = set(get_configured_sync_languages(db))
    pinned_pairs = get_pinned_set_language_pairs(db, user_id=user_id)
    lang = normalize_tcgdex_language(requested_lang or "all")

    if lang != "all":
        if lang in active_languages:
            return Card.lang == lang
        return card_pair_filter({pair for pair in pinned_pairs if pair[1] == lang})

    return or_(Card.lang.in_(active_languages), card_pair_filter(pinned_pairs))


def sync_set_filter(db: Session):
    """Predicate for localized sets that full sync should maintain app-wide."""
    active_languages = set(get_configured_sync_languages(db))
    pinned_pairs = get_pinned_set_language_pairs(db, user_id=None)
    return or_(Set.lang.in_(active_languages), set_pair_filter(pinned_pairs))
