import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from services import provider_rate_limit
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy is not installed in this environment")
class ProviderRateLimitTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.sessions = sessionmaker(bind=engine)
        session_patch = patch.object(provider_rate_limit, "SessionLocal", self.sessions)
        session_patch.start()
        self.addCleanup(session_patch.stop)

    def test_scope_is_non_reversible_and_separates_credentials(self):
        first = provider_rate_limit.provider_scope_fingerprint(
            "openai", "https://example/v1", "company-secret"
        )
        second = provider_rate_limit.provider_scope_fingerprint(
            "openai", "https://example/v1", "different-secret"
        )
        self.assertNotEqual(first, second)
        self.assertNotIn("company-secret", first)
        self.assertNotIn("example", first)

    def test_penalty_is_visible_to_following_workers(self):
        scope = provider_rate_limit.provider_scope_fingerprint(
            "openai", "https://example/v1", "key"
        )
        delay = provider_rate_limit.penalize_provider_scope(
            scope, "openai", seconds=120, reason="rate_limit"
        )
        self.assertEqual(delay, 120)
        with self.assertRaises(provider_rate_limit.ProviderScopeBlockedError) as caught:
            provider_rate_limit.raise_if_provider_blocked(scope)
        self.assertGreater(caught.exception.retry_after_seconds, 119)
        self.assertEqual(caught.exception.reason, "rate_limit")

    def test_shorter_racing_penalty_does_not_shorten_existing_block(self):
        scope = "scope"
        provider_rate_limit.penalize_provider_scope(scope, "openai", seconds=600)
        remaining = provider_rate_limit.penalize_provider_scope(
            scope, "openai", seconds=30
        )
        self.assertGreater(remaining, 599)

    def test_stale_fingerprints_are_purged(self):
        scope = "old-scope"
        provider_rate_limit.penalize_provider_scope(scope, "openai", seconds=30)
        with self.sessions() as db:
            state = db.get(provider_rate_limit.ScannerProviderLimitState, scope)
            state.updated_at = datetime.datetime.utcnow() - datetime.timedelta(days=15)
            db.commit()
        self.assertEqual(provider_rate_limit.purge_stale_provider_limit_states(), 1)


if __name__ == "__main__":
    unittest.main()
