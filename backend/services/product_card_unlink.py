"""Atomic, explicitly confirmed removal of product provenance links."""
from fastapi import HTTPException
from sqlalchemy.orm import joinedload

from models import ProductCard, ProductPurchase, ProductLedgerEntry
from services.bulk_removal_errors import batch_detail


def product_link_snapshot(link):
    return {'product_id': link.product_id, 'product_card_id': link.id,
            'collection_item_id': link.collection_item_id, 'active_quantity': link.active_quantity}


def product_link_blockers(link, expected_collection_item_id=None, expected_active_quantity=None, *, has_history=None):
    base = {'resource': 'product_link', 'product_id': link.product_id,
            'product_card_id': link.id, 'item_id': expected_collection_item_id or link.collection_item_id}
    blockers = []
    if expected_collection_item_id is not None and (
        link.collection_item_id != expected_collection_item_id or link.active_quantity != expected_active_quantity
    ):
        blockers.append({**base, 'code': 'product_link_changed', 'action': 'refresh_confirmation',
                         'current': product_link_snapshot(link)})
    if link.sold_quantity > 0 or (bool(link.ledger_entries) if has_history is None else has_history):
        blockers.append({**base, 'code': 'product_history_protected', 'action': 'cannot_unlink_history',
                         'message': 'Cannot unlink a card that has sale or trade history'})
    return blockers


def unlink_confirmed_product_cards(db, user, request):
    try:
        product_ids = sorted({link.product_id for link in request.links})
        # Match the existing unlink/link/sale lock order: ProductPurchase before ProductCard.
        products = db.query(ProductPurchase).filter(
            ProductPurchase.user_id == user.id, ProductPurchase.id.in_(product_ids),
        ).order_by(ProductPurchase.id).with_for_update(of=ProductPurchase).all()
        products_by_id = {p.id: p for p in products}
        rows = db.query(ProductCard).options(joinedload(ProductCard.card)).filter(
            ProductCard.user_id == user.id, ProductCard.product_id.in_(products_by_id),
            ProductCard.id.in_([link.product_card_id for link in request.links]),
        ).order_by(ProductCard.id).with_for_update(of=ProductCard).all()
        by_key = {(row.product_id, row.id): row for row in rows}
        history_ids = {row[0] for row in db.query(ProductLedgerEntry.product_card_id).filter(
            ProductLedgerEntry.product_card_id.in_([row.id for row in rows]),
        ).distinct().all()}
        blockers, current = [], []
        unavailable = False
        for confirmed in request.links:
            row = by_key.get((confirmed.product_id, confirmed.product_card_id))
            if row is None:
                unavailable = True
                blockers.append({'code': 'not_found_or_not_accessible', 'resource': 'product_link',
                                 'product_id': confirmed.product_id, 'product_card_id': confirmed.product_card_id,
                                 'item_id': confirmed.collection_item_id, 'action': 'remove_from_request'})
                continue
            can_unlink = row.sold_quantity == 0 and row.id not in history_ids
            current.append({**product_link_snapshot(row), 'can_unlink': can_unlink,
                            'name': row.card.name if row.card else row.card_id,
                            'product_name': products_by_id[row.product_id].product_name})
            blockers.extend(product_link_blockers(row, confirmed.collection_item_id, confirmed.active_quantity,
                                                 has_history=row.id in history_ids))
        if blockers:
            raise HTTPException(404 if unavailable else 409, batch_detail(
                'product_links_unavailable' if unavailable else 'product_unlink_conflict',
                'Some product links cannot be unlinked. Nothing was changed.', blockers, {'current_links': current}))
        copies = sum(int(row.active_quantity or 0) for row in rows)
        for row in rows:
            db.delete(row)
        db.commit()
        return {'unlinked_ids': [link.product_card_id for link in request.links],
                'unlinked_links': len(rows), 'unlinked_copies': copies}
    except Exception:
        db.rollback()
        raise
