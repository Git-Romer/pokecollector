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
        with patch.dict(
            gemini_rate_limit.os.environ,
            {"JWT_SECRET_KEY": "existing-installation-secret"},
        ):
            first = gemini_rate_limit.key_fingerprint("very-secret-key")
            second = gemini_rate_limit.key_fingerprint("very-secret-key")
            self.assertEqual(first, second)
            self.assertNotIn("very-secret-key", first)

        with patch.dict(
            gemini_rate_limit.os.environ,
            {"JWT_SECRET_KEY": "a-different-installation-secret"},
        ):
            self.assertNotEqual(
                first,
                gemini_rate_limit.key_fingerprint("very-secret-key"),
            )

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

        with self.assertRaises(gemini_rate_limit.GeminiKeyBlockedError) as ctx:
            await gemini_rate_limit.acquire_gemini_slot("shared-key")
        self.assertGreater(ctx.exception.retry_after_seconds, 80)

    async def test_daily_quota_uses_one_hour_then_six_hour_fallback(self):
        first = gemini_rate_limit.penalize_gemini_key(
            "daily-key",
            reason="daily_quota",
        )
        self.assertEqual(first, 60 * 60)

        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("daily-key"),
            )
            state.blocked_until = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
            db.commit()
        finally:
            db.close()

        second = gemini_rate_limit.penalize_gemini_key(
            "daily-key",
            reason="daily_quota",
        )
        self.assertEqual(second, 6 * 60 * 60)

    async def test_daily_quota_prefers_provider_retry_info(self):
        delay = gemini_rate_limit.penalize_gemini_key(
            "provider-daily-key",
            seconds=21,
            reason="daily_quota",
        )
        self.assertEqual(delay, 21)

        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("provider-daily-key"),
            )
            self.assertEqual(state.blocked_reason, "daily_quota")
            self.assertEqual(state.consecutive_daily_failures, 0)
            remaining = (state.blocked_until - datetime.datetime.utcnow()).total_seconds()
            self.assertGreater(remaining, 19)
            self.assertLessEqual(remaining, 21)
        finally:
            db.close()

    async def test_provider_delay_replaces_active_daily_fallback(self):
        fallback = gemini_rate_limit.penalize_gemini_key(
            "fallback-then-provider",
            reason="daily_quota",
        )
        provider = gemini_rate_limit.penalize_gemini_key(
            "fallback-then-provider",
            seconds=41,
            reason="daily_quota",
        )
        self.assertEqual(fallback, 60 * 60)
        self.assertEqual(provider, 41)

    async def test_active_provider_delay_survives_missing_delay_race(self):
        provider = gemini_rate_limit.penalize_gemini_key(
            "provider-then-fallback",
            seconds=41,
            reason="daily_quota",
        )
        preserved = gemini_rate_limit.penalize_gemini_key(
            "provider-then-fallback",
            reason="daily_quota",
        )
        self.assertEqual(provider, 41)
        self.assertGreater(preserved, 39)
        self.assertLessEqual(preserved, 41)

    async def test_active_daily_block_survives_short_term_race(self):
        daily = gemini_rate_limit.penalize_gemini_key(
            "daily-then-short",
            reason="daily_quota",
        )
        preserved = gemini_rate_limit.penalize_gemini_key(
            "daily-then-short",
            seconds=10,
            reason="rate_limit",
        )
        self.assertEqual(daily, 60 * 60)
        self.assertGreater(preserved, 60 * 60 - 2)
        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("daily-then-short"),
            )
            self.assertEqual(state.blocked_reason, "daily_quota")
        finally:
            db.close()

    async def test_parallel_missing_daily_delays_escalate_only_once(self):
        first = gemini_rate_limit.penalize_gemini_key(
            "parallel-fallback",
            reason="daily_quota",
        )
        second = gemini_rate_limit.penalize_gemini_key(
            "parallel-fallback",
            reason="daily_quota",
        )
        self.assertEqual(first, 60 * 60)
        self.assertGreater(second, 60 * 60 - 2)
        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("parallel-fallback"),
            )
            self.assertEqual(state.consecutive_daily_failures, 1)
        finally:
            db.close()

    async def test_success_resets_daily_quota_escalation(self):
        gemini_rate_limit.penalize_gemini_key("daily-key", reason="daily_quota")
        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("daily-key"),
            )
            state.blocked_until = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
            db.commit()
        finally:
            db.close()

        gemini_rate_limit.record_gemini_success("daily-key")

        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("daily-key"),
            )
            self.assertEqual(state.consecutive_daily_failures, 0)
            self.assertIsNone(state.blocked_reason)
            self.assertIsNone(state.blocked_until)
        finally:
            db.close()

    async def test_in_flight_success_does_not_erase_newer_penalty(self):
        gemini_rate_limit.penalize_gemini_key("racing-key", seconds=90)
        gemini_rate_limit.record_gemini_success("racing-key")

        db = self.Session()
        try:
            state = db.get(
                GeminiQuotaState,
                gemini_rate_limit.key_fingerprint("racing-key"),
            )
            self.assertGreater(state.blocked_until, datetime.datetime.utcnow())
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
