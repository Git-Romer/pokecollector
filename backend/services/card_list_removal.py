"""Atomic removal of entries from one owned Card List, never the collection."""
import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import Binder, BinderCard
from services.bulk_removal_errors import batch_detail, unavailable_blockers
from services.binder_allocations import lock_user_card_allocations, trim_deck_allocations


def remove_card_list_entries(db: Session, user_id: int, list_id: int, item_ids: list[int], *, deck: bool):
    try:
        lock_user_card_allocations(db, user_id)
        target = db.query(Binder).filter(
            Binder.id == list_id, Binder.user_id == user_id,
        ).with_for_update(of=Binder).first()
        allowed = ('deck', 'physical_deck') if deck else ('collection', 'wishlist')
        if not target or (target.binder_type or 'collection') not in allowed:
            raise HTTPException(404, batch_detail('card_list_unavailable',
                'Deck not found' if deck else 'Binder not found',
                unavailable_blockers(item_ids, [], 'list_entry', list_id=list_id)))
        query = db.query(BinderCard).filter(
            BinderCard.binder_id == list_id, BinderCard.id.in_(item_ids),
        )
        if deck:
            query = query.filter(BinderCard.collection_item_id.is_(None))
        entries = query.order_by(BinderCard.id).with_for_update(of=BinderCard).all()
        if len(entries) != len(item_ids):
            raise HTTPException(404, batch_detail('list_entries_unavailable',
                'One or more entries were not found in this list. Nothing was removed.',
                unavailable_blockers(item_ids, [entry.id for entry in entries], 'list_entry', list_id=list_id)))
        copies = sum(max(int(entry.required_quantity or 1), 1) for entry in entries)
        card_ids = {entry.card_id for entry in entries}
        for entry in entries:
            db.delete(entry)
        db.flush()
        if target.binder_type == 'physical_deck':
            for card_id in sorted(card_ids):
                remaining = sum(max(int(quantity or 1), 1) for quantity, in db.query(BinderCard.required_quantity).filter(
                    BinderCard.binder_id == list_id, BinderCard.card_id == card_id,
                    BinderCard.collection_item_id.is_(None),
                ).all())
                trim_deck_allocations(db, list_id, card_id, remaining)
        target.updated_at = datetime.datetime.utcnow()
        db.commit()
        return {'removed_ids': item_ids, 'removed_entries': len(item_ids), 'removed_copies': copies}
    except Exception:
        db.rollback()
        raise
