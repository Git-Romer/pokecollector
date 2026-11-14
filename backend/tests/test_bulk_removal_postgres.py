"""Run the removal contract and real lock-race tests against an isolated PostgreSQL schema.

Set BULK_REMOVAL_POSTGRES_URL to an explicitly approved test database. The tests
create and remove only their randomly named schema, never existing tables.
"""
import os
import queue
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

import test_bulk_removal as base
from api.collection import bulk_remove_collection_items
from models import BinderCard, CollectionItem, User, ProductCard, ProductPurchase, ProductLedgerEntry
from schemas import BulkRemoveRequest, BulkProductUnlinkRequest
from services.product_card_unlink import unlink_confirmed_product_cards


@unittest.skipUnless(os.environ.get('BULK_REMOVAL_POSTGRES_URL'), 'Requires an isolated PostgreSQL test database')
class PostgresBulkRemovalTests(base.BulkRemovalTests):
    def make_engine(self):
        url = os.environ['BULK_REMOVAL_POSTGRES_URL']
        admin = create_engine(url)
        schema = 'bulk_removal_test_' + uuid.uuid4().hex
        with admin.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={'options': f'-csearch_path={schema}'})
        def cleanup():
            engine.dispose()
            try:
                with admin.begin() as connection:
                    connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            finally:
                admin.dispose()
        self.addCleanup(cleanup)
        return engine

    def test_concurrent_allocation_blocks_collection_removal_before_any_delete(self):
        user_id, a_id, b_id, binder_id, card_id = self.user.id, self.a.id, self.b.id, self.binder.id, self.card.id
        started = queue.Queue()
        def remove():
            with Session(self.engine) as session:
                user = session.get(User, user_id)
                started.put(session.execute(text('SELECT pg_backend_pid()')).scalar_one())
                return bulk_remove_collection_items(BulkRemoveRequest(item_ids=[a_id, b_id]), current_user=user, db=session)
        with Session(self.engine) as blocker, ThreadPoolExecutor(max_workers=1) as executor:
            blocker.execute(text('SELECT id FROM users WHERE id = :id FOR UPDATE'), {'id': user_id})
            future = executor.submit(remove)
            try:
                pid = started.get(timeout=5)
                deadline = time.monotonic() + 5
                waiting = None
                while time.monotonic() < deadline:
                    with self.engine.connect() as probe:
                        waiting = probe.execute(text('SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid'), {'pid': pid}).scalar_one_or_none()
                    if waiting == 'Lock':
                        break
                    time.sleep(0.02)
                self.assertEqual(waiting, 'Lock', 'Removal must wait on the established per-user allocation lock')
                blocker.add(BinderCard(binder_id=binder_id, card_id=card_id, collection_item_id=a_id, required_quantity=1))
                blocker.commit()
                with self.assertRaises(HTTPException) as caught:
                    future.result(timeout=5)
                self.assertEqual(caught.exception.status_code, 409)
            finally:
                blocker.rollback()
        self.db.expire_all()
        self.assertEqual(self.db.get(CollectionItem, a_id).quantity, 3)
        self.assertEqual(self.db.get(CollectionItem, b_id).quantity, 2)

    def test_concurrent_history_blocks_every_product_unlink(self):
        p1, l1 = self.product_link(); p2, l2 = self.product_link(self.b)
        user_id, p2_id, l2_id = self.user.id, p2.id, l2.id
        link_ids = [l1.id, l2.id]
        request = BulkProductUnlinkRequest(links=[{'product_id': p.id, 'product_card_id': l.id,
            'collection_item_id': item.id, 'active_quantity': 2} for p, l, item in [(p1, l1, self.a), (p2, l2, self.b)]])
        started = queue.Queue()
        def unlink():
            with Session(self.engine) as session:
                user = session.get(User, user_id)
                started.put(session.execute(text('SELECT pg_backend_pid()')).scalar_one())
                return unlink_confirmed_product_cards(session, user, request)
        with Session(self.engine) as blocker, ThreadPoolExecutor(max_workers=1) as executor:
            blocker.query(ProductPurchase).filter_by(id=p2_id).with_for_update().one()
            future = executor.submit(unlink)
            try:
                pid = started.get(timeout=5); deadline = time.monotonic() + 5; waiting = None
                while time.monotonic() < deadline:
                    with self.engine.connect() as probe:
                        waiting = probe.execute(text('SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid'), {'pid': pid}).scalar_one_or_none()
                    if waiting == 'Lock': break
                    time.sleep(0.02)
                self.assertEqual(waiting, 'Lock')
                from datetime import date
                blocker.add(ProductLedgerEntry(user_id=user_id, product_id=p2_id, product_card_id=l2_id,
                    entry_type='trade_out', quantity=1, amount=1, event_date=date(2026, 1, 1)))
                blocker.commit()
                with self.assertRaises(HTTPException) as caught:
                    future.result(timeout=5)
                self.assertEqual(caught.exception.status_code, 409)
                self.assertEqual(caught.exception.detail['blockers'][0]['code'], 'product_history_protected')
            finally:
                blocker.rollback()
        self.db.expire_all()
        self.assertTrue(all(self.db.get(ProductCard, i) is not None for i in link_ids))


if __name__ == '__main__':
    unittest.main()
