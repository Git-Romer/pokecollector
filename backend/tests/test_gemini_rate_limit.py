import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import GeminiQuotaState
    from services import gemini_rate_limit

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class GeminiRateLimitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.session_patch = patch.object(gemini_rate_limit, "SessionLocal", self.Session)
        self.session_patch.start()

    def tearDown(self):
        self.session_patch.stop()
        self.engine.dispose()

    async def test_different_keys_get_independent_quota_state(self):
        with patch.object(gemini_rate_limit, "request_interval_seconds", return_value=60):
            await gemini_rate_limit.acquire_gemini_slot("key-a")
            await gemini_rate_limit.acquire_gemini_slot("key-b")

        db = self.Session()
        try:
            states = db.query(GeminiQuotaState).all()
            self.assertEqual(len(states), 2)
            self.assertTrue(all(state.next_request_at for state in states))
        finally:
            db.close()

    async def test_idle_key_preserves_small_interactive_burst(self):
        with patch.object(gemini_rate_limit, "burst_capacity", return_value=3):
            with patch.object(gemini_rate_limit.asyncio, "sleep") as sleep:
                await gemini_rate_limit.acquire_gemini_slot("interactive-key")
                await gemini_rate_limit.acquire_gemini_slot("interactive-key")
                await gemini_rate_limit.acquire_gemini_slot("interactive-key")

        sleep.assert_not_awaited()

    async def test_fingerprint_is_stable_and_does_not_store_the_api_key(self):
        first = gemini_rate_limit.key_fingerprint("very-secret-key")
        second = gemini_rate_limit.key_fingerprint("very-secret-key")
        self.assertEqual(first, second)
        self.assertNotIn("very-secret-key", first)

    async def test_upstream_penalty_is_shared_by_every_worker_for_that_key(self):
        gemini_rate_limit.penalize_gemini_key("shared-key", seconds=90)

        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("shared-key"),
            )
            self.assertIsNotNone(state)
            self.assertGreater(
                state.blocked_until,
                datetime.datetime.utcnow() + datetime.timedelta(seconds=80),
            )
        finally:
            db.close()

    async def test_priority_scope_is_context_local_and_restored(self):
        self.assertEqual(gemini_rate_limit.current_gemini_priority(), "interactive")
        with gemini_rate_limit.gemini_priority_scope("background"):
            self.assertEqual(gemini_rate_limit.current_gemini_priority(), "background")
        self.assertEqual(gemini_rate_limit.current_gemini_priority(), "interactive")

    async def test_inactive_key_fingerprints_expire_after_fourteen_days(self):
        now = datetime.datetime.utcnow()
        db = self.Session()
        try:
            db.add_all(
                [
                    GeminiQuotaState(
                        key_fingerprint="stale",
                        updated_at=now - datetime.timedelta(days=15),
                    ),
                    GeminiQuotaState(key_fingerprint="active", updated_at=now),
                ]
            )
            db.commit()
        finally:
            db.close()

        removed = gemini_rate_limit.purge_stale_quota_states(now=now)

        db = self.Session()
        try:
            self.assertEqual(removed, 1)
            self.assertIsNone(db.get(GeminiQuotaState, "stale"))
            self.assertIsNotNone(db.get(GeminiQuotaState, "active"))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
