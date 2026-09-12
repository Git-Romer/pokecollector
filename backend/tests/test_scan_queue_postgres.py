"""Opt-in checks for queue behavior that SQLite cannot exercise."""

import concurrent.futures
import datetime
import os
import threading
import unittest
import uuid
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import inspect, text

    from api.scan_jobs import ResolveAndAddScanItemRequest, resolve_and_add_scan_job_item
    from database import SessionLocal, init_db
    from models import (
        Card,
        CollectionItem,
        GeminiQuotaState,
        ScanJob,
        ScanJobItem,
        ScanQueueUserState,
        User,
    )
    from services import gemini_rate_limit
    from services.scan_queue import claim_next_scan_item

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


POSTGRES_TEST_ENABLED = (
    DEPS_AVAILABLE
    and os.environ.get("SCAN_QUEUE_POSTGRES_TEST") == "1"
    and os.environ.get("DATABASE_URL", "").startswith("postgresql")
)


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires the isolated PostgreSQL queue test database")
class ScanQueuePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.prefix = f"queue-pg-{uuid.uuid4().hex}"
        db = SessionLocal()
        try:
            self.users = [
                User(username=f"{self.prefix}-a", hashed_password="x"),
                User(username=f"{self.prefix}-b", hashed_password="x"),
            ]
            db.add_all(self.users)
            db.flush()
            now = datetime.datetime.utcnow()
            for user in self.users:
                job = ScanJob(
                    user_id=user.id,
                    status="pending",
                    created_at=now,
                    updated_at=now,
                    expires_at=now + datetime.timedelta(days=14),
                )
                db.add(job)
                db.flush()
                db.execute(
                    text(
                        "INSERT INTO scan_queue_user_state (user_id, last_dispatched_at) "
                        "VALUES (:user_id, NULL) ON CONFLICT (user_id) DO NOTHING"
                    ),
                    {"user_id": user.id},
                )
                for position in range(4):
                    db.add(ScanJobItem(
                        job_id=job.id,
                        user_id=user.id,
                        position=position,
                        image_path=f"{job.id}/{position}.jpg",
                        content_type="image/jpeg",
                        byte_size=4,
                        status="pending",
                        batch_mode=True,
                        resolved=False,
                        attempts=0,
                        transient_failures=0,
                        next_attempt_at=now,
                        created_at=now,
                        updated_at=now,
                    ))
            db.commit()
            self.user_ids = [user.id for user in self.users]
        finally:
            db.close()

    def tearDown(self):
        db = SessionLocal()
        try:
            db.query(User).filter(User.username.like(f"{self.prefix}%")).delete(
                synchronize_session=False
            )
            db.commit()
        finally:
            db.close()

    def test_migration_created_queue_tables(self):
        table_names = set(inspect(SessionLocal.kw["bind"]).get_table_names())
        self.assertTrue(
            {
                "scan_jobs",
                "scan_job_items",
                "scan_queue_user_state",
                "gemini_quota_state",
            }.issubset(table_names)
        )

    def test_two_workers_claim_distinct_composite_groups_atomically(self):
        def claim():
            db = SessionLocal()
            try:
                return claim_next_scan_item(db)
            finally:
                db.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(executor.map(lambda _index: claim(), range(2)))

        self.assertTrue(all(claims))
        self.assertEqual(len({claim.item_id for claim in claims}), 2)
        self.assertTrue(all(claim.composite for claim in claims))
        self.assertTrue(all(len(claim.all_item_ids) == 4 for claim in claims))
        self.assertTrue(set(claims[0].all_item_ids).isdisjoint(claims[1].all_item_ids))


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires the isolated PostgreSQL queue test database")
class AtomicScanResolvePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.prefix = f"atomic-resolve-{uuid.uuid4().hex}"
        db = SessionLocal()
        try:
            user = User(username=self.prefix, hashed_password="x", is_active=True)
            db.add(user)
            db.flush()
            card_id = f"{self.prefix}-card"
            db.add(Card(
                id=f"{card_id}_en",
                tcg_card_id=card_id,
                name="Concurrency card",
                number="1",
                lang="en",
                is_custom=False,
            ))
            now = datetime.datetime.utcnow()
            job = ScanJob(
                user_id=user.id,
                status="done",
                created_at=now,
                updated_at=now,
                finished_at=now,
                expires_at=now + datetime.timedelta(days=14),
            )
            db.add(job)
            db.flush()
            item = ScanJobItem(
                job_id=job.id,
                user_id=user.id,
                position=0,
                image_path=None,
                content_type="image/jpeg",
                byte_size=0,
                batch_mode=False,
                status="done",
                resolved=False,
                attempts=1,
                transient_failures=0,
                matches=[{"id": f"{card_id}_en", "tcg_card_id": card_id}],
                created_at=now,
                updated_at=now,
            )
            db.add(item)
            db.commit()
            self.user_id = user.id
            self.job_id = job.id
            self.item_id = item.id
            self.card_id = card_id
        finally:
            db.close()

    def tearDown(self):
        db = SessionLocal()
        try:
            db.query(CollectionItem).filter(
                CollectionItem.user_id == self.user_id
            ).delete(synchronize_session=False)
            db.query(User).filter(User.id == self.user_id).delete(
                synchronize_session=False
            )
            db.query(Card).filter(Card.id == f"{self.card_id}_en").delete(
                synchronize_session=False
            )
            db.commit()
        finally:
            db.close()

    def test_concurrent_add_and_resolve_increments_collection_once(self):
        from api import scan_jobs

        request = ResolveAndAddScanItemRequest(
            confirmed_card_id=self.card_id,
            card_id=f"{self.card_id}_en",
            quantity=1,
            condition="NM",
            variant="Normal",
            lang="en",
        )
        barrier = threading.Barrier(2)
        original_get = scan_jobs._get_own_item

        def synchronized_get(*args, **kwargs):
            row = original_get(*args, **kwargs)
            if not kwargs.get("for_update", False):
                barrier.wait(timeout=5)
            return row

        def resolve():
            db = SessionLocal()
            try:
                user = db.get(User, self.user_id)
                return resolve_and_add_scan_job_item(
                    self.job_id,
                    self.item_id,
                    request,
                    db,
                    user,
                )
            except HTTPException as exc:
                return exc.status_code
            finally:
                db.close()

        with patch("api.scan_jobs._get_own_item", side_effect=synchronized_get), patch(
            "services.scan_trace.record_ground_truth", return_value=0
        ), concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: resolve(), range(2)))

        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(results.count(409), 1)
        db = SessionLocal()
        try:
            self.assertTrue(db.get(ScanJobItem, self.item_id).resolved)
            self.assertEqual(
                db.query(CollectionItem)
                .filter(CollectionItem.user_id == self.user_id)
                .one()
                .quantity,
                1,
            )
        finally:
            db.close()


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires the isolated PostgreSQL queue test database")
class GeminiQuotaPostgresConcurrencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.api_key = f"quota-pg-{uuid.uuid4().hex}"
        self.fingerprint = gemini_rate_limit.key_fingerprint(self.api_key)

    def tearDown(self):
        db = SessionLocal()
        try:
            db.query(GeminiQuotaState).filter(
                GeminiQuotaState.key_fingerprint == self.fingerprint
            ).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _state(self):
        db = SessionLocal()
        try:
            state = db.get(GeminiQuotaState, self.fingerprint)
            self.assertIsNotNone(state)
            db.expunge(state)
            return state
        finally:
            db.close()

    def test_provider_delay_wins_concurrent_missing_daily_fallback(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    gemini_rate_limit.penalize_gemini_key,
                    self.api_key,
                    reason="daily_quota",
                ),
                executor.submit(
                    gemini_rate_limit.penalize_gemini_key,
                    self.api_key,
                    seconds=41,
                    reason="daily_quota",
                ),
            ]
            [future.result() for future in futures]

        state = self._state()
        remaining = (state.blocked_until - datetime.datetime.utcnow()).total_seconds()
        self.assertEqual(state.blocked_reason, "daily_quota")
        self.assertEqual(state.consecutive_daily_failures, 0)
        self.assertGreater(remaining, 35)
        self.assertLessEqual(remaining, 41)

    def test_daily_quota_wins_concurrent_short_term_limit(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    gemini_rate_limit.penalize_gemini_key,
                    self.api_key,
                    reason="daily_quota",
                ),
                executor.submit(
                    gemini_rate_limit.penalize_gemini_key,
                    self.api_key,
                    seconds=10,
                    reason="rate_limit",
                ),
            ]
            [future.result() for future in futures]

        state = self._state()
        remaining = (state.blocked_until - datetime.datetime.utcnow()).total_seconds()
        self.assertEqual(state.blocked_reason, "daily_quota")
        self.assertEqual(state.consecutive_daily_failures, 1)
        self.assertGreater(remaining, 60 * 60 - 5)

    def test_concurrent_missing_daily_responses_escalate_once(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    gemini_rate_limit.penalize_gemini_key,
                    self.api_key,
                    reason="daily_quota",
                )
                for _index in range(2)
            ]
            [future.result() for future in futures]

        state = self._state()
        remaining = (state.blocked_until - datetime.datetime.utcnow()).total_seconds()
        self.assertEqual(state.consecutive_daily_failures, 1)
        self.assertGreater(remaining, 60 * 60 - 5)
        self.assertLessEqual(remaining, 60 * 60)


if __name__ == "__main__":
    unittest.main()
