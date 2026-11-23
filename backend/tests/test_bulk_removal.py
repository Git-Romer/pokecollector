"""Bulk removal stays inside its collection, binder or deck boundary."""
import unittest
from datetime import date
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api import collection, binders, decks, products
from api.auth import get_current_user
from database import Base, get_db
from models import User, Card, CollectionItem, CollectionCardPhoto, Binder, BinderCard, ProductPurchase, ProductCard, ProductLedgerEntry


class BulkRemovalTests(unittest.TestCase):
    def make_engine(self):
        engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        @event.listens_for(engine, 'connect')
        def foreign_keys(connection, _):
            connection.execute('PRAGMA foreign_keys=ON')
        return engine

    def setUp(self):
        self.engine = self.make_engine()
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username='bulk-owner', hashed_password='test', role='trainer', is_active=True)
        self.other = User(username='bulk-other', hashed_password='test', role='trainer', is_active=True)
        self.card = Card(id='bulk-1_en', name='First card', lang='en')
        self.card2 = Card(id='bulk-2_en', name='Second card', lang='en')
        self.db.add_all([self.user, self.other, self.card, self.card2])
        self.db.flush()
        self.a = CollectionItem(user_id=self.user.id, card_id=self.card.id, quantity=3, variant='Normal')
        self.b = CollectionItem(user_id=self.user.id, card_id=self.card2.id, quantity=2, variant='Normal')
        self.foreign = CollectionItem(user_id=self.other.id, card_id=self.card.id, quantity=7, variant='Normal')
        self.binder = Binder(user_id=self.user.id, name='Physical binder', binder_type='collection')
        self.plan = Binder(user_id=self.user.id, name='Planned binder', binder_type='wishlist')
        self.deck = Binder(user_id=self.user.id, name='Real deck', binder_type='physical_deck')
        self.planned_deck = Binder(user_id=self.user.id, name='Planned deck', binder_type='deck')
        self.foreign_binder = Binder(user_id=self.other.id, name='Other binder', binder_type='collection')
        self.db.add_all([self.a, self.b, self.foreign, self.binder, self.plan, self.deck, self.planned_deck, self.foreign_binder])
        self.db.commit()
        app = FastAPI()
        app.include_router(collection.router, prefix='/api/collection')
        app.include_router(binders.router, prefix='/api/binders')
        app.include_router(decks.router, prefix='/api/decks')
        app.include_router(products.router, prefix='/api/products')
        app.dependency_overrides[get_current_user] = lambda: self.user
        def db_session():
            try:
                yield self.db
            finally:
                self.db.rollback()
        app.dependency_overrides[get_db] = db_session
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def entry(self, target, item=None, card=None, quantity=1):
        row = BinderCard(binder_id=target.id, card_id=(card or self.card).id,
                         collection_item_id=item.id if item else None, required_quantity=quantity)
        self.db.add(row)
        self.db.commit()
        return row

    def remove(self, scope, ids, target=None):
        url = f'/api/{scope}' + (f'/{target.id}/entries' if target else '') + '/bulk-delete'
        return self.client.post(url, json={'item_ids': ids})

    def test_collection_removes_whole_entries_with_copy_counts_and_keeps_catalogue(self):
        ids = [self.a.id, self.b.id]
        response = self.remove('collection', ids)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'removed_ids': ids, 'removed_entries': 2, 'removed_copies': 5})
        self.assertIsNone(self.db.get(CollectionItem, ids[0]))
        self.assertEqual(self.db.query(Card).count(), 2)
        self.assertEqual(self.db.get(CollectionItem, self.foreign.id).quantity, 7)

    def test_collection_missing_or_foreign_id_aborts_entire_batch(self):
        for bad in [999999, self.foreign.id]:
            with self.subTest(bad=bad):
                response = self.remove('collection', [self.a.id, bad])
                self.assertEqual(response.status_code, 404, response.text)
                self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_collection_allocated_copy_blocks_all_and_preserves_binder(self):
        row = self.entry(self.binder, self.b)
        response = self.remove('collection', [self.a.id, self.b.id])
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)
        self.assertIsNotNone(self.db.get(BinderCard, row.id))

    def test_collection_active_product_blocks_all_and_keeps_history(self):
        product = ProductPurchase(user_id=self.user.id, product_name='Test product', purchase_price=10, purchase_date=date(2026, 1, 1))
        self.db.add(product)
        self.db.flush()
        link = ProductCard(product_id=product.id, user_id=self.user.id, card_id=self.b.card_id,
                           collection_item_id=self.b.id, initial_quantity=2, active_quantity=2, sold_quantity=0)
        self.db.add(link)
        self.db.commit()
        response = self.remove('collection', [self.a.id, self.b.id])
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()['detail']['code'], 'collection_product_link_conflict')
        self.assertIsNotNone(self.db.get(CollectionItem, self.a.id))
        self.assertEqual(self.db.get(ProductCard, link.id).active_quantity, 2)

    def test_photo_survives_other_variant_then_disappears_with_final_owner_row(self):
        second = CollectionItem(user_id=self.user.id, card_id=self.card.id, quantity=1, variant='Holo')
        own = CollectionCardPhoto(user_id=self.user.id, card_id=self.card.id, data=b'own')
        other = CollectionCardPhoto(user_id=self.other.id, card_id=self.card.id, data=b'other')
        self.db.add_all([second, own, other]); self.db.commit()
        own_id, other_id = own.id, other.id
        self.assertEqual(self.remove('collection', [self.a.id]).status_code, 200)
        self.assertEqual(self.db.get(CollectionCardPhoto, own_id).data, b'own')
        self.assertEqual(self.remove('collection', [second.id]).status_code, 200)
        self.assertIsNone(self.db.get(CollectionCardPhoto, own_id))
        self.assertEqual(self.db.get(CollectionCardPhoto, other_id).data, b'other')

    def test_binder_removal_releases_only_selected_entries_not_collection_or_other_lists(self):
        a = self.entry(self.binder, self.a, quantity=2)
        b = self.entry(self.binder, self.b, card=self.card2)
        untouched = self.entry(self.foreign_binder, self.foreign)
        response = self.remove('binders', [a.id, b.id], self.binder)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['removed_copies'], 3)
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)
        self.assertIsNotNone(self.db.get(BinderCard, untouched.id))
        self.assertEqual(self.db.query(Binder).count(), 5)

    def test_planned_binder_removal_does_not_change_wishlist_or_collection(self):
        a = self.entry(self.plan, quantity=2)
        response = self.remove('binders', [a.id], self.plan)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_wrong_list_entry_or_foreign_list_aborts_batch(self):
        a = self.entry(self.binder, self.a)
        b = self.entry(self.foreign_binder, self.foreign)
        for target, ids in [(self.binder, [a.id, b.id]), (self.foreign_binder, [b.id])]:
            response = self.remove('binders', ids, target)
            self.assertEqual(response.status_code, 404, response.text)
            self.assertIsNotNone(self.db.get(BinderCard, a.id))
            self.assertIsNotNone(self.db.get(BinderCard, b.id))

    def test_real_deck_removal_releases_allocations_only_for_selected_plan(self):
        a = self.entry(self.deck, quantity=2)
        allocation = self.entry(self.deck, self.a, quantity=2)
        b = self.entry(self.deck, card=self.card2)
        other_allocation = self.entry(self.deck, self.b, card=self.card2)
        allocation_id = allocation.id
        response = self.remove('decks', [a.id], self.deck)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.db.get(BinderCard, allocation_id))
        self.assertIsNotNone(self.db.get(BinderCard, b.id))
        self.assertIsNotNone(self.db.get(BinderCard, other_allocation.id))
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_planned_deck_removal_keeps_collection(self):
        a = self.entry(self.planned_deck, quantity=4)
        response = self.remove('decks', [a.id], self.planned_deck)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['removed_copies'], 4)
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_deck_allocation_ids_cannot_be_removed_as_plan_entries(self):
        a = self.entry(self.deck, quantity=2)
        allocation = self.entry(self.deck, self.a, quantity=2)
        response = self.remove('decks', [a.id, allocation.id], self.deck)
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIsNotNone(self.db.get(BinderCard, a.id))
        self.assertIsNotNone(self.db.get(BinderCard, allocation.id))

    def test_endpoints_cannot_cross_binder_and_deck_scopes(self):
        for scope, target in [('binders', self.deck), ('decks', self.binder)]:
            row = self.entry(target)
            response = self.remove(scope, [row.id], target)
            self.assertEqual(response.status_code, 404, response.text)
            self.assertIsNotNone(self.db.get(BinderCard, row.id))

    def test_invalid_requests_are_rejected_without_deleting(self):
        a = self.entry(self.binder, self.a)
        d = self.entry(self.planned_deck)
        for scope, target, ids in [('collection', None, [self.a.id]), ('binders', self.binder, [a.id]), ('decks', self.planned_deck, [d.id])]:
            for invalid in [[], ids * 2, [True], ['1'], [0], [-1], list(range(1, 502))]:
                with self.subTest(scope=scope, invalid=str(invalid)[:60]):
                    response = self.remove(scope, invalid, target)
                    self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_commit_failure_rolls_back_collection_and_photo_removal(self):
        photo = CollectionCardPhoto(user_id=self.user.id, card_id=self.card.id, data=b'own')
        self.db.add(photo); self.db.commit()
        a_id, b_id, photo_id = self.a.id, self.b.id, photo.id
        with patch.object(self.db, 'commit', side_effect=RuntimeError('synthetic commit failure')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic commit failure'):
                self.remove('collection', [a_id, b_id])
        self.db.expire_all()
        self.assertIsNotNone(self.db.get(CollectionItem, a_id))
        self.assertIsNotNone(self.db.get(CollectionItem, b_id))
        self.assertIsNotNone(self.db.get(CollectionCardPhoto, photo_id))


    def test_commit_failure_rolls_back_binder_and_deck_entries_and_allocations(self):
        for scope, target in [('binders', self.binder), ('decks', self.deck)]:
            with self.subTest(scope=scope):
                plan = self.entry(target)
                allocated = self.entry(target, self.a)
                ids = [plan.id] if scope == 'decks' else [allocated.id]
                plan_id, allocation_id = plan.id, allocated.id
                with patch.object(self.db, 'commit', side_effect=RuntimeError('synthetic commit failure')):
                    with self.assertRaisesRegex(RuntimeError, 'synthetic commit failure'):
                        self.remove(scope, ids, target)
                self.db.expire_all()
                self.assertIsNotNone(self.db.get(BinderCard, plan_id))
                self.assertIsNotNone(self.db.get(BinderCard, allocation_id))
                self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_collection_deletion_preserves_sold_product_history(self):
        product = ProductPurchase(user_id=self.user.id, product_name='Sold fixture', purchase_price=10, purchase_date=date(2026, 1, 1))
        self.db.add(product); self.db.flush()
        link = ProductCard(product_id=product.id, user_id=self.user.id, card_id=self.a.card_id,
                           collection_item_id=self.a.id, initial_quantity=3, active_quantity=0, sold_quantity=3)
        self.db.add(link); self.db.commit()
        link_id, source_id = link.id, self.a.id
        response = self.remove('collection', [source_id])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.get(ProductCard, link_id).collection_item_id, source_id)
        self.assertEqual(self.db.get(ProductCard, link_id).sold_quantity, 3)

    def test_collection_bulk_removal_cleans_only_last_selected_card_photo(self):
        second = CollectionItem(user_id=self.user.id, card_id=self.card.id, quantity=2, variant='Reverse Holo')
        photo = CollectionCardPhoto(user_id=self.user.id, card_id=self.card.id, data=b'own')
        self.db.add_all([second, photo]); self.db.commit()
        photo_id = photo.id
        response = self.remove('collection', [self.a.id, second.id])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['removed_copies'], 5)
        self.assertIsNone(self.db.get(CollectionCardPhoto, photo_id))


    def test_release_from_each_list_then_remove_only_the_collection_entry(self):
        binder_entry = self.entry(self.binder, self.a, quantity=1)
        deck_plan = self.entry(self.deck, quantity=2)
        self.entry(self.deck, self.a, quantity=2)
        a_id = self.a.id
        self.assertEqual(self.remove('collection', [a_id]).status_code, 409)
        self.assertEqual(self.remove('binders', [binder_entry.id], self.binder).status_code, 200)
        self.assertEqual(self.db.get(CollectionItem, a_id).quantity, 3)
        self.assertEqual(self.remove('collection', [a_id]).status_code, 409)
        self.assertEqual(self.remove('decks', [deck_plan.id], self.deck).status_code, 200)
        self.assertEqual(self.db.get(CollectionItem, a_id).quantity, 3)
        self.assertEqual(self.remove('collection', [a_id]).status_code, 200)
        self.assertIsNone(self.db.get(CollectionItem, a_id))
        self.assertEqual(self.db.get(CollectionItem, self.b.id).quantity, 2)
        self.assertEqual(self.db.get(CollectionItem, self.foreign.id).quantity, 7)


    def test_conflict_lists_every_card_and_releases_only_confirmed_assignments(self):
        row = self.entry(self.binder, self.a)
        plan = self.entry(self.deck, quantity=3)
        assigned = self.entry(self.deck, self.a, quantity=2)
        second = CollectionItem(user_id=self.user.id, card_id=self.card.id, quantity=2, variant='Holo')
        self.db.add(second); self.db.commit()
        untouched = self.entry(self.deck, second, quantity=1)
        foreign = self.entry(self.foreign_binder, self.foreign)
        response = self.remove('collection', [self.a.id, self.b.id])
        self.assertEqual(response.status_code, 409)
        detail = response.json()['detail']
        self.assertEqual(detail['code'], 'collection_assignment_conflict')
        self.assertEqual([c['item_id'] for c in detail['conflicts']], [self.a.id])
        card = detail['conflicts'][0]
        self.assertEqual(card['name'], 'First card')
        self.assertEqual({a['list_name'] for a in card['assignments']}, {'Physical binder', 'Real deck'})
        payload = {'item_ids': [self.a.id, self.b.id], 'assignments': [
            {k: assignment[k] for k in ['assignment_id', 'list_id', 'item_id', 'quantity']} for assignment in card['assignments']]}
        released = self.client.post('/api/collection/release-assignments', json=payload)
        self.assertEqual(released.status_code, 200, released.text)
        self.assertEqual(released.json()['released_copies'], 3)
        self.db.expire_all()
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)
        self.assertEqual(self.db.get(BinderCard, plan.id).required_quantity, 1)
        self.assertIsNotNone(self.db.get(BinderCard, untouched.id))
        self.assertIsNotNone(self.db.get(BinderCard, foreign.id))
        self.assertEqual(self.remove('collection', [self.a.id, self.b.id]).status_code, 200)
        self.assertEqual(self.db.get(CollectionItem, second.id).quantity, 2)


    def test_bulk_failure_reports_blockers_for_follow_up_calls_without_partial_changes(self):
        assignment = self.entry(self.binder, self.a)
        product, link = self.product_link(self.b)
        missing = 999999
        response = self.remove('collection', [self.a.id, self.b.id, self.foreign.id, missing])
        self.assertEqual(response.status_code, 404)
        detail = response.json()['detail']
        self.assertIsInstance(detail, dict)
        self.assertFalse(detail['changed'])
        self.assertEqual({b['item_id'] for b in detail['blockers']}, {self.a.id, self.b.id, self.foreign.id, missing})
        unavailable = [b for b in detail['blockers'] if b['code'] == 'not_found_or_not_accessible']
        self.assertEqual({b['item_id'] for b in unavailable}, {self.foreign.id, missing})
        self.assertTrue(all(set(b) <= {'code', 'resource', 'item_id', 'action'} for b in unavailable))
        self.assertEqual({r['path'] for r in detail['resolutions']}, {'/api/collection/release-assignments', '/api/products/cards/bulk-unlink'})
        for scope, target in [('binders', self.binder), ('decks', self.planned_deck)]:
            own = self.entry(target)
            failed = self.remove(scope, [own.id, missing], target)
            self.assertEqual(failed.status_code, 404)
            self.assertEqual(failed.json()['detail']['blockers'], [{'code': 'not_found_or_not_accessible', 'resource': 'list_entry', 'item_id': missing, 'action': 'remove_from_request', 'list_id': target.id}])
            self.assertFalse(failed.json()['detail']['changed'])
            self.assertIsNotNone(self.db.get(BinderCard, own.id))
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)
        self.assertEqual(self.db.get(ProductCard, link.id).active_quantity, 2)
        self.assertIsNotNone(self.db.get(BinderCard, assignment.id))

    def test_bulk_product_unlink_reports_all_blockers_and_changes_nothing(self):
        first_product, first = self.product_link()
        second_product, second = self.product_link(self.b)
        foreign_product, foreign = self.product_link(self.foreign, self.other)
        second.sold_quantity = 1; second.active_quantity = 1; self.db.commit()
        links = [{'product_id': p.id, 'product_card_id': l.id, 'collection_item_id': item.id, 'active_quantity': 2}
                 for p, l, item in [(first_product, first, self.a), (second_product, second, self.b), (foreign_product, foreign, self.foreign)]]
        links.append({'product_id': 999999, 'product_card_id': 999999, 'collection_item_id': 999999, 'active_quantity': 1})
        response = self.client.post('/api/products/cards/bulk-unlink', json={'links': links})
        self.assertEqual(response.status_code, 404)
        detail = response.json()['detail']; self.assertIsInstance(detail, dict)
        self.assertFalse(detail['changed'])
        self.assertEqual(len(detail['blockers']), 4)
        self.assertEqual({b['code'] for b in detail['blockers']}, {'product_link_changed', 'product_history_protected', 'not_found_or_not_accessible'})
        self.assertEqual({p['product_card_id'] for p in detail['current_links']}, {first.id, second.id})
        for blocker in detail['blockers']:
            if blocker['code'] == 'not_found_or_not_accessible':
                self.assertNotIn('name', blocker); self.assertNotIn('current', blocker)
        self.assertIsNotNone(self.db.get(ProductCard, first.id))
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)
        self.assertEqual(self.db.get(ProductCard, second.id).sold_quantity, 1)
        self.assertIsNotNone(self.db.get(ProductCard, foreign.id))

    def test_product_history_is_visible_before_a_resolution_call(self):
        product, link = self.product_link()
        self.db.add(ProductLedgerEntry(user_id=self.user.id, product_id=product.id, product_card_id=link.id,
                                      entry_type='trade_out', quantity=1, amount=1, event_date=date(2026, 1, 1)))
        self.db.commit()
        detail = self.remove('collection', [self.a.id]).json()['detail']
        source = detail['conflicts'][0]['products'][0]
        self.assertFalse(source['can_unlink'])
        self.assertEqual(source['unlink_blocked_reason'], 'sale_or_trade_history')
        self.assertFalse(detail['resolutions'][0]['can_execute'])
        self.assertEqual(detail['resolutions'][0]['blocked_by_history'], [link.id])

    def test_api_can_resolve_reported_blockers_then_delete_the_same_selection(self):
        p1, l1 = self.product_link(); p2, l2 = self.product_link(self.b)
        ids = [self.a.id, self.b.id]; self.entry(self.binder, self.a)
        detail = self.remove('collection', ids).json()['detail']
        for resolution in detail['resolutions']:
            response = self.client.request(resolution['method'], resolution['path'], json=resolution['body'])
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.get(CollectionItem, ids[0]).quantity, 3)
        self.assertEqual(self.db.get(CollectionItem, ids[1]).quantity, 2)
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 0)
        self.assertIsNotNone(self.db.get(ProductPurchase, p1.id)); self.assertIsNotNone(self.db.get(ProductPurchase, p2.id))
        response = self.remove('collection', ids)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['removed_ids'], ids)

    def test_bulk_product_unlink_validates_snapshots_and_rolls_back_commit_failure(self):
        p1, l1 = self.product_link(); p2, l2 = self.product_link(self.b)
        links = [{'product_id': p.id, 'product_card_id': l.id, 'collection_item_id': item.id, 'active_quantity': 2}
                 for p, l, item in [(p1, l1, self.a), (p2, l2, self.b)]]
        url = '/api/products/cards/bulk-unlink'; link_ids = [l1.id, l2.id]
        for invalid in [[], links * 2, [{**links[0], 'active_quantity': True}], [{**links[0], 'collection_item_id': '1'}], [links[0]] * 5001]:
            self.assertEqual(self.client.post(url, json={'links': invalid}).status_code, 422)
        wrong_product = [{**links[0], 'product_id': p2.id}, links[1]]
        self.assertEqual(self.client.post(url, json={'links': wrong_product}).status_code, 404)
        with patch.object(self.db, 'commit', side_effect=RuntimeError('synthetic commit failure')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic commit failure'):
                self.client.post(url, json={'links': links})
        self.db.expire_all()
        self.assertTrue(all(self.db.get(ProductCard, i) is not None for i in link_ids))
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def product_link(self, item=None, owner=None):
        item = item or self.a
        owner = owner or self.user
        product = ProductPurchase(user_id=owner.id, product_name='Linked box', purchase_price=10, purchase_date=date(2026, 1, 1), lifecycle_status='opened')
        self.db.add(product); self.db.flush()
        link = ProductCard(product_id=product.id, user_id=owner.id, card_id=item.card_id, collection_item_id=item.id, initial_quantity=2, active_quantity=2, sold_quantity=0)
        self.db.add(link); self.db.commit()
        return product, link

    def test_product_unlink_rejects_changed_confirmation_without_mutating_ownership(self):
        product, link = self.product_link()
        response = self.client.delete(f'/api/products/{product.id}/cards/{link.id}', params={'expected_collection_item_id': self.a.id, 'expected_active_quantity': 1})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNotNone(self.db.get(ProductCard, link.id))
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_confirmed_product_unlink_preserves_product_copies_photos_and_other_links(self):
        product, link = self.product_link()
        other_product, other_link = self.product_link(self.b)
        ids = (product.id, link.id, other_link.id)
        self.entry(self.binder, self.a)
        self.db.add(CollectionCardPhoto(user_id=self.user.id, card_id=self.card.id, data=b'private'))
        self.db.commit()
        response = self.client.delete(f'/api/products/{ids[0]}/cards/{ids[1]}', params={'expected_collection_item_id': self.a.id, 'expected_active_quantity': 2})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.db.get(ProductCard, ids[1]))
        self.assertIsNotNone(self.db.get(ProductPurchase, ids[0]))
        self.assertIsNotNone(self.db.get(ProductCard, ids[2]))
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)
        self.assertEqual(self.db.query(BinderCard).filter_by(collection_item_id=self.a.id).count(), 1)
        self.assertEqual(self.db.query(CollectionCardPhoto).one().data, b'private')
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 0)

    def test_product_unlink_preserves_sale_and_trade_history(self):
        product, link = self.product_link()
        for history in ['sold', 'trade_out']:
            if history == 'sold':
                link.sold_quantity = 1; link.active_quantity = 1
            else:
                link.sold_quantity = 0; link.active_quantity = 2
                self.db.add(ProductLedgerEntry(user_id=self.user.id, product_id=product.id, product_card_id=link.id, entry_type='trade_out', quantity=1, amount=2, event_date=date(2026, 1, 1)))
            self.db.commit()
            response = self.client.delete(f'/api/products/{product.id}/cards/{link.id}', params={'expected_collection_item_id': self.a.id, 'expected_active_quantity': link.active_quantity})
            self.assertEqual(response.status_code, 409)
            self.assertIsNotNone(self.db.get(ProductCard, link.id))
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 1)

    def test_product_unlink_validates_complete_snapshot_and_owner(self):
        product, link = self.product_link()
        url = f'/api/products/{product.id}/cards/{link.id}'
        for params in [{'expected_collection_item_id': self.a.id}, {'expected_active_quantity': 2}, {'expected_collection_item_id': 0, 'expected_active_quantity': 2}, {'expected_collection_item_id': self.a.id, 'expected_active_quantity': 1000}]:
            self.assertEqual(self.client.delete(url, params=params).status_code, 422)
        self.assertEqual(self.client.delete(url, params={'expected_collection_item_id': self.b.id, 'expected_active_quantity': 2}).status_code, 409)
        foreign_product, foreign_link = self.product_link(self.foreign, self.other)
        self.assertEqual(self.client.delete(f'/api/products/{foreign_product.id}/cards/{foreign_link.id}', params={'expected_collection_item_id': self.foreign.id, 'expected_active_quantity': 2}).status_code, 404)
        self.assertIsNotNone(self.db.get(ProductCard, link.id))
        self.assertIsNotNone(self.db.get(ProductCard, foreign_link.id))

    def test_bulk_actions_and_guarded_unlink_are_exposed_in_openapi(self):
        schema = self.client.get('/openapi.json').json()['paths']
        for path in ['/api/collection/bulk-delete', '/api/collection/release-assignments', '/api/binders/{binder_id}/entries/bulk-delete', '/api/decks/{deck_id}/entries/bulk-delete']:
            self.assertIn('post', schema[path])
        parameters = schema['/api/products/{product_id}/cards/{product_card_id}']['delete']['parameters']
        self.assertTrue({'expected_collection_item_id', 'expected_active_quantity'}.issubset({p['name'] for p in parameters}))

    def assignment_payload(self, ids):
        detail = self.remove('collection', ids).json()['detail']
        return {'item_ids': ids, 'assignments': [
            {k: assignment[k] for k in ['assignment_id', 'list_id', 'item_id', 'quantity']}
            for card in detail['conflicts'] for assignment in card['assignments']]}

    def test_release_rejects_stale_quantities_new_assignments_and_foreign_items(self):
        row = self.entry(self.binder, self.a)
        payload = self.assignment_payload([self.a.id])
        row.required_quantity = 2; self.db.commit()
        response = self.client.post('/api/collection/release-assignments', json=payload)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['detail']['code'], 'collection_assignments_changed')
        self.assertEqual(self.db.get(BinderCard, row.id).required_quantity, 2)
        current = self.assignment_payload([self.a.id])
        self.entry(self.deck, self.a)
        self.assertEqual(self.client.post('/api/collection/release-assignments', json=current).status_code, 409)
        current['item_ids'].append(self.foreign.id)
        response = self.client.post('/api/collection/release-assignments', json=current)
        self.assertEqual(response.status_code, 404)
        self.assertNotIn('bulk-other', response.text)
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_release_rollback_keeps_plans_photos_and_ownership(self):
        plan = self.entry(self.deck, quantity=2)
        allocated = self.entry(self.deck, self.a, quantity=2)
        photo = CollectionCardPhoto(user_id=self.user.id, card_id=self.card.id, data=b'own')
        self.db.add(photo); self.db.commit()
        ids = (plan.id, allocated.id, photo.id)
        payload = self.assignment_payload([self.a.id])
        with patch.object(self.db, 'commit', side_effect=RuntimeError('synthetic commit failure')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic commit failure'):
                self.client.post('/api/collection/release-assignments', json=payload)
        self.db.expire_all()
        self.assertEqual(self.db.get(BinderCard, ids[0]).required_quantity, 2)
        self.assertIsNotNone(self.db.get(BinderCard, ids[1]))
        self.assertEqual(self.db.get(CollectionCardPhoto, ids[2]).data, b'own')
        self.assertEqual(self.db.get(CollectionItem, self.a.id).quantity, 3)

    def test_conflict_reports_all_products_and_assignments_without_detaching_products(self):
        self.entry(self.binder, self.a)
        product = ProductPurchase(user_id=self.user.id, product_name='Protected source', purchase_price=10, purchase_date=date(2026, 1, 1))
        self.db.add(product); self.db.flush()
        link = ProductCard(product_id=product.id, user_id=self.user.id, card_id=self.b.card_id,
                           collection_item_id=self.b.id, initial_quantity=2, active_quantity=2, sold_quantity=0)
        self.db.add(link); self.db.commit()
        detail = self.remove('collection', [self.a.id, self.b.id]).json()['detail']
        self.assertEqual(len(detail['conflicts']), 2)
        self.assertEqual(detail['conflicts'][1]['products'][0]['product_name'], 'Protected source')
        payload = self.assignment_payload([self.a.id, self.b.id])
        self.assertEqual(self.client.post('/api/collection/release-assignments', json=payload).status_code, 200)
        self.assertEqual(self.db.get(ProductCard, link.id).active_quantity, 2)
        self.assertEqual(self.remove('collection', [self.a.id, self.b.id]).status_code, 409)
        self.assertIsNotNone(self.db.get(CollectionItem, self.a.id))


if __name__ == '__main__':
    unittest.main()
