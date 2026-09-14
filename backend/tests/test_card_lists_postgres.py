"""Opt-in PostgreSQL checks for Card List locking that SQLite cannot exercise."""

import concurrent.futures
import datetime
import os
import threading
import unittest
import uuid
from unittest.mock import patch

try:
    from fastapi import HTTPException

    from api.binders import switch_binder_entry_card
    from api.collection import update_collection_item
    from api.decks import (
        convert_deck_to_planned,
        convert_deck_to_real,
        delete_deck,
        delete_deck_entry,
        update_deck_entry,
    )
    from database import SessionLocal, _run_migrations, engine, init_db
    from models import Binder, BinderCard, Card, CollectionItem, User
    from schemas import BinderCardSwitch, CollectionItemUpdate, DeckEntryUpdate

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


POSTGRES_TEST_ENABLED = (
    DEPS_AVAILABLE
    and os.environ.get("CARD_LISTS_POSTGRES_TEST") == "1"
    and os.environ.get("DATABASE_URL", "").startswith("postgresql")
)


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires an isolated PostgreSQL Card Lists test database")
class CardListsPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.prefix = f"card-lists-pg-{uuid.uuid4().hex}"
        self.source_card_id = f"{self.prefix}-card_en"
        self.target_card_id = f"{self.prefix}-card-alt_en"
        self.language_card_id = f"{self.prefix}-card_de"
        db = SessionLocal()
        try:
            user = User(username=self.prefix, hashed_password="x", is_active=True)
            source = Card(
                id=self.source_card_id,
                tcg_card_id=f"{self.prefix}-card",
                name="Concurrency Card",
                number="1",
                lang="en",
                supertype="Pokemon",
                playable_fingerprint=f"{self.prefix}-fingerprint",
                variants_normal=True,
            )
            target = Card(
                id=self.target_card_id,
                tcg_card_id=f"{self.prefix}-card-alt",
                name="Concurrency Card",
                number="2",
                lang="en",
                supertype="Pokemon",
                playable_fingerprint=source.playable_fingerprint,
                variants_normal=True,
            )
            db.add_all([user, source, target])
            db.flush()
            source_item = CollectionItem(
                user_id=user.id,
                card_id=source.id,
                quantity=4,
                condition="NM",
                variant="Normal",
                lang="en",
            )
            target_item = CollectionItem(
                user_id=user.id,
                card_id=target.id,
                quantity=4,
                condition="NM",
                variant="Normal",
                lang="en",
            )
            deck = Binder(
                name="Concurrent Deck",
                user_id=user.id,
                binder_type="deck",
                format="Standard",
                target_size=60,
                created_at=datetime.datetime.utcnow(),
                updated_at=datetime.datetime.utcnow(),
            )
            db.add_all([source_item, target_item, deck])
            db.flush()
            entry = BinderCard(
                binder_id=deck.id,
                card_id=source.id,
                required_quantity=4,
                added_at=datetime.datetime.utcnow(),
            )
            db.add(entry)
            db.commit()
            self.user_id = user.id
            self.deck_id = deck.id
            self.entry_id = entry.id
            self.source_item_id = source_item.id
        finally:
            db.close()

    def tearDown(self):
        db = SessionLocal()
        try:
            binder_ids = [row[0] for row in db.query(Binder.id).filter(Binder.user_id == self.user_id).all()]
            if binder_ids:
                db.query(BinderCard).filter(BinderCard.binder_id.in_(binder_ids)).delete(synchronize_session=False)
                db.query(Binder).filter(Binder.id.in_(binder_ids)).delete(synchronize_session=False)
            db.query(CollectionItem).filter(CollectionItem.user_id == self.user_id).delete(synchronize_session=False)
            db.query(Card).filter(
                Card.id.in_([self.source_card_id, self.target_card_id, self.language_card_id])
            ).delete(synchronize_session=False)
            db.query(User).filter(User.id == self.user_id).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _call(self, operation):
        db = SessionLocal()
        try:
            user = db.get(User, self.user_id)
            return operation(db, user)
        except HTTPException as exc:
            db.rollback()
            return exc.status_code
        finally:
            db.close()

    def _race(self, left, right):
        barrier = threading.Barrier(2)

        def synchronized(operation):
            barrier.wait(timeout=5)
            return self._call(operation)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(synchronized, operation) for operation in (left, right)]
            return [future.result(timeout=10) for future in futures]

    def _convert(self, deck_id=None):
        return lambda db, user: convert_deck_to_real(
            deck_id or self.deck_id,
            current_user=user,
            db=db,
        )

    def _stored_state(self, deck_id=None):
        db = SessionLocal()
        try:
            target_deck_id = deck_id or self.deck_id
            deck = db.get(Binder, target_deck_id)
            plan = db.query(BinderCard).filter(
                BinderCard.id == self.entry_id,
                BinderCard.collection_item_id.is_(None),
            ).first() if target_deck_id == self.deck_id else None
            allocations = db.query(BinderCard).filter(
                BinderCard.binder_id == target_deck_id,
                BinderCard.collection_item_id.isnot(None),
            ).all()
            return deck, plan, [(row.card_id, int(row.required_quantity or 0)) for row in allocations]
        finally:
            db.close()

    def test_conversion_and_quantity_reduction_finish_with_matching_allocations(self):
        self._race(
            self._convert(),
            lambda db, user: update_deck_entry(
                self.deck_id,
                self.entry_id,
                DeckEntryUpdate(required_quantity=1),
                current_user=user,
                db=db,
            ),
        )
        deck, plan, allocations = self._stored_state()
        self.assertEqual(deck.binder_type, "physical_deck")
        self.assertEqual(plan.required_quantity, 1)
        self.assertEqual(sum(quantity for _card_id, quantity in allocations), 1)

    def test_conversion_and_entry_deletion_leave_no_orphaned_allocations(self):
        self._race(
            self._convert(),
            lambda db, user: delete_deck_entry(
                self.deck_id,
                self.entry_id,
                current_user=user,
                db=db,
            ),
        )
        _deck, plan, allocations = self._stored_state()
        self.assertIsNone(plan)
        self.assertEqual(allocations, [])

    def test_conversion_and_deck_deletion_leave_no_orphaned_rows(self):
        self._race(
            self._convert(),
            lambda db, user: delete_deck(self.deck_id, current_user=user, db=db),
        )
        deck, _plan, allocations = self._stored_state()
        self.assertIsNone(deck)
        self.assertEqual(allocations, [])

    def test_conversion_and_release_have_a_coherent_last_writer_result(self):
        self._race(
            self._convert(),
            lambda db, user: convert_deck_to_planned(self.deck_id, current_user=user, db=db),
        )
        deck, plan, allocations = self._stored_state()
        self.assertIsNotNone(plan)
        if deck.binder_type == "deck":
            self.assertEqual(allocations, [])
        else:
            self.assertEqual(sum(quantity for _card_id, quantity in allocations), plan.required_quantity)

    def test_conversion_and_print_switch_never_mix_plan_and_allocation_prints(self):
        self._race(
            self._convert(),
            lambda db, user: switch_binder_entry_card(
                self.deck_id,
                self.entry_id,
                BinderCardSwitch(card_id=self.target_card_id),
                current_user=user,
                db=db,
            ),
        )
        _deck, plan, allocations = self._stored_state()
        self.assertTrue(all(card_id == plan.card_id for card_id, _quantity in allocations))
        self.assertLessEqual(sum(quantity for _card_id, quantity in allocations), plan.required_quantity)

    def test_opposite_entry_orders_do_not_deadlock_overlapping_conversions(self):
        db = SessionLocal()
        try:
            first_deck = db.get(Binder, self.deck_id)
            second = Binder(
                name="Opposite order",
                user_id=self.user_id,
                binder_type="deck",
                format="Standard",
                target_size=60,
                created_at=datetime.datetime.utcnow(),
                updated_at=datetime.datetime.utcnow(),
            )
            db.add(second)
            db.flush()
            db.add(BinderCard(binder_id=first_deck.id, card_id=self.target_card_id, required_quantity=4))
            db.add(BinderCard(binder_id=second.id, card_id=self.target_card_id, required_quantity=4))
            db.flush()
            db.add(BinderCard(binder_id=second.id, card_id=self.source_card_id, required_quantity=4))
            db.commit()
            second_id = second.id
        finally:
            db.close()

        results = self._race(self._convert(self.deck_id), self._convert(second_id))

        self.assertEqual(sum(result != 409 for result in results), 1)
        db = SessionLocal()
        try:
            real_decks = db.query(Binder).filter(
                Binder.id.in_([self.deck_id, second_id]),
                Binder.binder_type == "physical_deck",
            ).count()
            self.assertEqual(real_decks, 1)
            for card_id in (self.source_card_id, self.target_card_id):
                allocated = db.query(BinderCard).filter(
                    BinderCard.card_id == card_id,
                    BinderCard.collection_item_id.isnot(None),
                ).all()
                self.assertLessEqual(sum(int(row.required_quantity or 0) for row in allocated), 4)
        finally:
            db.close()

    def test_uncached_language_change_relocks_before_checking_real_deck_allocations(self):
        cached = threading.Event()
        conversion_done = threading.Event()

        def cache_target(db, card_id, lang, **_kwargs):
            target = Card(
                id=card_id,
                tcg_card_id=f"{self.prefix}-card",
                name="Concurrency Card",
                number="1",
                lang=lang,
                supertype="Pokemon",
                playable_fingerprint=f"{self.prefix}-fingerprint",
                variants_normal=True,
            )
            db.add(target)
            db.commit()
            cached.set()
            self.assertTrue(conversion_done.wait(timeout=10))
            return target

        def change_language():
            return self._call(lambda db, user: update_collection_item(
                self.source_item_id,
                CollectionItemUpdate(lang="de"),
                current_user=user,
                db=db,
            ))

        with patch("api.collection.ensure_card_exists", side_effect=cache_target):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(change_language)
                self.assertTrue(cached.wait(timeout=10))
                self._call(self._convert())
                conversion_done.set()
                result = future.result(timeout=10)

        self.assertEqual(result, 409)
        db = SessionLocal()
        try:
            item = db.get(CollectionItem, self.source_item_id)
            self.assertEqual((item.card_id, item.lang), (self.source_card_id, "en"))
            allocation = db.query(BinderCard).filter(
                BinderCard.binder_id == self.deck_id,
                BinderCard.collection_item_id == self.source_item_id,
            ).one()
            self.assertEqual(allocation.card_id, self.source_card_id)
        finally:
            db.close()

    def test_standalone_pr_decks_migrate_once_as_planned_card_lists(self):
        legacy_deck_id = None
        try:
            with engine.begin() as conn:
                conn.exec_driver_sql("""CREATE TABLE IF NOT EXISTS decks (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR NOT NULL,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    target_size INTEGER NOT NULL DEFAULT 60,
                    description TEXT,
                    format VARCHAR NOT NULL DEFAULT 'Casual',
                    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                )""")
                conn.exec_driver_sql("""CREATE TABLE IF NOT EXISTS deck_entries (
                    id SERIAL PRIMARY KEY,
                    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                    card_id VARCHAR NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                    required_quantity INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP NOT NULL DEFAULT NOW()
                )""")
                legacy_deck_id = conn.exec_driver_sql(
                    """INSERT INTO decks (name, user_id, target_size, description, format)
                       VALUES (%s, %s, 40, 'Legacy description', 'Expanded')
                       RETURNING id""",
                    (f"{self.prefix}-legacy", self.user_id),
                ).scalar_one()
                conn.exec_driver_sql(
                    """INSERT INTO deck_entries (deck_id, card_id, required_quantity)
                       VALUES (%s, %s, 120)""",
                    (legacy_deck_id, self.source_card_id),
                )

            for _ in range(2):
                with engine.connect() as conn:
                    _run_migrations(conn)

            db = SessionLocal()
            try:
                migrated = db.query(Binder).filter(Binder.legacy_deck_id == legacy_deck_id).one()
                self.assertEqual(
                    (migrated.binder_type, migrated.target_size, migrated.format, migrated.description),
                    ("deck", 40, "Expanded", "Legacy description"),
                )
                entries = db.query(BinderCard).filter(
                    BinderCard.binder_id == migrated.id,
                    BinderCard.collection_item_id.is_(None),
                ).all()
                self.assertEqual(len(entries), 1)
                self.assertEqual((entries[0].card_id, entries[0].required_quantity), (self.source_card_id, 99))
                db.delete(migrated)
                db.commit()
            finally:
                db.close()

            # The source tables are deliberately retained for rollback/history.
            # A durable migration ledger must therefore prevent deleted user
            # data from being recreated on a later application startup.
            with engine.connect() as conn:
                _run_migrations(conn)
            db = SessionLocal()
            try:
                self.assertEqual(
                    db.query(Binder).filter(Binder.legacy_deck_id == legacy_deck_id).count(),
                    0,
                )
            finally:
                db.close()
        finally:
            if legacy_deck_id is not None:
                with engine.begin() as conn:
                    conn.exec_driver_sql(
                        "DELETE FROM card_list_legacy_deck_migrations WHERE legacy_deck_id = %s",
                        (legacy_deck_id,),
                    )
                    conn.exec_driver_sql("DELETE FROM deck_entries WHERE deck_id = %s", (legacy_deck_id,))
                    conn.exec_driver_sql("DELETE FROM decks WHERE id = %s", (legacy_deck_id,))


if __name__ == "__main__":
    unittest.main()
