import re

HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")

RESERVED_HANDLES = {
    "admin", "api", "u", "settings", "login", "logout", "static", "assets",
    "public", "profile", "me", "null", "undefined", "app", "www",
}


class HandleError(ValueError):
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


from models import User, Binder, BinderCard, Card, UserSetting
from services.card_values import effective_market_price

_DEFAULT_TRAINER_NAME = "TRAINER"
_PRICE_FIELD = "price_trend"


def is_handle_available(db, handle: str, exclude_user_id: int | None = None) -> bool:
    query = db.query(User.id).filter(User.public_handle == handle)
    if exclude_user_id is not None:
        query = query.filter(User.id != exclude_user_id)
    return query.first() is None


def get_live_profile(db, handle: str) -> User | None:
    if not handle:
        return None
    return db.query(User).filter(
        User.public_handle == handle,
        User.is_profile_public.is_(True),
        User.is_active.is_(True),
    ).first()


def trainer_name_for(db, user: User) -> str:
    row = db.query(UserSetting).filter(
        UserSetting.user_id == user.id, UserSetting.key == "trainer_name"
    ).first()
    return (row.value if row and row.value else _DEFAULT_TRAINER_NAME)


def public_collection_binders(db, user: User) -> list[Binder]:
    return db.query(Binder).filter(
        Binder.user_id == user.id,
        Binder.is_public.is_(True),
        Binder.binder_type == "collection",
    ).order_by(Binder.created_at.asc()).all()


def _binder_cards(db, binder: Binder) -> list[BinderCard]:
    return db.query(BinderCard).filter(BinderCard.binder_id == binder.id).all()


def _serialize_card(bc: BinderCard, show_values: bool) -> dict:
    card = bc.card
    quantity = bc.required_quantity or 1
    value = effective_market_price(card, None, _PRICE_FIELD) if show_values else None
    return {
        "id": card.id,
        "name": card.name,
        "image": card.images_small or card.images_large,
        "set_name": card.set_ref.name if card.set_ref else None,
        "number": card.number,
        "rarity": card.rarity,
        "quantity": quantity,
        "market_value": value,
    }


def serialize_binder_summary(db, binder: Binder, show_values: bool) -> dict:
    cards = _binder_cards(db, binder)
    unique = {bc.card_id for bc in cards}
    total_count = sum((bc.required_quantity or 1) for bc in cards)
    total_value = None
    if show_values:
        total_value = round(sum(
            effective_market_price(bc.card, None, _PRICE_FIELD) * (bc.required_quantity or 1)
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
    summary = serialize_binder_summary(db, binder, show_values)
    cards = _binder_cards(db, binder)
    summary["cards"] = [_serialize_card(bc, show_values) for bc in cards if bc.card]
    return summary


def serialize_profile(db, user: User) -> dict:
    show_values = bool(user.public_show_values)
    binders = public_collection_binders(db, user)
    return {
        "handle": user.public_handle,
        "trainer_name": trainer_name_for(db, user),
        "avatar_id": user.avatar_id,
        "show_values": show_values,
        "binders": [serialize_binder_summary(db, b, show_values) for b in binders],
    }
