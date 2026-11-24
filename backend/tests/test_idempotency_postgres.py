"""Opt-in checks for idempotency behaviour that SQLite cannot exercise."""

import concurrent.futures
import datetime
import os
import threading
import unittest
import uuid

try:
    from fastapi import HTTPException
    from sqlalchemy import text

    from api.wishlist import add_to_wishlist
    from database import SessionLocal, init_db
    from models import Card, IdempotencyKey, User, WishlistItem
    from schemas import WishlistItemCreate
    from services.idempotency import begin_idempotent, fingerprint_json

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


POSTGRES_TEST_ENABLED = (
    DEPS_AVAILABLE
    and os.environ.get("IDEMPOTENCY_POSTGRES_TEST") == "1"
    and os.environ.get("DATABASE_URL", "").startswith("postgresql")
)


class _Request:
    def __init__(self, headers):
        self.headers = headers


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires the isolated PostgreSQL idempotency test database")
class IdempotencyPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.prefix = f"idem-pg-{uuid.uuid4().hex}"
        self.key = uuid.uuid4().hex
        db = SessionLocal()
        try:
            self.user = User(username=f"{self.prefix}-user", hashed_password="x", is_active=True)
            self.card = Card(
                id=f"{self.prefix}_en", tcg_card_id=self.prefix, name="Idem Test", set_id="idem",
                number="1", lang="en", variants_normal=True,
            )
            db.add_all([self.user, self.card])
            db.commit()
            self.user_id = self.user.id
            self.card_id = self.card.id
        finally:
            db.close()

    def tearDown(self):
        db = SessionLocal()
        try:
            db.query(WishlistItem).filter(WishlistItem.card_id == self.card_id).delete()
            db.query(IdempotencyKey).filter(IdempotencyKey.user_id == self.user_id).delete()
            db.query(Card).filter(Card.id == self.card_id).delete()
            db.query(User).filter(User.id == self.user_id).delete()
            db.commit()
        finally:
            db.close()

    def _user(self, db):
        return db.get(User, self.user_id)

    def _add(self, quantity=1):
        db = SessionLocal()
        try:
            return add_to_wishlist(
                WishlistItemCreate(card_id=self.card_id, quantity=quantity),
                current_user=self._user(db),
                db=db,
                request=_Request({"Idempotency-Key": self.key}),
            )
        finally:
            db.close()

    @staticmethod
    def _body(result):
        return result if isinstance(result, dict) else bytes(result.body)

    def test_table_has_unique_constraint_and_expiry_index(self):
        db = SessionLocal()
        try:
            constraints = {
                row[0] for row in db.execute(text(
                    "SELECT conname FROM pg_constraint WHERE conrelid = 'idempotency_keys'::regclass"
                ))
            }
            indexes = {
                row[0] for row in db.execute(text(
                    "SELECT indexname FROM pg_indexes WHERE tablename = 'idempotency_keys'"
                ))
            }
        finally:
            db.close()
        self.assertIn("uq_idempotency_user_key", constraints)
        self.assertIn("ix_idempotency_keys_expires_at", indexes)

    def test_sequential_replay_applies_once(self):
        first = self._add(quantity=2)
        second = self._add(quantity=2)

        self.assertIsInstance(first, dict)
        self.assertEqual(second.headers["Idempotent-Replayed"], "true")
        db = SessionLocal()
        try:
            self.assertEqual(
                db.query(WishlistItem).filter(WishlistItem.card_id == self.card_id).one().quantity, 2
            )
        finally:
            db.close()

    def test_two_threads_same_key_have_one_effect(self):
        barrier = threading.Barrier(2)

        def attempt():
            barrier.wait(timeout=10)
            try:
                return ("ok", self._add(quantity=3))
            except HTTPException as exc:
                return ("http", exc)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [future.result(timeout=60) for future in [pool.submit(attempt), pool.submit(attempt)]]

        for kind, value in outcomes:
            if kind == "http":
                self.assertEqual(value.status_code, 409)
                self.assertEqual(value.detail["code"], "idempotency_in_progress")

        # Whatever the interleaving, the effect happened exactly once...
        db = SessionLocal()
        try:
            self.assertEqual(
                db.query(WishlistItem).filter(WishlistItem.card_id == self.card_id).one().quantity, 3
            )
            self.assertEqual(db.query(IdempotencyKey).filter(IdempotencyKey.user_id == self.user_id).count(), 1)
        finally:
            db.close()
        # ...and a retry after the dust settles is a replay.
        self.assertEqual(self._add(quantity=3).headers["Idempotent-Replayed"], "true")

    def test_held_advisory_lock_returns_409_without_waiting(self):
        holder = SessionLocal()
        contender = SessionLocal()
        try:
            user = self._user(holder)
            begin_idempotent(
                holder, user, {"Idempotency-Key": self.key},
                scope="wishlist.add", fingerprint=fingerprint_json("wishlist.add", {}),
            )
            started = datetime.datetime.utcnow()
            with self.assertRaises(HTTPException) as caught:
                begin_idempotent(
                    contender, self._user(contender), {"Idempotency-Key": self.key},
                    scope="wishlist.add", fingerprint=fingerprint_json("wishlist.add", {}),
                )
            elapsed = datetime.datetime.utcnow() - started
        finally:
            contender.rollback()
            contender.close()
            holder.rollback()
            holder.close()

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail["code"], "idempotency_in_progress")
        self.assertEqual(caught.exception.headers["Retry-After"], "2")
        self.assertLess(elapsed, datetime.timedelta(seconds=5))

    def test_deleting_the_user_cascades_to_keys(self):
        self._add()
        db = SessionLocal()
        try:
            self.assertEqual(db.query(IdempotencyKey).filter(IdempotencyKey.user_id == self.user_id).count(), 1)
            db.query(WishlistItem).filter(WishlistItem.card_id == self.card_id).delete()
            db.execute(text("DELETE FROM users WHERE id = :id"), {"id": self.user_id})
            db.commit()
            self.assertEqual(db.query(IdempotencyKey).filter(IdempotencyKey.user_id == self.user_id).count(), 0)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
