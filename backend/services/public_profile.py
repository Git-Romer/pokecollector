import re
import unicodedata
from urllib.parse import quote

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import joinedload

from models import User, Binder, BinderCard, Card, Set as CardSet, Setting, WishlistItem
from services.card_numbers import natural_card_number_key
from services.card_values import effective_market_price

HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")

RESERVED_HANDLES = {
    "admin", "api", "u", "settings", "login", "logout", "static", "assets",
    "public", "profile", "me", "null", "undefined", "app", "www",
}


class HandleError(ValueError):
    pass


class HandleConflictError(HandleError):
    pass


def validate_handle(raw: str) -> str:
    """Normalize and validate a public handle. Return the normalized handle or raise HandleError."""
    handle = (raw or "").strip().lower()
    if not handle:
        raise HandleError("Handle is required")
    if len(handle) < 3 or len(handle) > 30:
        raise HandleError("Handle must be 3–30 characters")
    if "--" in handle:
        raise HandleError("Handle cannot contain consecutive hyphens")
    if not HANDLE_RE.match(handle):
        raise HandleError("Handle may use lowercase letters, numbers and hyphens, and cannot start or end with a hyphen")
    if handle in RESERVED_HANDLES:
        raise HandleError("That handle is reserved")
    return handle


def public_handle_from_trainer_name(raw: str) -> str:
    """Create an ASCII URL handle, normalizing common Latin diacritics."""
    ascii_name = (
        unicodedata.normalize("NFKD", raw or "")
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    handle = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")
    handle = handle[:30].rstrip("-")
    try:
        return validate_handle(handle)
    except HandleError as exc:
        raise HandleError(
            "Trainer name must produce a 3–30 character public URL using Latin letters or numbers"
        ) from exc

_DEFAULT_TRAINER_NAME = "TRAINER"
_PRICE_FIELD = "price_trend"
_TRAINER_NAME_HANDLE_MIGRATION_KEY = "public_trainer_name_handles_migrated"


def _public_card_image_url(card_id: str) -> str:
    return f"/api/images/card/{quote(card_id, safe='')}/small"


def is_handle_available(db, handle: str, exclude_user_id: int | None = None) -> bool:
    query = db.query(User.id).filter(User.public_handle == handle)
    if exclude_user_id is not None:
        query = query.filter(User.id != exclude_user_id)
    return query.first() is None


def assign_public_handle(db, user: User, trainer_name: str | None = None) -> str:
    """Assign the derived trainer-name handle, rejecting reserved or conflicting URLs."""
    handle = public_handle_from_trainer_name(trainer_name if trainer_name is not None else user.username)
    if not is_handle_available(db, handle, exclude_user_id=user.id):
        raise HandleConflictError("Another public profile already uses this trainer name")
    user.public_handle = handle
    return handle


def migrate_public_profile_handles(db) -> dict:
    """Replace editable legacy handles with trainer-name handles on upgrade.

    Invalid or colliding profiles are disabled rather than exposed under a stale
    URL. Users can fix their trainer name and opt in again from Settings.
    """
    migration_marker = db.query(Setting).filter(
        Setting.key == _TRAINER_NAME_HANDLE_MIGRATION_KEY
    ).first()
    if migration_marker and str(migration_marker.value).lower() == "true":
        return {"migrated": 0, "disabled": 0}

    public_users = db.query(User).filter(
        User.is_profile_public.is_(True)
    ).order_by(User.id.asc()).all()
    previous_handles = {user.id: user.public_handle for user in public_users}
    db.query(User).update({User.public_handle: None}, synchronize_session="fetch")
    db.flush()

    migrated = 0
    disabled = 0
    claimed: set[str] = set()
    for user in public_users:
        try:
            handle = public_handle_from_trainer_name(user.username)
        except HandleError:
            user.public_handle = None
            user.is_profile_public = False
            disabled += 1
            continue
        if handle in claimed:
            user.public_handle = None
            user.is_profile_public = False
            disabled += 1
            continue
        claimed.add(handle)
        user.public_handle = handle
        if previous_handles.get(user.id) != handle:
            migrated += 1
    if migration_marker:
        migration_marker.value = "true"
    else:
        db.add(Setting(key=_TRAINER_NAME_HANDLE_MIGRATION_KEY, value="true"))
    db.commit()
    return {"migrated": migrated, "disabled": disabled}


def get_live_profile(db, handle: str) -> User | None:
    if not handle:
        return None
    return db.query(User).filter(
        User.public_handle == handle,
        User.is_profile_public.is_(True),
        User.is_active.is_(True),
    ).first()


def trainer_name_for(db, user: User) -> str:
    return user.username or _DEFAULT_TRAINER_NAME


def public_deck_shareable_clause(deck_model=Binder):
    """SQL predicate for Decks that are safe to advertise anonymously."""
    private_custom_entry = exists().where(
        BinderCard.binder_id == deck_model.id,
        BinderCard.collection_item_id.is_(None),
        BinderCard.card_id == Card.id,
        Card.is_custom.is_(True),
    )
    return ~private_custom_entry


def public_profile_directory(db) -> list[dict]:
    binder_count = select(func.count(Binder.id)).where(
        Binder.user_id == User.id,
        Binder.is_public.is_(True),
        Binder.binder_type == "collection",
    ).correlate(User).scalar_subquery()
    deck_count = select(func.count(Binder.id)).where(
        Binder.user_id == User.id,
        Binder.is_public.is_(True),
        Binder.binder_type.in_(("deck", "physical_deck")),
        public_deck_shareable_clause(Binder),
    ).correlate(User).scalar_subquery()
    rows = (
        db.query(
            User,
            binder_count.label("binder_count"),
            deck_count.label("deck_count"),
        )
        .filter(
            User.is_profile_public.is_(True),
            User.is_active.is_(True),
        )
        .order_by(User.username.asc(), User.id.asc())
        .all()
    )
    return [
        {
            "handle": user.public_handle,
            "trainer_name": trainer_name_for(db, user),
            "avatar_id": user.avatar_id,
            "binder_count": int(binder_count or 0),
            "deck_count": int(deck_count or 0),
            "wishlist_is_public": (user.wishlist_visibility or "private") == "public",
        }
        for user, binder_count, deck_count in rows
        if user.public_handle
    ]


def public_collection_binders(db, user: User) -> list[Binder]:
    return db.query(Binder).filter(
        Binder.user_id == user.id,
        Binder.is_public.is_(True),
        Binder.binder_type == "collection",
    ).order_by(Binder.created_at.asc()).all()


def get_public_collection_binder(db, user_id: int, binder_id: int) -> Binder | None:
    return db.query(Binder).filter(
        Binder.id == binder_id,
        Binder.user_id == user_id,
        Binder.is_public.is_(True),
        Binder.binder_type == "collection",
    ).first()


def public_decks(db, user: User) -> list[Binder]:
    return db.query(Binder).options(
        joinedload(Binder.binder_cards).joinedload(BinderCard.card),
    ).filter(
        Binder.user_id == user.id,
        Binder.is_public.is_(True),
        Binder.binder_type.in_(("deck", "physical_deck")),
        public_deck_shareable_clause(Binder),
    ).order_by(Binder.updated_at.desc(), Binder.id.desc()).all()


def get_public_deck(db, user_id: int, deck_id: int) -> Binder | None:
    return db.query(Binder).options(
        joinedload(Binder.binder_cards)
        .joinedload(BinderCard.card)
        .joinedload(Card.set_ref),
    ).filter(
        Binder.id == deck_id,
        Binder.user_id == user_id,
        Binder.is_public.is_(True),
        Binder.binder_type.in_(("deck", "physical_deck")),
        public_deck_shareable_clause(Binder),
    ).first()


def deck_has_private_custom_cards(db, deck_id: int) -> bool:
    return db.query(BinderCard.id).join(
        Card, Card.id == BinderCard.card_id
    ).filter(
        BinderCard.binder_id == deck_id,
        BinderCard.collection_item_id.is_(None),
        Card.is_custom.is_(True),
    ).first() is not None


def public_deck_accepts_card(deck: Binder, card: Card) -> bool:
    return not (
        bool(deck.is_public)
        and (deck.binder_type or "collection") in {"deck", "physical_deck"}
        and bool(card.is_custom)
    )


def public_wishlist_items(
    db,
    user: User,
    *,
    search: str | None = None,
    set_filter: str | None = None,
    rarity: str | None = None,
    sort: str = "date_added",
    order: str = "desc",
    page: int = 1,
    page_size: int = 48,
) -> tuple[list[WishlistItem], int]:
    query = db.query(WishlistItem).options(
        joinedload(WishlistItem.card).joinedload(Card.set_ref),
    ).join(Card, Card.id == WishlistItem.card_id).filter(
        WishlistItem.user_id == user.id,
        Card.is_custom.is_(False),
    )
    search_text = (search or "").strip().casefold()
    set_text = (set_filter or "").strip().casefold()
    rarity_text = (rarity or "").strip().casefold()
    if search_text:
        query = query.filter(or_(
            func.lower(Card.name).contains(search_text, autoescape=True),
            func.lower(Card.number).contains(search_text, autoescape=True),
        ))
    if set_text:
        query = query.outerjoin(
            CardSet,
            and_(CardSet.tcg_set_id == Card.set_id, CardSet.lang == Card.lang),
        ).filter(or_(
            func.lower(Card.set_id) == set_text,
            func.lower(CardSet.name) == set_text,
        ))
    if rarity_text:
        query = query.filter(func.lower(Card.rarity) == rarity_text)

    total = int(query.with_entities(func.count(WishlistItem.id)).scalar() or 0)

    if sort in {"date_added", "name", "rarity"}:
        columns = {
            "date_added": (WishlistItem.created_at, WishlistItem.id),
            "name": (func.lower(Card.name), WishlistItem.id),
            "rarity": (func.lower(Card.rarity), func.lower(Card.name), WishlistItem.id),
        }[sort]
        ordered = [column.desc() if order == "desc" else column.asc() for column in columns]
        items = query.order_by(*ordered).offset((page - 1) * page_size).limit(page_size).all()
        return items, total

    key_functions = {
        "set": lambda item: (((item.card.set_ref.name if item.card.set_ref else item.card.set_id) or "").casefold(), natural_card_number_key(item.card.number), item.id),
        "price": lambda item: (effective_market_price(item.card, None, _PRICE_FIELD), (item.card.name or "").casefold(), item.id),
    }
    items = sorted(query.all(), key=key_functions[sort], reverse=order == "desc")
    start = (page - 1) * page_size
    return items[start:start + page_size], total


def public_wishlist_facets(db, user: User) -> dict:
    base_filters = (
        WishlistItem.user_id == user.id,
        Card.is_custom.is_(False),
    )
    set_rows = db.query(Card.set_id, CardSet.name).join(
        WishlistItem, WishlistItem.card_id == Card.id
    ).outerjoin(
        CardSet,
        and_(CardSet.tcg_set_id == Card.set_id, CardSet.lang == Card.lang),
    ).filter(*base_filters).distinct().all()
    sets = {
        set_id: set_name or set_id
        for set_id, set_name in set_rows
        if set_id
    }
    rarity_rows = db.query(Card.rarity).join(
        WishlistItem, WishlistItem.card_id == Card.id
    ).filter(*base_filters, Card.rarity.isnot(None)).distinct().all()
    return {
        "sets": [
            {"id": set_id, "name": name}
            for set_id, name in sorted(sets.items(), key=lambda item: (item[1] or "").casefold())
        ],
        "rarities": sorted({rarity for (rarity,) in rarity_rows if rarity}, key=str.casefold),
    }


def _binder_cards(db, binder: Binder) -> list[BinderCard]:
    # Present cards in natural collector order: by set, then card number
    # (1, 2, 10 — not 1, 10, 2), then variant so same-number prints stay grouped.
    # Natural number ordering can't be expressed in SQL, so sort in Python;
    # eager-load the card, its set, and the linked collection item so per-card
    # number/variant/value reads don't issue a query each.
    cards = (
        db.query(BinderCard)
        .options(
            joinedload(BinderCard.card).joinedload(Card.set_ref),
            joinedload(BinderCard.collection_item),
        )
        .filter(BinderCard.binder_id == binder.id)
        .all()
    )
    return sorted(cards, key=_card_sort_key)


def _binder_cards_for_binders(db, binders: list[Binder]) -> dict[int, list[BinderCard]]:
    binder_ids = [binder.id for binder in binders]
    if not binder_ids:
        return {}
    rows = (
        db.query(BinderCard)
        .options(
            joinedload(BinderCard.card).joinedload(Card.set_ref),
            joinedload(BinderCard.collection_item),
        )
        .filter(BinderCard.binder_id.in_(binder_ids))
        .all()
    )
    grouped = {binder_id: [] for binder_id in binder_ids}
    for row in rows:
        grouped[row.binder_id].append(row)
    for binder_id in grouped:
        grouped[binder_id].sort(key=_card_sort_key)
    return grouped


def _card_sort_key(bc: BinderCard) -> tuple:
    card = bc.card
    set_id = (card.set_id or "") if card else ""
    number_key = natural_card_number_key(card.number if card else None)
    return (set_id, number_key, _card_variant(bc) or "")


def _card_variant(bc: BinderCard) -> str | None:
    return bc.collection_item.variant if bc.collection_item else None


def _serialize_catalogue_card(card: Card, quantity: int, show_values: bool, *, variant: str | None = None, date_added=None) -> dict:
    value = effective_market_price(card, variant, _PRICE_FIELD) if show_values else None
    data = {
        "id": card.id,
        "name": card.name,
        "image": _public_card_image_url(card.id),
        "set_id": card.set_id,
        "set_name": card.set_ref.name if card.set_ref else None,
        "number": card.number,
        "rarity": card.rarity,
        "is_custom": bool(card.is_custom),
        "lang": card.lang,
        "variant": variant,
        "printing_details": [],
        "data_source_lang": card.data_source_lang,
        "price_source_lang": card.price_source_lang,
        "image_source_lang": card.image_source_lang,
        "has_custom_image_fallback": bool(card.custom_image_url and not (card.images_small or card.images_large)),
        "quantity": quantity,
        "market_value": value,
    }
    if date_added is not None:
        data["date_added"] = date_added
    return data


def _serialize_card(bc: BinderCard, show_values: bool) -> dict:
    card = bc.card
    data = _serialize_catalogue_card(
        card,
        bc.required_quantity or 1,
        show_values,
        variant=_card_variant(bc),
    )
    data["printing_details"] = (
        [tag.name for tag in bc.collection_item.printing_detail_tags]
        if bc.collection_item else []
    )
    return data


def serialize_wishlist_item(item: WishlistItem, show_values: bool) -> dict:
    return _serialize_catalogue_card(
        item.card,
        int(item.quantity or 1),
        show_values,
        date_added=item.created_at,
    )


def serialize_deck_summary(deck: Binder) -> dict:
    entries = [entry for entry in deck.entries if entry.card and not entry.card.is_custom]
    return {
        "id": deck.id,
        "name": deck.name,
        "binder_type": deck.binder_type,
        "format": deck.format or "Casual",
        "target_size": int(deck.target_size or 60),
        "description": deck.description,
        "color": deck.color,
        "icon_pokemon_id": deck.icon_pokemon_id,
        "card_count": sum(int(entry.required_quantity or 0) for entry in entries),
        "unique_card_count": len(entries),
    }


def serialize_binder_summary(db, binder: Binder, show_values: bool, cards: list[BinderCard] | None = None) -> dict:
    cards = _binder_cards(db, binder) if cards is None else cards
    unique = {bc.card_id for bc in cards}
    total_count = sum((bc.required_quantity or 1) for bc in cards)
    total_value = None
    if show_values:
        total_value = round(sum(
            effective_market_price(bc.card, _card_variant(bc), _PRICE_FIELD) * (bc.required_quantity or 1)
            for bc in cards if bc.card
        ), 2)
    return {
        "id": binder.id,
        "name": binder.name,
        "color": binder.color,
        "icon_pokemon_id": binder.icon_pokemon_id,
        "card_count": total_count,
        "unique_card_count": len(unique),
        "total_value": total_value,
    }


def serialize_binder_detail(db, binder: Binder, show_values: bool) -> dict:
    cards = _binder_cards(db, binder)
    summary = serialize_binder_summary(db, binder, show_values, cards=cards)
    summary["cards"] = [_serialize_card(bc, show_values) for bc in cards if bc.card]
    return summary


def serialize_profile(db, user: User) -> dict:
    show_values = bool(user.public_show_values)
    binders = public_collection_binders(db, user)
    cards_by_binder = _binder_cards_for_binders(db, binders)
    decks = public_decks(db, user)
    wishlist_count = 0
    if (user.wishlist_visibility or "private") == "public":
        wishlist_count = db.query(func.count(WishlistItem.id)).join(
            Card, Card.id == WishlistItem.card_id
        ).filter(
            WishlistItem.user_id == user.id,
            Card.is_custom.is_(False),
        ).scalar() or 0
    return {
        "handle": user.public_handle,
        "trainer_name": trainer_name_for(db, user),
        "avatar_id": user.avatar_id,
        "show_values": show_values,
        "wishlist_is_public": (user.wishlist_visibility or "private") == "public",
        "wishlist_count": int(wishlist_count),
        "binders": [
            serialize_binder_summary(db, binder, show_values, cards=cards_by_binder.get(binder.id, []))
            for binder in binders
        ],
        "decks": [serialize_deck_summary(deck) for deck in decks],
    }
