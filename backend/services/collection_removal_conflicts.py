"""Describe removal blockers and release only explicitly confirmed owned copies."""
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import or_

from models import Binder, BinderCard, CollectionItem
from services.bulk_removal_errors import batch_detail, unavailable_blockers
from services.binder_allocations import lock_user_card_allocations, stored_binder_quantity
from services.product_sources import product_sources_by_collection_item


def owned_items(db, user, item_ids):
    items = db.query(CollectionItem).filter(
        CollectionItem.user_id == user.id, CollectionItem.id.in_(item_ids),
    ).order_by(CollectionItem.id).with_for_update(of=CollectionItem).all()
    if len(items) != len(item_ids):
        detail = removal_conflicts(db, user, items) or {}
        blockers = unavailable_blockers(item_ids, [item.id for item in items], 'collection_item')
        raise HTTPException(404, batch_detail('collection_entries_unavailable',
            'Some collection entries were not found or are not accessible. Nothing was changed.',
            blockers + detail.get('blockers', []), detail))
    return items


def assignment_rows(db, user, item_ids):
    return db.query(BinderCard, Binder).join(Binder).filter(
        Binder.user_id == user.id, BinderCard.collection_item_id.in_(item_ids),
        or_(Binder.binder_type.in_(('collection', 'physical_deck')), Binder.binder_type.is_(None)),
    ).order_by(BinderCard.id).with_for_update(of=BinderCard).all()


def assignment_snapshot(row, binder):
    return {'assignment_id': row.id, 'list_id': binder.id,
            'item_id': row.collection_item_id, 'quantity': stored_binder_quantity(row.required_quantity)}


def removal_conflicts(db, user, items):
    grouped = defaultdict(list)
    for row, binder in assignment_rows(db, user, [item.id for item in items]):
        grouped[row.collection_item_id].append({
            **assignment_snapshot(row, binder), 'list_name': binder.name,
            'list_type': binder.binder_type or 'collection',
        })
    products = product_sources_by_collection_item(db, user, [item.id for item in items])
    conflicts = [{
        'item_id': item.id, 'card_id': item.card_id,
        'name': item.card.name if item.card else str(item.card_id or item.id),
        'variant': item.variant, 'condition': item.condition, 'lang': item.lang,
        'quantity': item.quantity, 'assignments': grouped.get(item.id, []),
        'products': products.get(item.id, []),
    } for item in items if grouped.get(item.id) or products.get(item.id)]
    if not conflicts:
        return None
    has_assignments = any(c['assignments'] for c in conflicts)
    blockers, resolutions, assignments, links, protected = [], [], [], [], []
    for card in conflicts:
        identity = {k: card[k] for k in ['item_id', 'card_id', 'name', 'variant', 'condition', 'lang']}
        if card['assignments']:
            blockers.append({**identity, 'code': 'assigned_to_lists', 'resource': 'collection_item',
                             'assignments': card['assignments'], 'action': 'release_assignments'})
            assignments.extend({k: a[k] for k in ['assignment_id', 'list_id', 'item_id', 'quantity']} for a in card['assignments'])
        if card['products']:
            protected.extend(p['product_card_id'] for p in card['products'] if not p.get('can_unlink', True))
            blockers.append({**identity, 'code': 'linked_to_products', 'resource': 'collection_item',
                             'products': card['products'], 'action': 'unlink_products'})
            links.extend({'product_id': p['product_id'], 'product_card_id': p['product_card_id'],
                          'collection_item_id': card['item_id'], 'active_quantity': p['active_quantity']} for p in card['products'])
    if assignments:
        resolutions.append({'method': 'POST', 'path': '/api/collection/release-assignments',
                            'requires_confirmation': True,
                            'body': {'item_ids': [item.id for item in items], 'assignments': assignments}})
    if links:
        resolutions.append({'method': 'POST', 'path': '/api/products/cards/bulk-unlink',
                            'requires_confirmation': True, 'can_execute': not protected,
                            'blocked_by_history': protected, 'body': {'links': links}})
    return batch_detail(
        'collection_assignment_conflict' if has_assignments else 'collection_product_link_conflict',
        ('Some selected cards are still assigned to binders or decks. Nothing was removed.' if has_assignments
         else 'A selected collection item is linked to a product. Sell or unlink it before removal. Nothing was removed.'),
        blockers, {'product_sources': [source for card in conflicts for source in card['products']],
                   'conflicts': conflicts, 'resolutions': resolutions})


def release_confirmed_assignments(db, user, request):
    try:
        lock_user_card_allocations(db, user.id)
        items = owned_items(db, user, request.item_ids)
        rows = assignment_rows(db, user, request.item_ids)
        actual = sorted([assignment_snapshot(row, binder) for row, binder in rows], key=lambda a: a['assignment_id'])
        confirmed = sorted([a.model_dump() for a in request.assignments], key=lambda a: a['assignment_id'])
        if actual != confirmed:
            detail = {**(removal_conflicts(db, user, items) or {'conflicts': []}),
                      'code': 'collection_assignments_changed',
                      'message': 'Assignments changed. Review the updated list before trying again.'}
            blockers = detail.get('blockers', []) + [{'code': 'assignments_changed', 'resource': 'assignment',
                'action': 'refresh_confirmation', 'current_assignments': actual}]
            raise HTTPException(409, batch_detail(detail['code'], detail['message'], blockers, detail))
        deck_reductions = defaultdict(int)
        for row, binder in rows:
            if binder.binder_type == 'physical_deck':
                deck_reductions[(binder.id, row.card_id)] += stored_binder_quantity(row.required_quantity)
        # Reduce the matching Deck plan only by these released copies; never trim other allocations.
        for (binder_id, card_id), reduction in deck_reductions.items():
            plans = db.query(BinderCard).filter(
                BinderCard.binder_id == binder_id, BinderCard.card_id == card_id,
                BinderCard.collection_item_id.is_(None),
            ).order_by(BinderCard.id.desc()).with_for_update(of=BinderCard).all()
            for plan in plans:
                if not reduction:
                    break
                quantity = stored_binder_quantity(plan.required_quantity)
                removed = min(quantity, reduction)
                if removed == quantity:
                    db.delete(plan)
                else:
                    plan.required_quantity = quantity - removed
                reduction -= removed
        copies = sum(a['quantity'] for a in actual)
        for row, _binder in rows:
            db.delete(row)
        db.commit()
        return {'released_assignments': len(actual), 'released_copies': copies}
    except Exception:
        db.rollback()
        raise
