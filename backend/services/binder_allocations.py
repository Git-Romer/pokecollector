from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from models import Binder, BinderCard, CollectionItem


def stored_binder_quantity(value: int | None) -> int:
    """Return a safe positive quantity for legacy binder rows."""
    try:
        return max(int(value or 1), 1)
    except (TypeError, ValueError):
        return 1


def collection_binder_allocation_counts(
    db: Session,
    user_id: int,
    collection_item_ids: list[int] | set[int] | tuple[int, ...] | None = None,
    exclude_binder_card_id: int | None = None,
) -> dict[int, int]:
    """Sum exact-copy allocations across every collection binder owned by a user."""
    query = db.query(
        BinderCard.collection_item_id,
        func.coalesce(func.sum(func.coalesce(BinderCard.required_quantity, 1)), 0),
    ).join(Binder, Binder.id == BinderCard.binder_id).filter(
        Binder.user_id == user_id,
        or_(Binder.binder_type == "collection", Binder.binder_type.is_(None)),
        BinderCard.collection_item_id.isnot(None),
    )
    if collection_item_ids is not None:
        ids = list(collection_item_ids)
        if not ids:
            return {}
        query = query.filter(BinderCard.collection_item_id.in_(ids))
    if exclude_binder_card_id is not None:
        query = query.filter(BinderCard.id != exclude_binder_card_id)
    return {
        int(item_id): int(quantity or 0)
        for item_id, quantity in query.group_by(BinderCard.collection_item_id).all()
    }


def collection_binder_allocated_card_counts(
    db: Session,
    user_id: int,
    card_ids: list[str] | set[str] | tuple[str, ...] | None = None,
) -> dict[str, int]:
    """Sum exact-copy allocations by card across collection binders only."""
    query = db.query(
        CollectionItem.card_id,
        func.coalesce(func.sum(func.coalesce(BinderCard.required_quantity, 1)), 0),
    ).join(Binder, Binder.id == BinderCard.binder_id).join(
        CollectionItem, CollectionItem.id == BinderCard.collection_item_id
    ).filter(
        Binder.user_id == user_id,
        CollectionItem.user_id == user_id,
        or_(Binder.binder_type == "collection", Binder.binder_type.is_(None)),
        BinderCard.collection_item_id.isnot(None),
    )
    if card_ids is not None:
        ids = list(card_ids)
        if not ids:
            return {}
        query = query.filter(CollectionItem.card_id.in_(ids))
    return {
        str(card_id): int(quantity or 0)
        for card_id, quantity in query.group_by(CollectionItem.card_id).all()
    }


def collection_item_allocated_quantity(
    db: Session,
    user_id: int,
    collection_item_id: int,
    exclude_binder_card_id: int | None = None,
) -> int:
    return collection_binder_allocation_counts(
        db,
        user_id,
        [collection_item_id],
        exclude_binder_card_id=exclude_binder_card_id,
    ).get(collection_item_id, 0)


def collection_item_available_quantity(
    db: Session,
    user_id: int,
    collection_item: CollectionItem,
    exclude_binder_card_id: int | None = None,
) -> int:
    allocated = collection_item_allocated_quantity(
        db,
        user_id,
        collection_item.id,
        exclude_binder_card_id=exclude_binder_card_id,
    )
    return max(int(collection_item.quantity or 0) - allocated, 0)
