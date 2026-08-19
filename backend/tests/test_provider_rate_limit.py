import asyncio
import datetime
import hashlib
import hmac
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from services import auth
    from services import provider_rate_limit
    from services.scan_providers import post_openai_chat
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
        with patch.object(auth, "SECRET_KEY", "resolved-private-runtime-secret"):
            first = provider_rate_limit.provider_scope_fingerprint(
                "openai", "https://example/v1", "company-secret"
            )
            second = provider_rate_limit.provider_scope_fingerprint(
                "openai", "https://example/v1", "different-secret"
            )
        self.assertNotEqual(first, second)
        self.assertNotIn("company-secret", first)
        self.assertNotIn("example", first)

        endpoint = "http://ollama-one:11434/v1"
        with patch.object(auth, "SECRET_KEY", "resolved-private-runtime-secret"):
            first_keyless = provider_rate_limit.provider_scope_fingerprint(
                "openai", endpoint, ""
            )
            second_keyless = provider_rate_limit.provider_scope_fingerprint(
                "openai", "http://ollama-two:11434/v1", ""
            )
        self.assertNotEqual(first_keyless, second_keyless)

        material = f"openai\0{endpoint}\0".encode()
        old_blank_digest = hmac.new(b"", material, hashlib.sha256).hexdigest()
        old_fallback_digest = hmac.new(
            b"pokecollector-scanner-provider-state", material, hashlib.sha256
        ).hexdigest()
        self.assertNotEqual(first_keyless, old_blank_digest)
        self.assertNotEqual(first_keyless, old_fallback_digest)

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

    def test_headerless_rate_limits_use_bounded_increasing_delays(self):
        scope = "fallback-scope"
        observed = []
        for expected in provider_rate_limit.FALLBACK_PENALTY_SECONDS:
            observed.append(
                provider_rate_limit.penalize_provider_scope(scope, "openai")
            )
            with self.sessions() as db:
                state = db.get(provider_rate_limit.ScannerProviderLimitState, scope)
                now = datetime.datetime.utcnow()
                state.updated_at = now - datetime.timedelta(seconds=expected + 1)
                state.blocked_until = now - datetime.timedelta(seconds=1)
                db.commit()
        self.assertEqual(observed, list(provider_rate_limit.FALLBACK_PENALTY_SECONDS))

    def test_success_resets_headerless_rate_limit_escalation(self):
        scope = "successful-scope"
        first = provider_rate_limit.penalize_provider_scope(scope, "openai")
        with self.sessions() as db:
            state = db.get(provider_rate_limit.ScannerProviderLimitState, scope)
            state.blocked_until = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
            db.commit()

        self.assertTrue(provider_rate_limit.record_provider_scope_success(scope))
        second = provider_rate_limit.penalize_provider_scope(scope, "openai")

        self.assertEqual(first, provider_rate_limit.FALLBACK_PENALTY_SECONDS[0])
        self.assertEqual(second, provider_rate_limit.FALLBACK_PENALTY_SECONDS[0])

    def test_older_success_does_not_clear_a_newer_rate_limit(self):
        scope = "racing-success-scope"
        request_started_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=2)
        provider_rate_limit.penalize_provider_scope(
            scope, "openai", seconds=600
        )

        self.assertFalse(
            provider_rate_limit.record_provider_scope_success(
                scope, request_started_at=request_started_at
            )
        )
        with self.assertRaises(provider_rate_limit.ProviderScopeBlockedError):
            provider_rate_limit.raise_if_provider_blocked(scope)

    def test_post_request_that_started_before_a_new_penalty_cannot_clear_it(self):
        url = "http://model-host:11434/v1/chat/completions"
        api_key = ""
        scope = provider_rate_limit.provider_scope_fingerprint("openai", url, api_key)

        class SuccessfulResponse:
            status_code = 200
            headers = {}
            is_error = False

        class RacingClient:
            async def post(self, *args, **kwargs):
                provider_rate_limit.penalize_provider_scope(
                    scope, "openai", seconds=600
                )
                return SuccessfulResponse()

        asyncio.run(
            post_openai_chat(
                RacingClient(), url, api_key, {"model": "vision"}, max_attempts=1
            )
        )
        with self.assertRaises(provider_rate_limit.ProviderScopeBlockedError):
            provider_rate_limit.raise_if_provider_blocked(scope)

    def test_successful_post_after_an_expired_penalty_resets_escalation(self):
        url = "http://model-host:11434/v1/chat/completions"
        api_key = ""
        scope = provider_rate_limit.provider_scope_fingerprint("openai", url, api_key)
        provider_rate_limit.penalize_provider_scope(scope, "openai")
        with self.sessions() as db:
            state = db.get(provider_rate_limit.ScannerProviderLimitState, scope)
            state.blocked_until = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
            state.updated_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=2)
            db.commit()

        class SuccessfulResponse:
            status_code = 200
            headers = {}
            is_error = False

        class SuccessfulClient:
            async def post(self, *args, **kwargs):
                return SuccessfulResponse()

        asyncio.run(
            post_openai_chat(
                SuccessfulClient(), url, api_key, {"model": "vision"}, max_attempts=1
            )
        )
        self.assertEqual(
            provider_rate_limit.penalize_provider_scope(scope, "openai"),
            provider_rate_limit.FALLBACK_PENALTY_SECONDS[0],
        )

    def test_stale_fingerprints_are_purged(self):
        scope = "old-scope"
        active_scope = "active-scope"
        provider_rate_limit.penalize_provider_scope(scope, "openai", seconds=30)
        provider_rate_limit.penalize_provider_scope(
            active_scope, "openai", seconds=120
        )
        with self.sessions() as db:
            state = db.get(provider_rate_limit.ScannerProviderLimitState, scope)
            state.updated_at = datetime.datetime.utcnow() - datetime.timedelta(days=15)
            db.commit()
        self.assertEqual(provider_rate_limit.purge_stale_provider_limit_states(), 1)
        with self.sessions() as db:
            self.assertIsNotNone(
                db.get(provider_rate_limit.ScannerProviderLimitState, active_scope)
            )
        with self.assertRaises(provider_rate_limit.ProviderScopeBlockedError):
            provider_rate_limit.raise_if_provider_blocked(active_scope)


if __name__ == "__main__":
    unittest.main()
