"""Focused P3 tests for the Authlib-backed OIDC provider adapter.

A controlled synthetic provider is served through ``httpx2.MockTransport``; it
publishes discovery metadata and JWKS, authenticates the client with
``client_secret_basic`` and signs real RSA/EC ID tokens. Validation therefore
happens at Authlib's actual ``parse_id_token`` boundary, not through a mocked
verifier. No network provider, real credentials or database are used.
"""
import base64
import hashlib
import logging
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

try:
    # Third-party dependencies only; internal import errors below must fail loudly.
    import httpx2
    from authlib.integrations.base_client.async_openid import AsyncOpenIDMixin
    from authlib.oidc.core import CodeIDToken
    from joserfc import jwt as jose_jwt
    from joserfc.jwk import ECKey, RSAKey

    PROVIDER_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    PROVIDER_DEPS_AVAILABLE = False

if PROVIDER_DEPS_AVAILABLE:
    from services.auth_policy import OidcConfig
    from services.oidc_provider import (
        OidcConfigurationError,
        OidcDiscoveryError,
        OidcFreshAuthenticationError,
        OidcProvider,
        OidcTokenExchangeError,
        OidcTokenValidationError,
    )

ISSUER = "https://idp.example.test"
CLIENT_ID = "pokecollector"
CLIENT_SECRET = "synthetic-client-secret"
REDIRECT_URI = "https://app.example.test/api/auth/oidc/callback"
NONCE = "nonce-value"
CODE = "authorization-code-value"
VERIFIER = "pkce-code-verifier-value"
LOG_VERIFIER = "test-only-pkce-verifier-for-log-redaction"
AUTHLIB_SYNC_LOGGER = "authlib.integrations.base_client.sync_app"

if PROVIDER_DEPS_AVAILABLE:
    RSA_KEY = RSAKey.generate_key(2048, private=True, auto_kid=True)
    OTHER_RSA_KEY = RSAKey.generate_key(2048, private=True, auto_kid=True)
    ROTATED_RSA_KEY = RSAKey.generate_key(2048, private=True, auto_kid=True)
    EC_KEY = ECKey.generate_key("P-256", private=True, auto_kid=True)

_REMOVE = object()


class FakeClock:
    def __init__(self, now: float | None = None):
        self.now = time.time() if now is None else now

    def __call__(self) -> float:
        return self.now


class SyntheticProvider:
    """Controlled provider transport plus configurable token signing."""

    def __init__(self):
        self.clock = FakeClock()
        self.discovery_requests = 0
        self.jwks_requests = 0
        self.jwks_status = 200
        self.token_requests = 0
        self.last_token_body = ""
        self.metadata_issuer = ISSUER
        self.advertised_algs = ["RS256", "ES256"]
        self.token_auth_methods = ["client_secret_basic"]
        self.discovery_status = 200
        self.discovery_headers = {}
        self.metadata_overrides = {}
        self.jwks_keys = [RSA_KEY, EC_KEY]
        self.jwks_sequence = []
        self.id_token = None
        self.token_status = 200
        self.token_response_override = None
        self.transport = httpx2.MockTransport(self.handle)

    def metadata(self):
        metadata = {
            "issuer": self.metadata_issuer,
            "authorization_endpoint": ISSUER + "/authorize",
            "token_endpoint": ISSUER + "/token",
            "jwks_uri": ISSUER + "/jwks",
        }
        if self.advertised_algs is not None:
            metadata["id_token_signing_alg_values_supported"] = list(
                self.advertised_algs
            )
        if self.token_auth_methods is not None:
            metadata["token_endpoint_auth_methods_supported"] = list(
                self.token_auth_methods
            )
        metadata.update(self.metadata_overrides)
        return metadata

    def claims(self, **overrides):
        now = int(self.clock.now)
        claims = {
            "iss": ISSUER,
            "sub": "subject-1",
            "aud": CLIENT_ID,
            "exp": now + 300,
            "iat": now,
            "nonce": NONCE,
        }
        for key, value in overrides.items():
            if value is _REMOVE:
                claims.pop(key, None)
            else:
                claims[key] = value
        return claims

    def sign(self, claims, *, key=RSA_KEY, alg="RS256", kid=None):
        header = {"alg": alg, "kid": kid if kid is not None else key.kid}
        return jose_jwt.encode(header, claims, key)

    def handle(self, request):
        path = urlsplit(str(request.url)).path
        if path.endswith("/.well-known/openid-configuration"):
            self.discovery_requests += 1
            if self.discovery_status != 200:
                return httpx2.Response(
                    self.discovery_status, headers=self.discovery_headers
                )
            return httpx2.Response(200, json=self.metadata())

        if path.endswith("/jwks"):
            self.jwks_requests += 1
            if self.jwks_status != 200:
                return httpx2.Response(self.jwks_status)
            keys = (
                self.jwks_sequence.pop(0)
                if self.jwks_sequence
                else self.jwks_keys
            )
            return httpx2.Response(
                200, json={"keys": [key.as_dict(private=False) for key in keys]}
            )

        if path.endswith("/token"):
            self.token_requests += 1
            expected = "Basic " + base64.b64encode(
                f"{CLIENT_ID}:{CLIENT_SECRET}".encode()
            ).decode()
            if request.headers.get("authorization") != expected:
                return httpx2.Response(401, json={"error": "invalid_client"})
            self.last_token_body = request.content.decode()
            if self.token_response_override is not None:
                return httpx2.Response(
                    self.token_status, json=self.token_response_override
                )
            if self.id_token is None:
                self.id_token = self.sign(self.claims())
            return httpx2.Response(
                200,
                json={
                    "access_token": "synthetic-access-token",
                    "token_type": "Bearer",
                    "id_token": self.id_token,
                },
            )

        return httpx2.Response(404)


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class ProviderTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = SyntheticProvider()
        self.config = OidcConfig(
            issuer_url=ISSUER,
            client_id=CLIENT_ID,
            client_secret=CLIENT_SECRET,
            redirect_uri=REDIRECT_URI,
        )
        self.adapter = OidcProvider(
            self.config,
            transport=self.provider.transport,
            clock=self.provider.clock,
        )

    async def exchange(self, **kwargs):
        return await self.adapter.exchange_code_for_identity(
            code=CODE, code_verifier=VERIFIER, nonce=NONCE, **kwargs
        )


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class AuthorizationRequestTests(ProviderTestCase):
    async def test_builds_pkce_s256_request_with_expected_parameters(self):
        request = await self.adapter.build_authorization_url(
            state="state-value", nonce=NONCE, code_verifier=VERIFIER
        )

        self.assertEqual(request.state, "state-value")
        self.assertEqual(request.nonce, NONCE)
        self.assertEqual(request.code_verifier, VERIFIER)

        parts = urlsplit(request.url)
        params = parse_qs(parts.query)
        self.assertEqual(parts.scheme, "https")
        self.assertEqual(parts.netloc, "idp.example.test")
        self.assertEqual(params["response_type"], ["code"])
        self.assertEqual(params["client_id"], [CLIENT_ID])
        self.assertEqual(params["redirect_uri"], [REDIRECT_URI])
        self.assertEqual(params["scope"], ["openid profile"])
        self.assertEqual(params["state"], ["state-value"])
        self.assertEqual(params["nonce"], [NONCE])
        self.assertEqual(params["code_challenge_method"], ["S256"])
        expected_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(VERIFIER.encode()).digest()
        ).rstrip(b"=").decode()
        self.assertEqual(params["code_challenge"], [expected_challenge])

    async def test_link_request_forces_fresh_interaction(self):
        request = await self.adapter.build_authorization_url(
            state="state-value",
            nonce=NONCE,
            code_verifier=VERIFIER,
            prompt="login",
            max_age=0,
        )
        params = parse_qs(urlsplit(request.url).query)
        self.assertEqual(params["prompt"], ["login"])
        self.assertEqual(params["max_age"], ["0"])


class _RecordingLogHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class AuthlibLogRedactionTests(ProviderTestCase):
    async def test_pkce_verifier_is_redacted_from_authlib_debug_logs(self):
        logger = logging.getLogger(AUTHLIB_SYNC_LOGGER)
        handler = _RecordingLogHandler()
        original_level = logger.level
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            request = await self.adapter.build_authorization_url(
                state="state-value",
                nonce=NONCE,
                code_verifier=LOG_VERIFIER,
            )
            # A control record proves unrelated DEBUG logging still works.
            logger.debug("unrelated-control-log-line")
        finally:
            logger.removeHandler(handler)
            logger.setLevel(original_level)

        text = "\n".join(handler.messages)
        self.assertFalse(
            LOG_VERIFIER in text,
            "PKCE verifier leaked into Authlib DEBUG logs",
        )
        self.assertIn("[REDACTED]", text)
        self.assertIn("unrelated-control-log-line", text)
        self.assertTrue(
            request.code_verifier == LOG_VERIFIER,
            "authorization request lost the supplied PKCE verifier",
        )


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class SuccessfulValidationTests(ProviderTestCase):
    async def test_rs256_identity_returns_only_validated_claims(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(
                preferred_username="trainer-name",
                name="Synthetic Trainer",
                email="must-not-be-used@example.test",
            )
        )

        identity = await self.exchange()

        self.assertEqual(identity.issuer, ISSUER)
        self.assertEqual(identity.subject, "subject-1")
        self.assertEqual(identity.preferred_username, "trainer-name")
        self.assertEqual(identity.name, "Synthetic Trainer")
        self.assertFalse(hasattr(identity, "email"))

        # Code and verifier reached the token endpoint; client authentication
        # used client_secret_basic rather than a body credential.
        body = parse_qs(self.provider.last_token_body)
        self.assertEqual(body["code"], [CODE])
        self.assertEqual(body["code_verifier"], [VERIFIER])
        self.assertEqual(body["redirect_uri"], [REDIRECT_URI])
        self.assertNotIn("client_secret", body)

    async def test_es256_identity_is_accepted(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(), key=EC_KEY, alg="ES256"
        )
        identity = await self.exchange()
        self.assertEqual(identity.subject, "subject-1")

    async def test_metadata_algorithm_intersection_is_enforced(self):
        self.provider.advertised_algs = ["RS256", "HS256", "none", "ES256"]
        await self.adapter.build_authorization_url(
            state="state-value", nonce=NONCE, code_verifier=VERIFIER
        )
        self.assertEqual(
            self.adapter._app.server_metadata[
                "id_token_signing_alg_values_supported"
            ],
            ["RS256", "ES256"],
        )

    async def test_parse_id_token_receives_nonce_and_explicit_claim_options(self):
        original = AsyncOpenIDMixin.parse_id_token
        calls = []

        async def spy(self, token, nonce, claims_options=None, claims_cls=None, leeway=120):
            calls.append(
                {
                    "nonce": nonce,
                    "claims_options": claims_options,
                    "claims_cls": claims_cls,
                    "leeway": leeway,
                }
            )
            return await original(
                self,
                token,
                nonce=nonce,
                claims_options=claims_options,
                claims_cls=claims_cls,
                leeway=leeway,
            )

        with patch.object(AsyncOpenIDMixin, "parse_id_token", new=spy):
            identity = await self.exchange()

        self.assertEqual(identity.subject, "subject-1")
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(call["nonce"], NONCE)
        self.assertIs(call["claims_cls"], CodeIDToken)
        self.assertEqual(call["leeway"], 60)
        options = call["claims_options"]
        self.assertEqual(options["iss"], {"essential": True, "value": ISSUER})
        self.assertEqual(
            options["aud"], {"essential": True, "value": CLIENT_ID}
        )
        for name in ("exp", "iat", "sub", "nonce"):
            self.assertEqual(options[name], {"essential": True})


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class ClaimRejectionTests(ProviderTestCase):
    async def assert_rejected(self, claims, *, exc=OidcTokenValidationError, **kwargs):
        self.provider.id_token = self.provider.sign(claims, **kwargs)
        with self.assertRaises(exc):
            await self.exchange()

    async def test_wrong_issuer_is_rejected(self):
        await self.assert_rejected(self.provider.claims(iss="https://evil.example"))

    async def test_wrong_audience_is_rejected(self):
        await self.assert_rejected(self.provider.claims(aud="another-client"))

    async def test_multi_audience_requires_matching_azp(self):
        await self.assert_rejected(
            self.provider.claims(aud=[CLIENT_ID, "another-client"])
        )

    async def test_multi_audience_with_wrong_azp_is_rejected(self):
        await self.assert_rejected(
            self.provider.claims(
                aud=[CLIENT_ID, "another-client"], azp="another-client"
            )
        )

    async def test_multi_audience_with_matching_azp_is_accepted(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(aud=[CLIENT_ID, "another-client"], azp=CLIENT_ID)
        )
        identity = await self.exchange()
        self.assertEqual(identity.subject, "subject-1")

    async def test_azp_must_equal_client_when_present(self):
        await self.assert_rejected(self.provider.claims(azp="another-client"))

    async def test_matching_azp_is_accepted_for_single_audience(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(azp=CLIENT_ID)
        )
        identity = await self.exchange()
        self.assertEqual(identity.subject, "subject-1")

    async def test_empty_azp_is_rejected_even_for_single_audience(self):
        await self.assert_rejected(self.provider.claims(azp=""))

    async def test_null_azp_is_rejected(self):
        await self.assert_rejected(self.provider.claims(azp=None))

    async def test_boolean_azp_is_rejected(self):
        await self.assert_rejected(self.provider.claims(azp=False))

    async def test_non_string_azp_is_rejected(self):
        await self.assert_rejected(self.provider.claims(azp=123))

    async def test_nonce_mismatch_is_rejected(self):
        await self.assert_rejected(self.provider.claims(nonce="different-nonce"))

    async def test_missing_nonce_claim_is_rejected(self):
        await self.assert_rejected(self.provider.claims(nonce=_REMOVE))

    async def test_expired_token_is_rejected(self):
        now = int(self.provider.clock.now)
        await self.assert_rejected(self.provider.claims(exp=now - 3600))

    async def test_future_issued_at_is_rejected(self):
        now = int(self.provider.clock.now)
        await self.assert_rejected(self.provider.claims(iat=now + 120))

    async def test_missing_subject_is_rejected(self):
        await self.assert_rejected(self.provider.claims(sub=_REMOVE))

    async def test_non_string_subject_is_rejected(self):
        await self.assert_rejected(self.provider.claims(sub=123))

    async def test_bad_signature_is_rejected(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(), key=OTHER_RSA_KEY, kid=RSA_KEY.kid
        )
        with self.assertRaises(OidcTokenValidationError):
            await self.exchange()

    async def test_unadvertised_algorithm_is_rejected(self):
        self.provider.advertised_algs = ["RS256"]
        await self.assert_rejected(
            self.provider.claims(), key=EC_KEY, alg="ES256"
        )

    async def test_missing_signing_algorithm_metadata_is_rejected(self):
        self.provider.advertised_algs = None
        with self.assertRaises(OidcConfigurationError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )

    async def test_symmetric_only_provider_is_rejected(self):
        self.provider.advertised_algs = ["HS256"]
        with self.assertRaises(OidcConfigurationError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class ProviderFailureAndCacheTests(ProviderTestCase):
    async def test_code_exchange_failure_is_generic(self):
        self.provider.token_status = 400
        self.provider.token_response_override = {
            "error": "invalid_grant",
            "error_description": "provider-secret-description",
        }
        with self.assertRaises(OidcTokenExchangeError) as raised:
            await self.exchange()
        self.assertNotIn("provider-secret-description", str(raised.exception))
        self.assertEqual(self.provider.token_requests, 1)

    async def test_missing_id_token_is_rejected(self):
        self.provider.token_response_override = {
            "access_token": "only-an-access-token",
            "token_type": "Bearer",
        }
        with self.assertRaises(OidcTokenValidationError):
            await self.exchange()

    async def test_jwks_rotation_refetches_one_unknown_kid(self):
        self.provider.jwks_sequence = [[RSA_KEY], [RSA_KEY, ROTATED_RSA_KEY]]
        self.provider.id_token = self.provider.sign(
            self.provider.claims(), key=ROTATED_RSA_KEY
        )
        identity = await self.exchange()
        self.assertEqual(identity.subject, "subject-1")
        self.assertEqual(self.provider.jwks_requests, 2)

    async def test_metadata_and_jwks_cache_is_bounded_to_five_minutes(self):
        await self.exchange()
        await self.exchange()
        self.assertEqual(self.provider.discovery_requests, 1)
        self.assertEqual(self.provider.jwks_requests, 1)

        self.provider.clock.now += 301
        await self.exchange()
        self.assertEqual(self.provider.discovery_requests, 2)
        self.assertEqual(self.provider.jwks_requests, 2)

    async def test_discovery_issuer_must_match_exactly(self):
        self.provider.metadata_issuer = ISSUER + "/"
        with self.assertRaises(OidcConfigurationError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )

    async def test_discovery_endpoint_must_be_https_or_loopback(self):
        self.provider.metadata_overrides = {
            "authorization_endpoint": "http://evil.example/authorize"
        }
        with self.assertRaises(OidcConfigurationError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )

    async def test_loopback_http_development_endpoints_are_allowed(self):
        provider = SyntheticProvider()
        loopback = "http://127.0.0.1:9000"
        provider.metadata_overrides = {
            "issuer": loopback,
            "authorization_endpoint": loopback + "/authorize",
            "token_endpoint": loopback + "/token",
            "jwks_uri": loopback + "/jwks",
        }
        adapter = OidcProvider(
            OidcConfig(
                issuer_url=loopback,
                client_id=CLIENT_ID,
                client_secret=CLIENT_SECRET,
                redirect_uri="http://127.0.0.1:3000/api/auth/oidc/callback",
            ),
            transport=provider.transport,
            clock=provider.clock,
        )
        request = await adapter.build_authorization_url(
            state="state", nonce=NONCE, code_verifier=VERIFIER
        )
        self.assertTrue(request.url.startswith(loopback + "/authorize"))

    async def test_discovery_redirect_is_not_followed(self):
        self.provider.discovery_status = 302
        self.provider.discovery_headers = {
            "Location": "https://arbitrary.example/discovery"
        }
        with self.assertRaises(OidcDiscoveryError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )
        self.assertEqual(self.provider.discovery_requests, 1)

    async def test_discovery_server_error_is_not_retried(self):
        self.provider.discovery_status = 500
        with self.assertRaises(OidcDiscoveryError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )
        self.assertEqual(self.provider.discovery_requests, 1)

    async def test_unrelated_discovery_metadata_cannot_override_http_settings(self):
        self.provider.metadata_overrides = {
            "verify": False,
            "timeout": 0.001,
            "follow_redirects": True,
            "transport": "not-a-transport",
            "headers": {"X-Injected": "1"},
        }
        identity = await self.exchange()
        self.assertEqual(identity.subject, "subject-1")
        for key in ("verify", "timeout", "follow_redirects", "transport", "headers"):
            self.assertNotIn(key, self.adapter._app.server_metadata)

    async def test_jwks_http_error_is_mapped_to_validation_failure(self):
        self.provider.jwks_status = 500
        with self.assertRaises(OidcTokenValidationError) as raised:
            await self.exchange()
        self.assertNotIn("500", str(raised.exception))

    async def test_unsupported_client_secret_method_is_rejected(self):
        self.provider.token_auth_methods = ["client_secret_post"]
        with self.assertRaises(OidcConfigurationError):
            await self.adapter.build_authorization_url(
                state="state", nonce=NONCE, code_verifier=VERIFIER
            )

    async def test_http_timeouts_are_finite_and_capped(self):
        timeout = self.adapter._timeout
        self.assertEqual(timeout.connect, 5.0)
        self.assertEqual(timeout.read, 5.0)
        self.assertEqual(timeout.write, 5.0)
        self.assertEqual(timeout.pool, 5.0)

        OidcProvider(self.config, transport=self.provider.transport, timeout_seconds=10)
        for invalid in (0, -1, 10.01, float("inf")):
            with self.subTest(invalid=invalid):
                with self.assertRaises(OidcConfigurationError):
                    OidcProvider(
                        self.config,
                        transport=self.provider.transport,
                        timeout_seconds=invalid,
                    )


@unittest.skipUnless(PROVIDER_DEPS_AVAILABLE, "OIDC provider dependencies are not installed")
class FreshAuthenticationTests(ProviderTestCase):
    async def test_missing_auth_time_is_rejected_for_linking(self):
        with self.assertRaises(OidcFreshAuthenticationError):
            await self.exchange(require_fresh_auth=True)

    async def test_stale_auth_time_is_rejected_for_linking(self):
        now = int(self.provider.clock.now)
        self.provider.id_token = self.provider.sign(
            self.provider.claims(auth_time=now - 301)
        )
        with self.assertRaises(OidcFreshAuthenticationError):
            await self.exchange(require_fresh_auth=True)

    async def test_future_auth_time_is_rejected_for_linking(self):
        now = int(self.provider.clock.now)
        self.provider.id_token = self.provider.sign(
            self.provider.claims(auth_time=now + 61)
        )
        with self.assertRaises(OidcFreshAuthenticationError):
            await self.exchange(require_fresh_auth=True)

    async def test_fresh_numeric_auth_time_is_accepted_for_linking(self):
        now = int(self.provider.clock.now)
        self.provider.id_token = self.provider.sign(
            self.provider.claims(auth_time=now - 10)
        )
        identity = await self.exchange(require_fresh_auth=True)
        self.assertEqual(identity.auth_time, now - 10)

    async def test_non_numeric_auth_time_is_rejected(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(auth_time="not-a-number")
        )
        with self.assertRaises(OidcTokenValidationError):
            await self.exchange()

    async def test_negative_auth_time_is_rejected(self):
        for value in (-1, -1.5):
            with self.subTest(value=value):
                self.provider.id_token = self.provider.sign(
                    self.provider.claims(auth_time=value)
                )
                with self.assertRaises(OidcTokenValidationError):
                    await self.exchange()

    async def test_fractional_auth_time_is_rejected(self):
        now = int(self.provider.clock.now)
        self.provider.id_token = self.provider.sign(
            self.provider.claims(auth_time=now - 0.5)
        )
        with self.assertRaises(OidcTokenValidationError):
            await self.exchange()

    async def test_boolean_auth_time_is_rejected(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(auth_time=True)
        )
        with self.assertRaises(OidcTokenValidationError):
            await self.exchange()

    async def test_non_finite_auth_time_is_rejected(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                self.provider.id_token = self.provider.sign(
                    self.provider.claims(auth_time=value)
                )
                with self.assertRaises(OidcTokenValidationError):
                    await self.exchange()
