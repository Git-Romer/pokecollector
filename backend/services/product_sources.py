from __future__ import annotations

from sqlalchemy.orm import Session

from models import CollectionItem, ProductCard, ProductPurchase, User


COLLECTION_ITEM_SOURCE_CHUNK_SIZE = 500


def product_sources_by_collection_item(
    db: Session,
    current_user: User,
    collection_item_ids: list[int],
) -> dict[int, list[dict]]:
    """Return active, owner-scoped product links grouped by collection row."""
    item_ids = list(dict.fromkeys(item_id for item_id in collection_item_ids if item_id is not None))
    if not item_ids:
        return {}

    sources_by_item_id: dict[int, list[dict]] = {}
    for start in range(0, len(item_ids), COLLECTION_ITEM_SOURCE_CHUNK_SIZE):
        chunk = item_ids[start:start + COLLECTION_ITEM_SOURCE_CHUNK_SIZE]
        rows = db.query(ProductCard, ProductPurchase).join(
            ProductPurchase,
            ProductPurchase.id == ProductCard.product_id,
        ).filter(
            ProductCard.user_id == current_user.id,
            ProductPurchase.user_id == current_user.id,
            ProductCard.collection_item_id.in_(chunk),
            ProductCard.active_quantity > 0,
        ).order_by(
            ProductPurchase.purchase_date.desc(),
            ProductCard.linked_at.desc(),
            ProductCard.id.desc(),
        ).all()

        for product_card, product in rows:
            collection_item_id = product_card.collection_item_id
            if collection_item_id is None:
                continue
            sources_by_item_id.setdefault(collection_item_id, []).append({
                "product_card_id": product_card.id,
                "product_id": product.id,
                "product_name": product.product_name,
                "product_type": product.product_type,
                "purchase_date": product.purchase_date,
                "active_quantity": int(product_card.active_quantity or 0),
                "initial_quantity": int(product_card.initial_quantity or 0),
                "linked_at": product_card.linked_at,
            })

    return sources_by_item_id


def annotate_product_sources(
    db: Session,
    current_user: User,
    items: list[CollectionItem],
) -> list[CollectionItem]:
    """Attach each collection row's active product sources for the current owner."""
    sources_by_item_id = product_sources_by_collection_item(
        db,
        current_user,
        [item.id for item in items],
    )
    for item in items:
        item.product_sources = sources_by_item_id.get(item.id, [])
    return items
