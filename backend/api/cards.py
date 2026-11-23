from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_, func, cast, Integer, String, not_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import JSONB
from typing import Optional, List
from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, Set, PriceHistory, CustomCardMatch, CollectionCardPhoto, CollectionItem, WishlistItem, User, ImageCache, ProductCard, ProductLedgerEntry, TradeItem
from schemas import CardBase, CardWithSet, PriceHistoryResponse, CardCustomCreate, CustomCardUpdate, CardCustomImageUpdate
from services import pokemon_api
from services.card_fallbacks import (
    apply_cross_language_fallbacks,
    build_missing_language_card,
    clone_card_for_missing_language,
    other_supported_lang,
)
from services.card_metadata import (
    METADATA_ENRICHMENT_PER_SEARCH_PAGE,
    card_needs_metadata_enrichment,
    enrich_card_metadata_ids_in_background,
)
from services.card_upsert import upsert_card
from services.card_visibility import (
    get_configured_sync_languages,
    visible_any_card_filter,
    visible_card_filter,
    visible_custom_card_filter,
    visible_set_filter,
)
from services.digital_sets import digital_sets_enabled
from services.display_language import get_tcgdex_display_language
from services.image_url_security import validate_public_https_image_url
from services.pokedex import card_pokedex_entry_ids
from services.pokedex_forms import get_entry as get_pokedex_entry
from services.card_numbers import card_number_filter, natural_card_number_key
from services.collection_variants import CANONICAL_VARIANTS
from services.tcgdex_languages import english_fallback_languages, has_lang_suffix, is_supported_tcgdex_language, normalize_tcgdex_language, strip_lang_suffix
from services.text_search import accent_insensitive_contains, json_array_text_matches, normalize_search_term
from services.card_state import card_state_summaries
from services.product_sources import annotate_product_sources
import datetime
import re
from uuid import uuid4

router = APIRouter()

# Pattern: an alphanumeric set code (e.g. "MEP 022", "sv08 032", "M2a 228",
# "30C 001"), then a numeric card number. Set codes may begin with a digit
# (e.g. the 30th anniversary set "30C"). The set is resolved by an exact,
# case-insensitive match on abbreviation/id; a code that matches no set falls
# back to the name search, so a card named "151 025" stays reachable.
_CODE_NUMBER_RE = re.compile(r'^([A-Za-z0-9]+)\s+(\d+)$')


def _card_to_dict(card: Card, current_user_id: int | None = None) -> dict:
    """Convert a Card ORM object to a dict matching the search result format."""
    set_ref = getattr(card, 'set_ref', None)
    is_custom_owner = bool(
        card.is_custom
        and current_user_id is not None
        and getattr(card, "custom_owner_id", None) == current_user_id
    )
    set_ref_dict = {
        "id": set_ref.id,
        "tcg_set_id": set_ref.tcg_set_id,
        "name": set_ref.name,
        "abbreviation": set_ref.abbreviation,
        "lang": set_ref.lang,
    } if set_ref else None
    return {
        "id": card.id,
        "tcg_card_id": card.tcg_card_id,
        "name": card.name,
        "number": card.number,
        "localId": card.number,
        "set_id": card.set_id,
        "set_ref": set_ref_dict,
        "rarity": card.rarity,
        "types": card.types,
        "supertype": card.supertype,
        "subtypes": card.subtypes,
        "hp": card.hp,
        "artist": card.artist,
        "stage": getattr(card, "stage", None),
        "evolve_from": getattr(card, "evolve_from", None),
        "suffix": getattr(card, "suffix", None),
        "trainer_type": getattr(card, "trainer_type", None),
        "energy_type": getattr(card, "energy_type", None),
        "card_effect": getattr(card, "card_effect", None),
        "regulation_mark": getattr(card, "regulation_mark", None),
        "attacks": getattr(card, "attacks", None),
        "abilities": getattr(card, "abilities", None),
        "weaknesses": getattr(card, "weaknesses", None),
        "resistances": getattr(card, "resistances", None),
        "dex_ids": getattr(card, "dex_ids", None),
        "pokedex_entry_ids": getattr(card, "pokedex_entry_ids", None),
        "cardmarket_products": getattr(card, "cardmarket_products", None),
        "retreat": getattr(card, "retreat", None),
        "playable_fingerprint": getattr(card, "playable_fingerprint", None),
        "images_small": card.images_small,
        "images_large": card.images_large,
        "image_source_lang": getattr(card, "image_source_lang", None),
        "data_source_lang": getattr(card, "data_source_lang", None),
        "custom_image_url": getattr(card, "custom_image_url", None),
        "is_custom": card.is_custom or False,
        "custom_owner_id": getattr(card, "custom_owner_id", None) if is_custom_owner else None,
        "custom_owner_username": (
            getattr(getattr(card, "custom_owner", None), "username", None)
            if is_custom_owner else None
        ),
        "is_custom_owner": is_custom_owner,
        "is_shared_template": bool(getattr(card, "is_shared_template", False)),
        "is_digital": card.is_digital or False,
        "lang": card.lang or "en",
        "price_market": card.price_market,
        "price_low": card.price_low,
        "price_trend": card.price_trend,
        "price_avg1": card.price_avg1,
        "price_avg7": card.price_avg7,
        "price_avg30": card.price_avg30,
        # Holo prices (may be None if not yet synced)
        "price_market_holo": getattr(card, 'price_market_holo', None),
        "price_low_holo": getattr(card, 'price_low_holo', None),
        "price_trend_holo": getattr(card, 'price_trend_holo', None),
        "price_avg1_holo": getattr(card, 'price_avg1_holo', None),
        "price_avg7_holo": getattr(card, 'price_avg7_holo', None),
        "price_avg30_holo": getattr(card, 'price_avg30_holo', None),
        # TCGPlayer
        "price_tcg_normal_market": getattr(card, 'price_tcg_normal_market', None),
        "price_tcg_reverse_market": getattr(card, 'price_tcg_reverse_market', None),
        "price_tcg_holo_market": getattr(card, 'price_tcg_holo_market', None),
        "price_source_lang": getattr(card, "price_source_lang", None),
        "variants_normal": getattr(card, "variants_normal", None),
        "variants_reverse": getattr(card, "variants_reverse", None),
        "variants_holo": getattr(card, "variants_holo", None),
        "variants_first_edition": getattr(card, "variants_first_edition", None),
    }


def _with_collection_summary(db: Session, current_user: User, card_dicts: List[dict]) -> List[dict]:
    """Attach collector-scoped tile state; keep rows only for existing action modals."""
    if not card_dicts:
        return card_dicts

    card_ids = [card["id"] for card in card_dicts]
    items = db.query(CollectionItem).filter(
        CollectionItem.user_id == current_user.id,
        CollectionItem.card_id.in_(card_ids),
    ).all()
    annotate_product_sources(db, current_user, items)
    summaries = card_state_summaries(
        db,
        current_user.id,
        card_ids,
        collection_items=items,
    )
    by_card: dict[str, list[CollectionItem]] = {}
    for item in items:
        by_card.setdefault(item.card_id, []).append(item)
    for card in card_dicts:
        card.update(summaries.get(card.get("id"), {}))
        # CardModal edits exact rows, so retain this existing action payload.
        card["owned_items"] = [
            {
                "id": item.id,
                "quantity": item.quantity,
                "condition": item.condition,
                "variant": item.variant,
                "printing_details": [tag.name for tag in item.printing_detail_tags],
                "lang": item.lang,
                "purchase_price": item.purchase_price,
                "product_sources": item.product_sources,
            }
            for item in by_card.get(card.get("id"), [])
        ]
    return card_dicts

def _schedule_search_page_metadata_enrichment(
    background_tasks: BackgroundTasks | None,
    cards: List[Card],
) -> None:
    """Schedule eligible search results without delaying the search response."""
    if background_tasks is None or not cards:
        return
    card_ids = [
        card.id
        for card in cards
        if card_needs_metadata_enrichment(card)
    ][:METADATA_ENRICHMENT_PER_SEARCH_PAGE]
    if card_ids:
        background_tasks.add_task(enrich_card_metadata_ids_in_background, card_ids)


def _owned_card_exists(db: Session, user_id: int):
    """EXISTS predicate: this user owns at least one row of the card."""
    return (
        db.query(CollectionItem.id)
        .filter(
            CollectionItem.user_id == user_id,
            CollectionItem.card_id == Card.id,
            CollectionItem.quantity > 0,
        )
        .exists()
    )


def _owned_card_ids(db: Session, user_id: int, card_ids: List[str]) -> set[str]:
    """Owned card ids among ``card_ids``, queried in bounded IN chunks."""
    owned: set[str] = set()
    unique_ids = list(dict.fromkeys(card_id for card_id in card_ids if card_id))
    for start in range(0, len(unique_ids), 5000):
        chunk = unique_ids[start:start + 5000]
        rows = db.query(CollectionItem.card_id).filter(
            CollectionItem.user_id == user_id,
            CollectionItem.card_id.in_(chunk),
            CollectionItem.quantity > 0,
        ).distinct().all()
        owned.update(card_id for (card_id,) in rows if card_id)
    return owned


_ARTIST_LANG_ORDER = {"en": 0, "de": 1, "ja": 2}


def _artist_lang_rank(lang: str | None) -> tuple:
    """Stable language ordering: en, de, ja, then other codes alphabetically."""
    code = normalize_tcgdex_language(lang or "en")
    if code in _ARTIST_LANG_ORDER:
        return (_ARTIST_LANG_ORDER[code], "")
    return (3, code)


def _pick_artist_representative(
    printings: List[dict], specific_lang: str | None, display_lang: str
) -> dict:
    """Choose the card row that represents a grouped card identity."""
    if specific_lang:
        return printings[0]
    for preferred in (display_lang, "en", "ja"):
        for printing in printings:
            if printing["lang"] == preferred:
                return printing
    return printings[0]


def _artist_index_representative_price(
    printings: dict[str, float | None], display_lang: str
) -> float | None:
    """Market price of the first printing that has one.

    Mirrors the artist checklist: display language, then ``en``, then ``ja``,
    then any language in canonical order. Printings without a price are
    skipped so an unpriced preferred printing does not hide a priced one.
    """
    for preferred in (display_lang, "en", "ja"):
        if printings.get(preferred) is not None:
            return printings[preferred]
    fallback_lang = min(
        (code for code in printings if printings[code] is not None),
        key=lambda code: (_artist_lang_rank(code), code),
        default=None,
    )
    return printings[fallback_lang] if fallback_lang is not None else None


def _empty_artist_index(page: int, page_size: int) -> dict:
    return {
        "artists": [],
        "total_count": 0,
        "page": page,
        "page_size": page_size,
        "languages": [],
    }


def _empty_artist_checklist(
    artist_query: str, page: int, page_size: int
) -> dict:
    return {
        "artist_query": artist_query,
        "artists": [],
        "total_count": 0,
        "owned_count": 0,
        "list_count": 0,
        "progress": 0,
        "missing_value": 0,
        "page": page,
        "page_size": page_size,
        "languages": [],
        "cards": [],
    }


def _search_by_code_number(
    db: Session,
    current_user: User,
    set_code: str,
    card_number: str,
    page: int,
    page_size: int,
    lang: str = "all",
    ownership: str | None = None,
    background_tasks: BackgroundTasks | None = None,
    rule_text: str | None = None,
) -> dict | None:
    """Search for a card by set abbreviation/id + card number (localId).
    Returns cards for ALL languages unless lang is specified.

    Returns None when the set code does not resolve to any set. Callers then
    fall back to a name search, so a card whose name looks like a code-number
    pair stays reachable. An empty result with a resolved set is final: the
    set code was understood, so only that set may answer the query.
    """
    set_code_upper = set_code.upper()

    def query_matching_sets() -> list[Set]:
        filters = [
            (func.upper(Set.abbreviation) == set_code_upper) |
            (func.upper(Set.id) == set_code_upper) |
            (func.upper(Set.tcg_set_id) == set_code_upper),
            visible_set_filter(db, current_user.id, lang),
        ]
        return db.query(Set).filter(*filters).all()

    # 1. Find all matching set objects across synced languages, or the requested language.
    set_objs = query_matching_sets()

    if not set_objs:
        # Fall back to live TCGdex API to find the set by abbreviation. When a
        # specific language is requested, only fetch that language so a local EN
        # or DE set does not prevent FR/JA/etc. code-number lookup from working.
        try:
            active_languages = get_configured_sync_languages(db)
            if lang != "all" and lang not in set(active_languages):
                return None
            api_languages = [lang] if lang != "all" else active_languages
            api_sets = pokemon_api.get_all_sets(languages=api_languages, include_digital=digital_sets_enabled(db))
            for api_set in api_sets:
                abbr_obj = api_set.get("abbreviation") or {}
                official = (
                    abbr_obj.get("official") if isinstance(abbr_obj, dict) else None
                )
                if official and official.upper() == set_code_upper:
                    parsed_set = pokemon_api.parse_set_for_db(api_set)
                    parsed_set["lang"] = api_set.get("_lang", "en")
                    existing_set = db.query(Set).filter(Set.id == parsed_set["id"]).first()
                    if existing_set:
                        for k, v in parsed_set.items():
                            if k != "id" and v is not None:
                                setattr(existing_set, k, v)
                        set_obj = existing_set
                    else:
                        set_obj = Set(**parsed_set)
                        db.add(set_obj)
                    db.commit()
                    db.refresh(set_obj)
            set_objs = query_matching_sets()
        except Exception:
            pass

    if not set_objs:
        # The code matches no known set, so it cannot be a set reference.
        return None

    # Collect unique TCGdex set IDs
    tcg_set_ids = list({s.tcg_set_id or s.id for s in set_objs})

    normalized_rule_text = normalize_search_term(rule_text)

    def query_matching_cards(*, apply_rule_text: bool = True) -> list[Card]:
        filters = [
            Card.set_id.in_(tcg_set_ids),
            visible_card_filter(db, current_user.id, lang),
            card_number_filter(Card.number, card_number),
        ]
        query = db.query(Card).filter(*filters)
        if apply_rule_text and normalized_rule_text:
            query = query.filter(or_(
                accent_insensitive_contains(db, Card.card_effect, normalized_rule_text),
                json_array_text_matches(db, Card.attacks, ("name", "effect"), normalized_rule_text),
                json_array_text_matches(db, Card.abilities, ("name", "effect"), normalized_rule_text),
            ))
        return query.order_by(Card.id.asc()).all()

    # 2. Look for cards in DB matching any of those set IDs and the given number.
    # Numeric card numbers are compared without leading zeros so 44 and 044 match.
    # Check whether the exact card is already local without applying the
    # optional text predicate. A local card that simply does not match the
    # rule text must not trigger an unnecessary live whole-set refresh.
    cards = query_matching_cards(apply_rule_text=False)

    # 3. Card not in DB — fetch from TCGdex and cache. If the requested
    # language has only set metadata but no cards yet, create target-language
    # fallback rows from the sibling language so exact add/search still works.
    if not cards:
        for set_obj in set_objs:
            tcg_set_id = set_obj.tcg_set_id or set_obj.id
            set_lang = set_obj.lang or "en"
            try:
                set_data = pokemon_api.get_set_cards(tcg_set_id, lang=set_lang)
                for card_data in set_data.get("cards", []):
                    parsed = pokemon_api.parse_card_for_db(card_data, default_set_id=tcg_set_id, lang=set_lang)
                    parsed = apply_cross_language_fallbacks(db, parsed)
                    upsert_card(db, parsed, partial=True)
                db.commit()
            except Exception:
                db.rollback()

            if db.query(Card).filter(Card.set_id == tcg_set_id, Card.lang == set_lang).count() == 0:
                fallback_lang = other_supported_lang(set_lang)
                if fallback_lang:
                    try:
                        fallback_data = pokemon_api.get_set_cards(tcg_set_id, lang=fallback_lang)
                        for card_data in fallback_data.get("cards", []):
                            parsed = clone_card_for_missing_language(
                                db,
                                card_data,
                                target_lang=set_lang,
                                source_lang=fallback_lang,
                                default_set_id=tcg_set_id,
                            )
                            if not parsed:
                                continue
                            upsert_card(db, parsed, partial=True)
                        db.commit()
                    except Exception:
                        db.rollback()

        cards = query_matching_cards(apply_rule_text=False)

    if cards and normalized_rule_text:
        cards = query_matching_cards()

    if not cards:
        return {
            "data": [],
            "total_count": 0,
            "owned_count": 0,
            "page": page,
            "page_size": page_size,
        }

    owned_ids = _owned_card_ids(db, current_user.id, [card.id for card in cards])
    if ownership == "owned":
        cards = [card for card in cards if card.id in owned_ids]
    elif ownership == "missing":
        cards = [card for card in cards if card.id not in owned_ids]
    owned_count = sum(1 for card in cards if card.id in owned_ids)

    start = (page - 1) * page_size
    page_cards = cards[start:start + page_size]
    _schedule_search_page_metadata_enrichment(background_tasks, page_cards)
    card_dicts = _with_collection_summary(db, current_user, [_card_to_dict(c, current_user.id) for c in page_cards])
    return {
        "data": card_dicts,
        "total_count": len(cards),
        "owned_count": owned_count,
        "page": page,
        "page_size": page_size,
    }


@router.post("/custom")
def create_custom_card(
    data: CardCustomCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a card manually (not from TCGdex API)."""
    # Custom IDs must be collision-safe across every user and template clone.
    card_id = f"custom-{uuid4().hex}"
    image_url = (data.image_url or "").strip()
    if image_url:
        try:
            image_url = validate_public_https_image_url(image_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Derive language from the set if not explicitly provided
    card_lang = data.lang
    if not card_lang and data.set_id:
        existing_set = db.query(Set).filter(
            (Set.tcg_set_id == data.set_id) | (Set.id == data.set_id)
        ).first()
        if existing_set:
            card_lang = existing_set.lang
    card_lang = card_lang or "en"

    # Ensure set record exists if set_id given
    if data.set_id:
        existing_set = db.query(Set).filter(
            (Set.tcg_set_id == data.set_id) | (Set.id == data.set_id)
        ).first()
        if not existing_set:
            db.add(Set(id=data.set_id, name=data.set_id, total=0, tcg_set_id=data.set_id, lang=card_lang))

    # image_url is stored as images_small and images_large (unchanged, not TCGdex)
    card = Card(
        id=card_id,
        name=data.name,
        set_id=data.set_id or None,
        number=data.number or None,
        rarity=data.rarity or None,
        types=data.types or None,
        hp=data.hp or None,
        artist=data.artist or None,
        images_small=image_url or None,
        images_large=image_url or None,
        is_custom=True,
        custom_owner_id=current_user.id,
        is_shared_template=data.is_shared_template,
        lang=card_lang,
    )
    db.add(card)
    try:
        db.commit()
        db.refresh(card)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return _card_to_dict(card, current_user.id)


@router.put("/custom/{card_id}", response_model=CardBase)
def update_custom_card(
    card_id: str,
    update: CustomCardUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an existing custom card's fields."""
    card = db.query(Card).filter(Card.id == card_id, Card.is_custom == True).first()
    if not card:
        raise HTTPException(status_code=404, detail="Custom card not found")
    if card.custom_owner_id != current_user.id:
        if not card.is_shared_template:
            raise HTTPException(status_code=404, detail="Custom card not found")
        raise HTTPException(status_code=403, detail="Only the owner can edit this custom card")
    update_data = update.model_dump(exclude_unset=True)
    # image_url maps to images_small and images_large on the model
    if "image_url" in update_data:
        img = (update_data.pop("image_url") or "").strip()
        if img:
            try:
                img = validate_public_https_image_url(img)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        if img != (card.images_small or "") or img != (card.images_large or ""):
            db.query(ImageCache).filter(
                ImageCache.image_key.like(f"card:{card_id}:%")
            ).delete(synchronize_session=False)
        card.images_small = img
        card.images_large = img
    if update_data.get("is_shared_template") is None:
        update_data.pop("is_shared_template", None)
    for field, value in update_data.items():
        setattr(card, field, value)
    db.commit()
    db.refresh(card)
    return _card_to_dict(card, current_user.id)


@router.delete("/custom/{card_id}")
def delete_custom_card(
    card_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a custom card and all related records."""
    card = db.query(Card).filter(Card.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    if not card.is_custom:
        raise HTTPException(status_code=400, detail="Card is not custom")
    if card.custom_owner_id != current_user.id:
        if not card.is_shared_template:
            raise HTTPException(status_code=404, detail="Card not found")
        raise HTTPException(status_code=403, detail="Only the owner can delete this custom card")

    other_user_references = set(
        user_id for (user_id,) in db.query(CollectionItem.user_id).filter(
            CollectionItem.card_id == card_id,
            CollectionItem.user_id != current_user.id,
        ).distinct().all()
    )
    other_user_references.update(
        user_id for (user_id,) in db.query(WishlistItem.user_id).filter(
            WishlistItem.card_id == card_id,
            WishlistItem.user_id != current_user.id,
        ).distinct().all()
    )
    other_user_references.update(
        user_id for (user_id,) in db.query(Binder.user_id).join(
            BinderCard, BinderCard.binder_id == Binder.id
        ).filter(
            BinderCard.card_id == card_id,
            Binder.user_id.isnot(None),
            Binder.user_id != current_user.id,
        ).distinct().all()
    )
    for model in (ProductCard, ProductLedgerEntry, TradeItem):
        other_user_references.update(
            user_id for (user_id,) in db.query(model.user_id).filter(
                model.card_id == card_id,
                model.user_id != current_user.id,
            ).distinct().all()
        )
    if other_user_references:
        usernames = [
            username for (username,) in db.query(User.username).filter(
                User.id.in_(other_user_references)
            ).order_by(User.username.asc()).all()
        ]
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This custom card is still referenced by other users and cannot be deleted.",
                "users": usernames,
            },
        )

    active_product_links = db.query(ProductCard).filter(
        ProductCard.card_id == card_id,
        ProductCard.active_quantity > 0,
    ).count()
    if active_product_links:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a custom card while it is actively linked to a product. Unlink or trade/sell the linked copy first.",
        )

    try:
        db.query(CollectionItem).filter(CollectionItem.card_id == card_id).delete(synchronize_session=False)
        db.query(WishlistItem).filter(WishlistItem.card_id == card_id).delete(synchronize_session=False)
        db.query(BinderCard).filter(BinderCard.card_id == card_id).delete(synchronize_session=False)
        db.query(PriceHistory).filter(PriceHistory.card_id == card_id).delete(synchronize_session=False)
        db.query(CustomCardMatch).filter(CustomCardMatch.custom_card_id == card_id).delete(synchronize_session=False)
        db.query(ImageCache).filter(
            ImageCache.image_key.like(f"card:{card_id}:%")
        ).delete(synchronize_session=False)
        db.query(ProductCard).filter(ProductCard.card_id == card_id).update({"card_id": None}, synchronize_session=False)
        db.query(ProductLedgerEntry).filter(ProductLedgerEntry.card_id == card_id).update({"card_id": None}, synchronize_session=False)
        db.query(TradeItem).filter(TradeItem.card_id == card_id).update({"card_id": None}, synchronize_session=False)
        db.delete(card)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"message": "Custom card deleted"}


@router.get("/custom", response_model=List[CardBase])
def list_custom_cards(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the current user's cards and templates shared by other users."""
    cards = db.query(Card).filter(
        visible_custom_card_filter(current_user.id)
    ).order_by(Card.updated_at.desc(), Card.id.desc()).all()
    return [_card_to_dict(c, current_user.id) for c in cards]


@router.post("/custom/{card_id}/clone", response_model=CardBase)
def clone_custom_card(
    card_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create an independent, private copy of a shared custom-card template."""
    source = db.query(Card).filter(Card.id == card_id, Card.is_custom == True).first()
    if not source or not source.is_shared_template:
        raise HTTPException(status_code=404, detail="Shared custom-card template not found")
    if source.custom_owner_id == current_user.id:
        raise HTTPException(status_code=400, detail="You already own this custom card")

    excluded = {
        "id",
        "custom_owner_id",
        "is_shared_template",
        "custom_source_card_id",
        "updated_at",
    }
    values = {
        column.name: getattr(source, column.name)
        for column in Card.__table__.columns
        if column.name not in excluded
    }
    clone = Card(
        **values,
        id=f"custom-{uuid4().hex}",
        custom_owner_id=current_user.id,
        is_shared_template=False,
        custom_source_card_id=source.id,
    )
    db.add(clone)
    db.commit()
    db.refresh(clone)
    return _card_to_dict(clone, current_user.id)


@router.get("/search")
def search_cards(
    q: Optional[str] = None,
    name: Optional[str] = None,
    number: Optional[str] = None,
    set_id: Optional[str] = None,
    type_filter: Optional[str] = Query(None, alias="type"),
    category: Optional[str] = None,
    subtype: Optional[str] = None,
    rarity: Optional[str] = None,
    artist: Optional[str] = None,
    rule_text: Optional[str] = None,
    hp_min: Optional[int] = None,
    hp_max: Optional[int] = None,
    dex_id: Optional[int] = Query(None, ge=1, le=1025),
    pokedex_entry_id: Optional[str] = Query(None, pattern=r"^[1-9]\d{0,3}(?::[a-z]+(?:-[xyz])?)?$"),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    page: int = 1,
    page_size: int = 20,
    lang: Optional[str] = Query(None, description="Language filter: supported TCGdex language code or 'all'"),
    ownership: Optional[str] = Query(None, description="Ownership filter: 'owned' or 'missing'"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = None,
):
    """Search cards from the local DB.

    Special patterns supported:
    - "MEP 022" or "sv08 032" → set abbreviation/id + card number search
    - q is the preferred free-text parameter; name remains a compatible alias
    - number uses the same leading-zero and alphanumeric matching as exact lookup
    - lang: supported TCGdex language code or "all" for all languages
    - ownership: "owned" or "missing" filters on this user's collection
    """
    requested_lang = normalize_tcgdex_language(lang or get_tcgdex_display_language(db, current_user.id))
    search_lang = requested_lang if is_supported_tcgdex_language(requested_lang) else "all"
    search_term = normalize_search_term(q) or normalize_search_term(name)
    ownership_value = normalize_search_term(ownership).lower() if isinstance(ownership, str) else ""
    if ownership_value not in {"", "owned", "missing"}:
        raise HTTPException(status_code=400, detail="ownership must be 'owned' or 'missing'")

    try:
        # ── Code + number pattern: "MEP 022", "SSP 136", "sv08 032", "30C 001" ─
        if search_term:
            m = _CODE_NUMBER_RE.match(search_term)
            if m:
                set_code = m.group(1)
                card_number = m.group(2)
                code_result = _search_by_code_number(
                    db,
                    current_user,
                    set_code,
                    card_number,
                    page,
                    page_size,
                    lang=search_lang,
                    ownership=ownership_value or None,
                    background_tasks=background_tasks,
                    rule_text=rule_text,
                )
                if code_result is not None:
                    return code_result
                # The code resolved to no set, so the term is not a set
                # reference. Continue with the name search below, which keeps
                # card names such as "151 025" reachable.

        # ── Pure DB search ────────────────────────────────────────────────────
        query = db.query(Card).filter(Card.is_custom == False, visible_card_filter(db, current_user.id, search_lang))

        if search_term:
            query = query.filter(accent_insensitive_contains(db, Card.name, search_term))

        if set_id:
            # set_id may be composite DB key (sv1_en) or original tcg id (sv1)
            set_obj = db.query(Set).filter(
                ((Set.id == set_id) | (Set.tcg_set_id == set_id)),
                visible_set_filter(db, current_user.id, search_lang),
            ).first()
            if set_obj:
                query = query.filter(Card.set_id == (set_obj.tcg_set_id or set_obj.id))
            elif has_lang_suffix(set_id):
                query = query.filter(False)
            else:
                query = query.filter(Card.set_id == set_id)

        normalized_number = normalize_search_term(number)
        if normalized_number:
            query = query.filter(card_number_filter(Card.number, normalized_number))

        if type_filter:
            query = query.filter(accent_insensitive_contains(db, cast(Card.types, String), type_filter))

        if category:
            query = query.filter(accent_insensitive_contains(db, Card.supertype, category))

        if subtype:
            query = query.filter(or_(
                accent_insensitive_contains(db, Card.trainer_type, subtype),
                accent_insensitive_contains(db, Card.energy_type, subtype),
                accent_insensitive_contains(db, Card.stage, subtype),
                accent_insensitive_contains(db, Card.suffix, subtype),
                accent_insensitive_contains(db, cast(Card.subtypes, String), subtype),
            ))

        if rarity:
            query = query.filter(accent_insensitive_contains(db, Card.rarity, rarity))

        if artist:
            query = query.filter(accent_insensitive_contains(db, Card.artist, artist))

        rule_text = normalize_search_term(rule_text)
        if rule_text:
            query = query.filter(or_(
                accent_insensitive_contains(db, Card.card_effect, rule_text),
                json_array_text_matches(db, Card.attacks, ("name", "effect"), rule_text),
                json_array_text_matches(db, Card.abilities, ("name", "effect"), rule_text),
            ))

        if hp_min is not None:
            query = query.filter(cast(Card.hp, Integer) >= hp_min)

        if hp_max is not None:
            query = query.filter(cast(Card.hp, Integer) <= hp_max)

        if isinstance(dex_id, int):
            query = query.filter(Card.dex_ids.op("@>")(cast([dex_id], JSONB)))

        exact_pokedex_entry_id = None
        if isinstance(pokedex_entry_id, str) and pokedex_entry_id:
            pokedex_entry = get_pokedex_entry(pokedex_entry_id)
            if not pokedex_entry:
                query = query.filter(False)
            else:
                exact_pokedex_entry_id = pokedex_entry["entry_id"]
                if db.bind and db.bind.dialect.name == "postgresql":
                    stored_match = Card.pokedex_entry_ids.op("@>")(cast([exact_pokedex_entry_id], JSONB))
                    fallback_match = and_(
                        Card.pokedex_entry_ids.is_(None),
                        Card.dex_ids.op("@>")(cast([int(pokedex_entry["dex_id"])], JSONB)),
                    )
                    query = query.filter(or_(stored_match, fallback_match))
                # SQLite is used by tests and small local tools. Its JSON type
                # can persist Python None as JSON ``null`` rather than SQL
                # NULL, so let the shared classifier post-filter the visible
                # rows instead of relying on dialect-specific JSON matching.

        owned_exists = _owned_card_exists(db, current_user.id)
        if ownership_value == "owned":
            query = query.filter(owned_exists)
        elif ownership_value == "missing":
            query = query.filter(not_(owned_exists))

        if sort_by == "name":
            col = Card.name
        elif sort_by == "number":
            col = Card.number
        elif sort_by == "rarity":
            col = Card.rarity
        elif sort_by == "price_low":
            col = Card.price_low
        elif sort_by == "price_market":
            col = Card.price_market
        else:
            col = Card.name

        if sort_order == "desc":
            query = query.order_by(col.desc())
        else:
            query = query.order_by(col.asc())

        if exact_pokedex_entry_id:
            matching_cards = [
                card for card in query.all()
                if exact_pokedex_entry_id in card_pokedex_entry_ids(
                    name=card.name,
                    dex_ids=card.dex_ids,
                    stored_entry_ids=card.pokedex_entry_ids,
                    supertype=card.supertype,
                    tcg_card_id=card.tcg_card_id,
                )
            ]
            total_count = len(matching_cards)
            start = (page - 1) * page_size
            cards = matching_cards[start:start + page_size]
            if ownership_value == "owned":
                owned_count = total_count
            elif ownership_value == "missing":
                owned_count = 0
            else:
                matching_owned_ids = _owned_card_ids(
                    db, current_user.id, [card.id for card in matching_cards]
                )
                owned_count = sum(
                    1 for card in matching_cards if card.id in matching_owned_ids
                )
        else:
            total_count = query.count()
            cards = query.offset((page - 1) * page_size).limit(page_size).all()
            if ownership_value == "owned":
                owned_count = total_count
            elif ownership_value == "missing":
                owned_count = 0
            else:
                owned_count = query.filter(owned_exists).count()

        _schedule_search_page_metadata_enrichment(background_tasks, cards)
        card_dicts = _with_collection_summary(
            db,
            current_user,
            [_card_to_dict(c, current_user.id) for c in cards],
        )

        return {
            "data": card_dicts,
            "total_count": total_count,
            "owned_count": owned_count,
            "page": page,
            "page_size": page_size,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/artist-checklist")
def artist_checklist(
    artist: str = Query(..., min_length=1, description="Artist name substring"),
    lang: Optional[str] = Query("all", description="Language filter: supported TCGdex language code or 'all'"),
    ownership: Optional[str] = Query(None, description="Ownership filter: 'owned' or 'missing'"),
    page: int = 1,
    page_size: int = 60,
    sort_by: str = "number",
    sort_order: str = "asc",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Artist completion checklist grouped by card identity across printings.

    Cards sharing a ``tcg_card_id`` (or the bare id for rows without one) are
    one checklist entry. Ownership is aggregated across every visible printing
    unless a specific language narrows participation to that language's rows.
    """
    artist_query = normalize_search_term(artist)
    ownership_value = normalize_search_term(ownership).lower()
    if not artist_query or len(artist_query) > 100:
        raise HTTPException(status_code=400, detail="artist must be 1..100 characters")
    if ownership_value not in {"", "owned", "missing"}:
        raise HTTPException(status_code=400, detail="ownership must be 'owned' or 'missing'")
    if sort_by not in {"number", "name", "price"}:
        raise HTTPException(status_code=400, detail="sort_by must be one of: number, name, price")
    if sort_order not in {"asc", "desc"}:
        raise HTTPException(status_code=400, detail="sort_order must be 'asc' or 'desc'")
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)

    requested_lang = normalize_tcgdex_language(lang or "all")
    search_lang = requested_lang if is_supported_tcgdex_language(requested_lang) else "all"
    specific_lang = search_lang if search_lang != "all" else None
    display_lang = get_tcgdex_display_language(db, current_user.id)

    try:
        artist_clause = accent_insensitive_contains(db, Card.artist, artist_query)
        if artist_clause is None:
            return _empty_artist_checklist(artist_query, page, page_size)

        # Phase 1: lightweight rows only. A prolific artist can match thousands
        # of cards, so full ORM rows are deferred to the current page.
        rows = (
            db.query(
                Card.id,
                Card.tcg_card_id,
                Card.lang,
                Card.number,
                Card.set_id,
                Card.artist,
                Card.price_market,
                Card.name,
            )
            .filter(
                Card.is_custom == False,
                visible_card_filter(db, current_user.id, search_lang),
                artist_clause,
            )
            .all()
        )
        if not rows:
            return _empty_artist_checklist(artist_query, page, page_size)

        set_ids = {row.set_id for row in rows if row.set_id}
        set_rows = (
            db.query(Set.tcg_set_id, Set.lang, Set.name, Set.release_date)
            .filter(Set.tcg_set_id.in_(set_ids))
            .all()
            if set_ids else []
        )
        set_by_lang: dict[tuple[str, str], tuple[str | None, str | None]] = {}
        set_fallback: dict[str, tuple[tuple, str | None, str | None]] = {}
        for tcg_set_id, set_lang, set_name, release_date in set_rows:
            if not tcg_set_id:
                continue
            normalized_set_lang = normalize_tcgdex_language(set_lang or "en")
            set_by_lang.setdefault(
                (tcg_set_id, normalized_set_lang), (set_name, release_date)
            )
            rank = _artist_lang_rank(set_lang)
            current = set_fallback.get(tcg_set_id)
            if current is None or rank < current[0]:
                set_fallback[tcg_set_id] = (rank, set_name, release_date)

        summaries = card_state_summaries(db, current_user.id, [row.id for row in rows])

        def set_meta(set_id: str | None, row_lang: str | None):
            if not set_id:
                return None, None
            meta = set_by_lang.get(
                (set_id, normalize_tcgdex_language(row_lang or "en"))
            )
            if meta is not None:
                return meta
            fallback = set_fallback.get(set_id)
            if fallback is not None:
                return fallback[1], fallback[2]
            return None, None

        groups: dict[str, dict] = {}
        for row in rows:
            row_lang = normalize_tcgdex_language(row.lang or "en")
            group_key = row.tcg_card_id or strip_lang_suffix(row.id)[0]
            group = groups.get(group_key)
            if group is None:
                group = {
                    "key": group_key,
                    "printings": [],
                    "artists": set(),
                    "owned_quantity": 0,
                    "variant_totals": {},
                }
                groups[group_key] = group

            summary = summaries.get(row.id, {})
            row_quantity = summary.get("owned_quantity", 0)
            row_variants = {
                item["variant"]: item["quantity"]
                for item in summary.get("owned_variants", [])
            }
            for variant, amount in row_variants.items():
                group["variant_totals"][variant] = (
                    group["variant_totals"].get(variant, 0) + amount
                )
            group["owned_quantity"] += row_quantity
            if row.artist:
                group["artists"].add(row.artist)

            group["printings"].append({
                "id": row.id,
                "tcg_card_id": row.tcg_card_id,
                "lang": row_lang,
                "number": row.number,
                "set_id": row.set_id,
                "owned": row_quantity > 0,
                "owned_quantity": row_quantity,
                "owned_variants": summary.get("owned_variants", []),
                "wishlisted": summary.get("wishlisted", False),
                "price_market": row.price_market,
                "_name": row.name,
            })

        for group in groups.values():
            group["owned"] = group["owned_quantity"] > 0
            group["wishlisted"] = any(
                printing["wishlisted"] for printing in group["printings"]
            )
            group["printings"].sort(
                key=lambda printing: (
                    _artist_lang_rank(printing["lang"]),
                    natural_card_number_key(printing["number"]),
                    printing["id"],
                )
            )
            representative = _pick_artist_representative(
                group["printings"], specific_lang, display_lang
            )
            group["representative"] = representative
            set_name, release_date = set_meta(
                representative["set_id"], representative["lang"]
            )
            group["set_name"] = set_name
            group["set_release_date"] = release_date

        # Header statistics describe the whole artist scope; the ownership
        # filter only narrows the paginated list below.
        scope = list(groups.values())
        filtered = scope
        if ownership_value == "owned":
            filtered = [group for group in scope if group["owned"]]
        elif ownership_value == "missing":
            filtered = [group for group in scope if not group["owned"]]

        total_count = len(scope)
        owned_count = sum(1 for group in scope if group["owned"])
        list_count = len(filtered)
        progress = round(owned_count / total_count * 100, 1) if total_count else 0
        def representative_price(group: dict) -> float | None:
            """First priced printing, preferring the display language.

            The representative printing can lack a price while another
            language's printing has one; use that price rather than treating
            the whole card as priceless.
            """
            printings = group["printings"]
            for preferred in (display_lang, "en", "ja"):
                for printing in printings:
                    if printing["lang"] == preferred and printing["price_market"] is not None:
                        return printing["price_market"]
            for printing in sorted(
                printings, key=lambda item: (_artist_lang_rank(item["lang"]), item["id"])
            ):
                if printing["price_market"] is not None:
                    return printing["price_market"]
            return None

        missing_value = 0.0
        for group in scope:
            if group["owned"]:
                continue
            price = representative_price(group)
            if price is not None:
                missing_value += float(price)
        missing_value = round(missing_value, 2)
        languages = sorted({
            printing["lang"]
            for group in scope
            for printing in group["printings"]
        })
        artists = sorted({
            artist_name
            for group in scope
            for artist_name in group["artists"]
        })

        def number_sort_key(group: dict):
            representative = group["representative"]
            return (
                group["set_release_date"] or "",
                natural_card_number_key(representative["number"]),
                group["set_name"] or "",
                _artist_lang_rank(representative["lang"]),
                group["key"],
            )

        def number_primary_missing(group: dict) -> bool:
            return not group["set_release_date"]

        def price_sort_key(group: dict):
            representative = group["representative"]
            price = representative["price_market"]
            return (
                float(price) if price is not None else 0.0,
                group["set_release_date"] or "",
                natural_card_number_key(representative["number"]),
                group["set_name"] or "",
                _artist_lang_rank(representative["lang"]),
                group["key"],
            )

        def price_primary_missing(group: dict) -> bool:
            return group["representative"]["price_market"] is None

        def name_sort_key(group: dict):
            representative = group["representative"]
            return (
                (representative["_name"] or "").casefold(),
                group["set_release_date"] or "",
                natural_card_number_key(representative["number"]),
                group["set_name"] or "",
                _artist_lang_rank(representative["lang"]),
                group["key"],
            )

        reverse = sort_order == "desc"
        if sort_by == "name":
            ordered = sorted(filtered, key=name_sort_key, reverse=reverse)
        else:
            if sort_by == "price":
                sort_key = price_sort_key
                primary_missing = price_primary_missing
            else:
                sort_key = number_sort_key
                primary_missing = number_primary_missing
            present = [group for group in filtered if not primary_missing(group)]
            absent = [group for group in filtered if primary_missing(group)]
            present.sort(key=sort_key, reverse=reverse)
            absent.sort(key=sort_key, reverse=reverse)
            ordered = present + absent

        start_offset = (page - 1) * page_size
        page_groups = ordered[start_offset:start_offset + page_size]

        # Phase 2: full rows only for the representative and printings on this page.
        page_ids = list(dict.fromkeys(
            card_id
            for group in page_groups
            for card_id in (
                [group["representative"]["id"]]
                + [printing["id"] for printing in group["printings"]]
            )
        ))
        full_cards: dict[str, Card] = {}
        for start in range(0, len(page_ids), 5000):
            chunk = page_ids[start:start + 5000]
            for card in (
                db.query(Card)
                .options(joinedload(Card.set_ref))
                .filter(Card.id.in_(chunk))
                .all()
            ):
                full_cards[card.id] = card

        cards = []
        for group in page_groups:
            representative_card = full_cards.get(group["representative"]["id"])
            if representative_card is None:
                for printing in group["printings"]:
                    representative_card = full_cards.get(printing["id"])
                    if representative_card is not None:
                        break
            if representative_card is None:
                continue
            card_dict = _card_to_dict(representative_card, current_user.id)
            card_dict.update({
                "owned": group["owned"],
                "owned_quantity": group["owned_quantity"],
                "owned_variants": [
                    {"variant": variant, "quantity": group["variant_totals"][variant]}
                    for variant in CANONICAL_VARIANTS
                    if group["variant_totals"].get(variant, 0) > 0
                ],
                "wishlisted": group["wishlisted"],
                "set_name": (
                    group["set_name"]
                    or (card_dict.get("set_ref") or {}).get("name")
                ),
                "printings": [
                    {
                        key: value
                        for key, value in printing.items()
                        if not key.startswith("_")
                    }
                    for printing in group["printings"]
                ],
            })
            cards.append(card_dict)

        return {
            "artist_query": artist_query,
            "artists": artists,
            "total_count": total_count,
            "owned_count": owned_count,
            "list_count": list_count,
            "progress": progress,
            "missing_value": missing_value,
            "page": page,
            "page_size": page_size,
            "languages": languages,
            "cards": cards,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/artists")
def artists_index(
    q: Optional[str] = Query(None, description="Accent-insensitive artist name substring"),
    lang: Optional[str] = Query("all", description="Language filter: supported TCGdex language code or 'all'"),
    sort_by: str = "name",
    sort_order: str = "asc",
    page: int = 1,
    page_size: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Artist index: per-artist completion across card identities.

    Card identities are grouped exactly like the artist checklist (``tcg_card_id``
    or the bare id), so the counts here match the checklist page. Catalogue rows
    are read as lightweight columns and aggregated in Python; no ORM entities are
    loaded.
    """
    search_term = normalize_search_term(q)
    if sort_by not in {"name", "cards", "progress", "missing"}:
        raise HTTPException(
            status_code=400,
            detail="sort_by must be one of: name, cards, progress, missing",
        )
    if sort_order not in {"asc", "desc"}:
        raise HTTPException(status_code=400, detail="sort_order must be 'asc' or 'desc'")
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)

    requested_lang = normalize_tcgdex_language(lang or "all")
    search_lang = requested_lang if is_supported_tcgdex_language(requested_lang) else "all"
    display_lang = get_tcgdex_display_language(db, current_user.id)

    try:
        rows_query = db.query(
            Card.id,
            Card.tcg_card_id,
            Card.lang,
            Card.artist,
            Card.price_market,
        ).filter(
            Card.is_custom == False,
            visible_card_filter(db, current_user.id, search_lang),
            Card.artist.isnot(None),
            Card.artist != "",
        )
        if search_term:
            artist_clause = accent_insensitive_contains(db, Card.artist, search_term)
            if artist_clause is None:
                return _empty_artist_index(page, page_size)
            rows_query = rows_query.filter(artist_clause)

        rows = rows_query.all()
        if not rows:
            return _empty_artist_index(page, page_size)

        # One query for this user's owned printings; a user's collection is far
        # smaller than the catalogue, so no IN list over 54k card ids is needed.
        owned_ids = {
            card_id
            for (card_id,) in db.query(CollectionItem.card_id)
            .filter(
                CollectionItem.user_id == current_user.id,
                CollectionItem.quantity > 0,
            )
            .distinct()
            .all()
            if card_id
        }

        # artist -> identity -> {lang: market price of that printing}
        artist_cards: dict[str, dict[str, dict[str, float | None]]] = {}
        card_identity: dict[str, str] = {}
        scope_languages: set[str] = set()
        for card_id, tcg_card_id, row_lang, artist, price in rows:
            name = (artist or "").strip()
            if not name:
                continue
            identity = tcg_card_id or strip_lang_suffix(card_id)[0]
            lang_code = normalize_tcgdex_language(row_lang or "en")
            card_identity[card_id] = identity
            artist_cards.setdefault(name, {}).setdefault(identity, {}).setdefault(
                lang_code, price
            )
            scope_languages.add(lang_code)

        if not artist_cards:
            return _empty_artist_index(page, page_size)

        owned_identities = {
            identity for card_id, identity in card_identity.items() if card_id in owned_ids
        }

        artists: list[dict] = []
        for name, identities in artist_cards.items():
            total_count = len(identities)
            owned_count = sum(1 for identity in identities if identity in owned_identities)
            missing_count = total_count - owned_count
            missing_value = 0.0
            languages: set[str] = set()
            for identity, printings in identities.items():
                languages.update(printings)
                if identity in owned_identities:
                    continue
                price = _artist_index_representative_price(printings, display_lang)
                if price is not None:
                    missing_value += float(price)
            artists.append({
                "name": name,
                "total_count": total_count,
                "owned_count": owned_count,
                "missing_count": missing_count,
                "progress": (
                    round(owned_count / total_count * 100, 1) if total_count else 0.0
                ),
                "missing_value": round(missing_value, 2),
                "languages": sorted(languages),
            })

        # Sort by name first so ties keep an ascending, casefolded name order in
        # both directions (Python's sort is stable, including with reverse=True).
        artists.sort(key=lambda item: item["name"].casefold())
        if sort_by == "name":
            artists.sort(
                key=lambda item: item["name"].casefold(),
                reverse=sort_order == "desc",
            )
        else:
            primary_key = {
                "cards": "total_count",
                "progress": "progress",
                "missing": "missing_count",
            }[sort_by]
            artists.sort(
                key=lambda item: item[primary_key],
                reverse=sort_order == "desc",
            )

        total_count = len(artists)
        start_offset = (page - 1) * page_size
        page_artists = artists[start_offset:start_offset + page_size]

        return {
            "artists": page_artists,
            "total_count": total_count,
            "page": page,
            "page_size": page_size,
            "languages": sorted(scope_languages),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/custom/matches")
def get_custom_matches(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all pending custom card matches with details for preview."""
    matches = (
        db.query(CustomCardMatch)
        .join(Card, Card.id == CustomCardMatch.custom_card_id)
        .filter(
            CustomCardMatch.status == "pending",
            Card.custom_owner_id == current_user.id,
        )
        .order_by(CustomCardMatch.matched_at.desc())
        .all()
    )

    result = []
    for match in matches:
        custom_card = db.query(Card).filter(Card.id == match.custom_card_id).first()

        # Try to get the API card info from the local DB (look up by tcg_card_id since DB id is composite)
        api_card_info = None
        api_card = db.query(Card).filter(Card.tcg_card_id == match.api_card_id).first()
        if api_card:
            api_card_info = {
                "id": api_card.id,
                "name": api_card.name,
                "images_small": api_card.images_small,
                "images_large": api_card.images_large,
                "rarity": api_card.rarity,
                "number": api_card.number,
                "set_id": api_card.set_id,
            }

        result.append({
            "match_id": match.id,
            "status": match.status,
            "matched_at": match.matched_at.isoformat() if match.matched_at else None,
            "custom_card": _card_to_dict(custom_card, current_user.id) if custom_card else None,
            "api_card": api_card_info,
        })

    return result


@router.post("/custom/migrate/{match_id}")
def migrate_custom_card(
    match_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Migrate a custom card to its API equivalent.

    Steps:
    1. Load the API card and save/update it in the DB.
    2. Move all CollectionItems, WishlistItems, BinderCards from old custom_card_id → api_card_id.
    3. Delete the old custom Card.
    4. Set match status to 'migrated'.
    """
    match = db.query(CustomCardMatch).join(
        Card, Card.id == CustomCardMatch.custom_card_id
    ).filter(
        CustomCardMatch.id == match_id,
        Card.custom_owner_id == current_user.id,
    ).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "pending":
        raise HTTPException(status_code=400, detail=f"Match is already {match.status}")

    custom_card_id = match.custom_card_id
    api_card_id = match.api_card_id

    # Determine the language of the custom card for language-aware migration
    custom_card_obj = db.query(Card).filter(Card.id == custom_card_id).first()
    if not custom_card_obj or custom_card_obj.custom_owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Match not found")
    custom_lang = normalize_tcgdex_language((custom_card_obj.lang or "en") if custom_card_obj else "en")
    if not is_supported_tcgdex_language(custom_lang):
        custom_lang = "en"

    # 1. Fetch API card and upsert in DB
    try:
        api_data = pokemon_api.get_card(api_card_id, lang=custom_lang)
        fetch_lang = custom_lang
        if not api_data:
            for fallback_lang in english_fallback_languages(custom_lang):
                api_data = pokemon_api.get_card(api_card_id, lang=fallback_lang)
                if api_data:
                    fetch_lang = fallback_lang
                    break
        if not api_data:
            raise HTTPException(status_code=404, detail="API card not found on TCGdex")
        parsed = pokemon_api.parse_card_for_db(api_data, lang=fetch_lang)
        parsed = apply_cross_language_fallbacks(db, parsed)
        composite_api_card_id = parsed["id"]  # e.g. "sv1-1_en"

        # Ensure set record exists
        if parsed.get("set_id"):
            set_db_id = f"{parsed['set_id']}_{fetch_lang}"
            set_obj = db.query(Set).filter(Set.id == set_db_id).first()
            if set_obj and set_obj.is_digital and not digital_sets_enabled(db):
                raise HTTPException(status_code=404, detail="API card not found on TCGdex")
            if set_obj and set_obj.is_digital:
                parsed["is_digital"] = True
            if not set_obj:
                set_data = api_data.get("set") or {}
                if set_data:
                    set_data = {**set_data, "_lang": fetch_lang, "_db_key": set_db_id}
                    set_parsed = pokemon_api.parse_set_for_db(set_data)
                    if set_parsed.get("is_digital") and not digital_sets_enabled(db):
                        raise HTTPException(status_code=404, detail="API card not found on TCGdex")
                    set_parsed["lang"] = fetch_lang
                    db.add(Set(**set_parsed))
                else:
                    db.add(Set(id=set_db_id, tcg_set_id=parsed["set_id"], name=parsed["set_id"], total=0, lang=fetch_lang))

        # Upsert API card using composite ID
        existing_api_card = db.query(Card).filter(Card.id == composite_api_card_id).first()
        if existing_api_card:
            for k, v in parsed.items():
                if k != "id":
                    setattr(existing_api_card, k, v)
            existing_api_card.is_custom = False
        else:
            parsed["is_custom"] = False
            db.add(Card(**parsed))

        db.flush()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to load API card: {e}")

    # 2. Re-assign collection items
    try:
        with db.begin_nested():
            db.query(CollectionItem).filter(
                CollectionItem.card_id == custom_card_id
            ).update({"card_id": composite_api_card_id, "lang": custom_lang}, synchronize_session=False)
            db.flush()
    except IntegrityError:
        # If the API card already exists in collection with same variant/lang,
        # merge quantities onto the existing row and remove old custom rows.
        custom_items = db.query(CollectionItem).filter(
            CollectionItem.card_id == custom_card_id
        ).all()
        existing_items = db.query(CollectionItem).filter(
            CollectionItem.card_id == composite_api_card_id,
            CollectionItem.lang == custom_lang,
        ).all()
        existing_by_variant = {item.variant: item for item in existing_items}
        for item in custom_items:
            existing_item = existing_by_variant.get(item.variant)
            if existing_item:
                existing_item.quantity = (existing_item.quantity or 0) + (item.quantity or 0)
                if existing_item.purchase_price is None:
                    existing_item.purchase_price = item.purchase_price
                db.delete(item)
            else:
                item.card_id = composite_api_card_id
                item.lang = custom_lang
        db.flush()

    # 3. Re-assign wishlist items, preserving the per-user uniqueness model.
    custom_wishlist_items = db.query(WishlistItem).filter(
        WishlistItem.card_id == custom_card_id
    ).all()
    existing_wishlist_items = db.query(WishlistItem).filter(
        WishlistItem.card_id == composite_api_card_id
    ).all()
    existing_wishlist_by_user = {item.user_id: item for item in existing_wishlist_items}
    for custom_wishlist in custom_wishlist_items:
        existing_wishlist = existing_wishlist_by_user.get(custom_wishlist.user_id)
        if existing_wishlist:
            existing_wishlist.quantity = min(99, max(int(existing_wishlist.quantity or 1), 1) + max(int(custom_wishlist.quantity or 1), 1))
            if existing_wishlist.price_alert_above is None:
                existing_wishlist.price_alert_above = custom_wishlist.price_alert_above
            if existing_wishlist.price_alert_below is None:
                existing_wishlist.price_alert_below = custom_wishlist.price_alert_below
            if existing_wishlist.notified_at is None:
                existing_wishlist.notified_at = custom_wishlist.notified_at
            db.delete(custom_wishlist)
        else:
            custom_wishlist.card_id = composite_api_card_id
            existing_wishlist_by_user[custom_wishlist.user_id] = custom_wishlist
    db.flush()

    # 4. Re-assign binder cards. If the API card is already present in the same
    # binder slot, merge required quantities instead of dropping deck copies.
    custom_binder_cards = db.query(BinderCard).filter(
        BinderCard.card_id == custom_card_id
    ).order_by(BinderCard.id.asc()).all()
    for binder_card in custom_binder_cards:
        existing_query = db.query(BinderCard).filter(
            BinderCard.id != binder_card.id,
            BinderCard.binder_id == binder_card.binder_id,
            BinderCard.card_id == composite_api_card_id,
        )
        if binder_card.collection_item_id is None:
            existing_query = existing_query.filter(BinderCard.collection_item_id.is_(None))
        else:
            existing_query = existing_query.filter(BinderCard.collection_item_id == binder_card.collection_item_id)
        existing_binder_card = existing_query.order_by(BinderCard.id.asc()).first()
        if existing_binder_card:
            existing_binder_card.required_quantity = min(
                99,
                max(int(existing_binder_card.required_quantity or 1), 1)
                + max(int(binder_card.required_quantity or 1), 1),
            )
            db.delete(binder_card)
        else:
            binder_card.card_id = composite_api_card_id
    db.flush()

    # 5. Preserve private photos when the manual card becomes an official card.
    # If the owner already uploaded a photo for the official printing, keep
    # that established target photo rather than replacing it implicitly.
    custom_photos = db.query(CollectionCardPhoto).filter(
        CollectionCardPhoto.card_id == custom_card_id
    ).all()
    source_photo_owner_ids = {photo.user_id for photo in custom_photos}
    target_photo_owner_ids = set()
    if source_photo_owner_ids:
        target_photo_owner_ids = {
            user_id
            for (user_id,) in db.query(CollectionCardPhoto.user_id).filter(
                CollectionCardPhoto.card_id == composite_api_card_id,
                CollectionCardPhoto.user_id.in_(source_photo_owner_ids),
            ).all()
        }
    for custom_photo in custom_photos:
        if custom_photo.user_id in target_photo_owner_ids:
            db.delete(custom_photo)
        else:
            custom_photo.card_id = composite_api_card_id
            target_photo_owner_ids.add(custom_photo.user_id)
    db.flush()

    # 6. Update the match before deleting the old custom card so the FK no longer points at it
    match.custom_card_id = composite_api_card_id
    match.api_card_id = api_card_id
    match.status = "migrated"

    # 7. Delete the old custom card
    old_card = db.query(Card).filter(Card.id == custom_card_id).first()
    if old_card:
        db.delete(old_card)

    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Migration failed: {e}")

    return {"status": "migrated", "api_card_id": composite_api_card_id}


@router.post("/custom/dismiss/{match_id}")
def dismiss_custom_match(
    match_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Dismiss a custom card match (keep the manual card, ignore the API version)."""
    match = db.query(CustomCardMatch).join(
        Card, Card.id == CustomCardMatch.custom_card_id
    ).filter(
        CustomCardMatch.id == match_id,
        Card.custom_owner_id == current_user.id,
    ).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "pending":
        raise HTTPException(status_code=400, detail=f"Match is already {match.status}")
    custom_card = db.query(Card).filter(Card.id == match.custom_card_id).first()
    if not custom_card or custom_card.custom_owner_id != current_user.id:
        raise HTTPException(status_code=404, detail="Match not found")

    match.status = "dismissed"
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "dismissed"}


@router.get("/{card_id}/lang/{lang}")
def get_card_in_lang(
    card_id: str,
    lang: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Given a card_id (any language variant), find the equivalent card in the requested language.

    Strategy:
    1. Load the source card.
    2. Determine its original TCGdex set_id and number.
    3. Query for a card with the same set_id + number but lang = requested lang.
    4. If found, return it. If not, return the original card (fallback).
    """
    source = db.query(Card).filter(
        Card.id == card_id,
        visible_any_card_filter(db, current_user.id, "all"),
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Card not found")

    # Look for sibling card with same set_id + number but requested lang
    sibling = db.query(Card).filter(
        Card.set_id == source.set_id,
        Card.number == source.number,
        Card.lang == lang,
        Card.is_custom == False,
        visible_card_filter(db, current_user.id, lang),
    ).first()

    if sibling:
        return _card_to_dict(sibling, current_user.id)

    # Fallback: return original card
    return _card_to_dict(source, current_user.id)


@router.get("/{card_id}/price-history", response_model=List[PriceHistoryResponse])
def get_price_history(
    card_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get price history for a specific card."""
    card = db.query(Card.id).filter(
        Card.id == card_id,
        visible_any_card_filter(db, current_user.id, "all"),
    ).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    history = (
        db.query(PriceHistory)
        .filter(PriceHistory.card_id == card_id)
        .order_by(PriceHistory.date.asc())
        .all()
    )
    return history


@router.put("/{card_id}/custom-image", response_model=CardBase)
def update_card_custom_image(
    card_id: str,
    update: CardCustomImageUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set or clear a manual image URL for API cards that have no TCGdex image yet."""
    card = db.query(Card).filter(
        Card.id == card_id,
        visible_card_filter(db, current_user.id, "all"),
    ).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    if card.is_custom:
        raise HTTPException(status_code=400, detail="Use the custom card editor for manually created cards")

    custom_cache_keys = [
        f"card:{card_id}:small:custom",
        f"card:{card_id}:large:custom",
    ]
    if card.images_small or card.images_large:
        if card.custom_image_url:
            card.custom_image_url = None
            db.query(ImageCache).filter(ImageCache.image_key.in_(custom_cache_keys)).delete(synchronize_session=False)
            db.commit()
            db.refresh(card)
        return _card_to_dict(card)

    image_url = (update.custom_image_url or "").strip()
    if image_url:
        try:
            image_url = validate_public_https_image_url(image_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    if card.custom_image_url != (image_url or None):
        db.query(ImageCache).filter(ImageCache.image_key.in_(custom_cache_keys)).delete(synchronize_session=False)
    card.custom_image_url = image_url or None
    db.commit()
    db.refresh(card)
    return _card_to_dict(card)


@router.get("/{card_id}", response_model=CardBase)
def get_card(
    card_id: str,
    lang: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single card from DB or fetch full detail from TCGdex.

    lang: the language to fetch from. If omitted, the current user's selected
    catalogue language is used. The card's stored language is always used if
    available; this parameter only affects new fetches.
    """
    card = db.query(Card).filter(
        Card.id == card_id,
        visible_any_card_filter(db, current_user.id, "all"),
    ).first()
    if card:
        return _card_to_dict(card, current_user.id)

    # Fetch full card detail from TCGdex (includes pricing)
    # strip_lang_suffix handles both composite IDs (sv1-1_de) and legacy IDs (sv1-1)
    tcg_card_id, detected_lang = pokemon_api.strip_lang_suffix(card_id)
    # An explicit suffix in the DB id wins over the query default. Requesting
    # me04-001_de should create/return a German row, even if it temporarily uses
    # English fallback data.
    requested_lang = normalize_tcgdex_language(lang or get_tcgdex_display_language(db, current_user.id))
    if not is_supported_tcgdex_language(requested_lang):
        requested_lang = detected_lang
    card_lang = detected_lang if has_lang_suffix(card_id) else requested_lang
    if card_lang not in set(get_configured_sync_languages(db)):
        raise HTTPException(status_code=404, detail="Card not found")

    try:
        card_data = pokemon_api.get_card(tcg_card_id, lang=card_lang)
        if card_data:
            parsed = pokemon_api.parse_card_for_db(card_data, lang=card_lang)
            parsed = apply_cross_language_fallbacks(db, parsed)
        else:
            parsed = build_missing_language_card(db, tcg_card_id, card_lang)
            if not parsed:
                raise HTTPException(status_code=404, detail="Card not found")

        # Ensure set exists
        if parsed.get("set_id"):
            set_db_id = f"{parsed['set_id']}_{card_lang}"
            set_obj = db.query(Set).filter(Set.id == set_db_id).first()
            if set_obj and set_obj.is_digital and not digital_sets_enabled(db):
                raise HTTPException(status_code=404, detail="Card not found")
            if set_obj and set_obj.is_digital:
                parsed["is_digital"] = True
            if not set_obj:
                # Create minimal set record
                set_data = card_data.get("set") if card_data else None
                if set_data:
                    set_data = {**set_data, "_lang": card_lang, "_db_key": set_db_id}
                    set_parsed = pokemon_api.parse_set_for_db(set_data)
                    if set_parsed.get("is_digital") and not digital_sets_enabled(db):
                        raise HTTPException(status_code=404, detail="Card not found")
                    set_parsed["lang"] = card_lang
                    db.add(Set(**set_parsed))
                else:
                    db.add(Set(id=set_db_id, tcg_set_id=parsed["set_id"], name=parsed["set_id"], total=0, lang=card_lang))

        if parsed.get("is_digital") and not digital_sets_enabled(db):
            raise HTTPException(status_code=404, detail="Card not found")

        card = upsert_card(db, parsed)
        db.commit()
        db.refresh(card)
        return card
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
