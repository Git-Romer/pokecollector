"""P7 independent adversarial coverage for the OIDC authentication surface.

These tests target hostile inputs and state transitions that the existing
``test_auth_oidc_*`` suites do not exercise. They deliberately drive the real
route handlers (through ``TestClient``) and the real Authlib provider boundary
(through ``httpx2.MockTransport``) with synthetic values only: no network
provider, no live instance, no real credentials and no database server.

Each security assertion is paired with a valid counterpart in the same test so
that a regression which rejects everything (or accepts everything) cannot pass.
Internal import errors fail collection loudly; only third-party dependency
absence is guarded, matching the existing OIDC suites.
"""
import json
import os
import secrets
import time
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

os.environ.setdefault("JWT_SECRET_KEY", "adversarial-oidc-test-secret")

try:
    # Third-party dependencies only; internal import errors below must fail.
    import httpx2
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from joserfc import jwt as jose_jwt
    from joserfc.jwk import RSAKey
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

if DEPS_AVAILABLE:
    import api.auth as auth_api
    from database import Base, get_db
    from models import OidcAuthTransaction, OidcIdentity as OidcIdentityRow, User
    from services.auth import create_access_token, decode_token, hash_password
    from services.auth_policy import OidcConfig
    from services.oidc_identity import find_identity
    from services.oidc_provider import (
        AuthorizationRequest,
        OidcConfigurationError,
        OidcDiscoveryError,
        OidcIdentity as ProviderIdentity,
        OidcProvider,
        OidcTokenValidationError,
    )

ISSUER = "https://idp.example.test"
OTHER_ISSUER = "https://other-idp.example.test"
CLIENT_ID = "pokecollector"
CLIENT_SECRET = "synthetic-client-secret"
APP_ORIGIN = "https://app.example.test"
REDIRECT_URI = APP_ORIGIN + "/api/auth/oidc/callback"
SUBJECT = "provider-subject-1"
PASSWORD = "local-password-value"
NONCE = "adversarial-nonce-value"
CODE = "authorization-code-value"
VERIFIER = "pkce-code-verifier-value"

VALID_OIDC = {
    "AUTH_MODE": "mixed",
    "USER_MODE": "",
    "OIDC_ISSUER_URL": ISSUER,
    "OIDC_CLIENT_ID": CLIENT_ID,
    "OIDC_CLIENT_SECRET": CLIENT_SECRET,
    "OIDC_REDIRECT_URI": REDIRECT_URI,
    "OIDC_DISPLAY_NAME": "Single sign-on",
}


def oidc_env(**overrides):
    from unittest.mock import patch

    values = dict(VALID_OIDC)
    values.update(overrides)
    return patch.dict(os.environ, values, clear=False)


def local_env():
    from unittest.mock import patch

    values = {key: "" for key in VALID_OIDC}
    values["AUTH_MODE"] = "local"
    return patch.dict(os.environ, values, clear=False)


def state_from(location: str) -> str:
    return parse_qs(urlsplit(location).query)["state"][0]


# ---------------------------------------------------------------------------
# HTTP route harness
# ---------------------------------------------------------------------------


class FakeProvider:
    """Provider boundary stub: no network, no token material."""

    def __init__(self):
        self.identity = ProviderIdentity(
            issuer=ISSUER, subject=SUBJECT, auth_time=None
        )
        self.state = None
        self.nonce = None
        self.build_calls = []
        self.build_error = None
        self.exchange_error = None
        self.exchange_calls = []
        self.authorization_url = None

    async def build_authorization_url(self, **kwargs):
        self.build_calls.append(dict(kwargs))
        if self.build_error is not None:
            raise self.build_error
        self.state = secrets.token_urlsafe(16)
        self.nonce = secrets.token_urlsafe(16)
        url = self.authorization_url
        if url is None:
            params = {"state": self.state, "nonce": self.nonce, **kwargs}
            url = f"{ISSUER}/authorize?{urlencode(params)}"
        return AuthorizationRequest(
            url=url,
            state=self.state,
            nonce=self.nonce,
            code_verifier="synthetic-code-verifier",
        )

    async def exchange_code_for_identity(
        self, *, code, code_verifier, nonce, require_fresh_auth=False
    ):
        self.exchange_calls.append(
            {
                "code": code,
                "code_verifier": code_verifier,
                "nonce": nonce,
                "require_fresh_auth": require_fresh_auth,
            }
        )
        if self.exchange_error is not None:
            raise self.exchange_error
        return self.identity


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class AdversarialRouteTestCase(unittest.TestCase):
    def setUp(self):
        self.env = oidc_env()
        self.env.start()
        self.addCleanup(self.env.stop)

        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

        self.provider = FakeProvider()
        from unittest.mock import patch

        self.provider_patch = patch.object(
            auth_api, "_build_oidc_provider", lambda config: self.provider
        )
        self.provider_patch.start()
        self.addCleanup(self.provider_patch.stop)

        auth_api._oidc_rate_state.clear()

        app = FastAPI()
        app.include_router(auth_api.router, prefix="/api/auth")

        def override_db():
            yield self.db

        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(
            app, base_url="https://testserver", follow_redirects=False
        )
        self.addCleanup(self.client.close)

    # -- helpers ---------------------------------------------------------
    def add_user(self, username, *, role="trainer", is_active=True, password=None):
        user = User(
            username=username,
            hashed_password=hash_password(password) if password else None,
            role=role,
            is_active=is_active,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def link(self, user, *, issuer=ISSUER, subject=SUBJECT):
        identity = OidcIdentityRow(
            issuer=issuer, subject=subject, user_id=user.id
        )
        self.db.add(identity)
        self.db.commit()
        return identity

    def bearer(self, user):
        return create_access_token({"sub": str(user.id), "role": user.role})

    def start(self):
        return self.client.get("/api/auth/oidc/start")

    def callback(self, state, code=CODE):
        return self.client.get(
            "/api/auth/oidc/callback",
            params={"state": state, "code": code},
        )

    def login_handoff(self, subject=SUBJECT, *, preferred_username=None, name=None):
        self.provider.identity = ProviderIdentity(
            issuer=ISSUER,
            subject=subject,
            auth_time=None,
            preferred_username=preferred_username,
            name=name,
        )
        start = self.start()
        self.assertEqual(start.status_code, 302)
        callback = self.callback(state_from(start.headers["location"]))
        self.assertEqual(callback.status_code, 302)
        self.assertEqual(callback.headers["location"], "/auth/oidc/complete")
        return callback

    def post_json(
        self,
        path,
        *,
        token=None,
        body=b"{}",
        origin=APP_ORIGIN,
        content_type="application/json",
    ):
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if content_type is not None:
            headers["Content-Type"] = content_type
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.post(path, content=body, headers=headers)

    def complete(self, *, origin=APP_ORIGIN, token=None):
        return self.post_json(
            "/api/auth/oidc/complete", origin=origin, token=token
        )

    def link_start(self, *, token, body):
        return self.post_json("/api/auth/oidc/link", token=token, body=body)

    def unlink(self, *, token, body):
        return self.post_json("/api/auth/oidc/unlink", token=token, body=body)

    def assert_security_headers(self, response):
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(response.headers.get("referrer-policy"), "no-referrer")

    def transactions(self):
        return self.db.query(OidcAuthTransaction).all()


class CrossIssuerLoginTests(AdversarialRouteTestCase):
    def test_same_subject_under_another_issuer_never_authenticates_that_account(self):
        """Identity is keyed by (issuer, subject); a foreign-issuer row differs.

        Existing suites prove status/link lookups are issuer-scoped and that a
        callback carrying a foreign issuer is rejected. They do not prove that a
        *login completion* for the configured issuer with a subject that exists
        only under a different issuer creates a distinct account instead of
        resolving (and authenticating) the foreign-issuer account.
        """
        foreign = self.add_user("foreign-issuer-account")
        self.link(foreign, issuer=OTHER_ISSUER, subject=SUBJECT)

        self.login_handoff(subject=SUBJECT)
        response = self.complete()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotEqual(body["user"]["id"], foreign.id)
        self.assertEqual(self.db.query(User).count(), 2)
        provisioned = self.db.query(User).filter(User.id == body["user"]["id"]).one()
        self.assertEqual(provisioned.role, "trainer")
        self.assertIsNone(provisioned.hashed_password)
        self.assertEqual(decode_token(body["access_token"])["sub"], str(provisioned.id))

        configured = find_identity(self.db, ISSUER, SUBJECT)
        foreign_row = find_identity(self.db, OTHER_ISSUER, SUBJECT)
        self.assertIsNotNone(configured)
        self.assertEqual(configured.user_id, provisioned.id)
        self.assertEqual(foreign_row.user_id, foreign.id)


class LoginBearerOperationTests(AdversarialRouteTestCase):
    def test_login_handoff_with_a_bearer_never_links_to_that_bearer_account(self):
        """A LOGIN handoff must not act like an implicit account link.

        The suite proves a LINK handoff cannot be redeemed as a login, but not
        the reverse confusion: presenting a valid bearer during a login handoff
        for an unlinked provider subject. The login branch must ignore the
        bearer as an account target and provision/resolve by identity only.
        """
        victim = self.add_user("victim-account", role="admin", password=PASSWORD)
        victim_token = self.bearer(victim)

        self.login_handoff(subject=SUBJECT)
        response = self.complete(token=victim_token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotEqual(body["user"]["id"], victim.id)
        self.assertEqual(decode_token(body["access_token"])["sub"], str(body["user"]["id"]))
        self.assertEqual(
            self.db.query(OidcIdentityRow)
            .filter(OidcIdentityRow.user_id == victim.id)
            .count(),
            0,
        )
        linked = find_identity(self.db, ISSUER, SUBJECT)
        self.assertIsNotNone(linked)
        self.assertNotEqual(linked.user_id, victim.id)
        self.db.refresh(victim)
        self.assertEqual(victim.role, "admin")
        self.assertEqual(self.db.query(User).count(), 2)


class AccountModeChangeTests(AdversarialRouteTestCase):
    def test_login_handoff_cannot_complete_after_switching_to_local(self):
        """Disabling OIDC must stop a still-live login handoff.

        Existing coverage switches modes only for a LINK handoff. A LOGIN
        handoff that survives a policy switch back to ``local`` would issue an
        application JWT from a disabled authentication method.
        """
        self.login_handoff()

        with local_env():
            blocked = self.complete()

        self.assertEqual(blocked.status_code, 404)
        self.assertEqual(blocked.json(), {"detail": "Not found"})
        self.assert_security_headers(blocked)
        self.assertNotIn("access_token", blocked.text)
        self.assertEqual(self.db.query(User).count(), 0)

        # Valid counterpart: restoring the OIDC policy leaves the one-use
        # handoff intact and usable; the disabled request must not consume it.
        allowed = self.complete()
        self.assertEqual(allowed.status_code, 200)
        self.assertIn("access_token", allowed.json())
        self.assertEqual(self.db.query(User).count(), 1)


class IssuerRotationTests(AdversarialRouteTestCase):
    def test_retired_issuer_handoff_cannot_authenticate_existing_user(self):
        existing = self.add_user(
            "retired-issuer-admin", role="admin", password=PASSWORD
        )
        identity = self.link(existing, issuer=ISSUER, subject=SUBJECT)
        self.login_handoff(subject=SUBJECT)

        with oidc_env(OIDC_ISSUER_URL=OTHER_ISSUER):
            response = self.complete()

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(), {"detail": "Sign-in could not be completed"}
        )
        self.assert_security_headers(response)
        self.assertNotIn("access_token", response.json())
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(find_identity(self.db, ISSUER, SUBJECT).id, identity.id)
        self.assertIsNone(find_identity(self.db, OTHER_ISSUER, SUBJECT))
        transactions = self.transactions()
        self.assertEqual(len(transactions), 1)
        self.assertIsNotNone(transactions[0].consumed_at)

        # Restoring the retired issuer cannot revive the consumed handoff.
        replay = self.complete()
        self.assertEqual(replay.status_code, 400)
        self.assertEqual(self.db.query(User).count(), 1)

    def test_retired_issuer_handoff_cannot_provision_new_user(self):
        self.login_handoff(subject="unprovisioned-retired-subject")

        with oidc_env(OIDC_ISSUER_URL=OTHER_ISSUER):
            response = self.complete()

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(), {"detail": "Sign-in could not be completed"}
        )
        self.assert_security_headers(response)
        self.assertNotIn("access_token", response.json())
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertIsNone(
            find_identity(self.db, ISSUER, "unprovisioned-retired-subject")
        )
        self.assertIsNone(
            find_identity(self.db, OTHER_ISSUER, "unprovisioned-retired-subject")
        )
        transactions = self.transactions()
        self.assertEqual(len(transactions), 1)
        self.assertIsNotNone(transactions[0].consumed_at)

        replay = self.complete()
        self.assertEqual(replay.status_code, 400)
        self.assertEqual(self.db.query(User).count(), 0)

    def test_same_issuer_handoff_still_completes(self):
        self.login_handoff(subject="current-issuer-subject")
        response = self.complete()

        self.assertEqual(response.status_code, 200)
        self.assert_security_headers(response)
        self.assertIn("access_token", response.json())
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertIsNotNone(
            find_identity(self.db, ISSUER, "current-issuer-subject")
        )


class AuthorizationUrlSafetyTests(AdversarialRouteTestCase):
    def test_start_rejects_unsafe_provider_authorization_urls(self):
        """Exercise every ``_is_safe_authorization_redirect`` rejection branch.

        Existing tests cover only ``javascript:`` on the link route. The start
        route's guards against credentials, fragments, non-loopback HTTP,
        missing schemes and missing hosts are otherwise untested.
        """
        unsafe = (
            "https://user:secret@idp.example.test/authorize",
            "https://idp.example.test/authorize#fragment",
            "http://idp.example.test/authorize",
            "//idp.example.test/authorize",
            "/authorize",
            "data:text/html,<script>alert(1)</script>",
            "https:///authorize",
        )
        for url in unsafe:
            with self.subTest(url=url):
                self.provider.authorization_url = url
                response = self.start()

                self.assertEqual(response.status_code, 302)
                self.assertEqual(
                    response.headers["location"],
                    "/login?oidc_error=provider_unavailable",
                )
                self.assertNotIn(
                    "pc_oidc_browser=", response.headers.get("set-cookie", "")
                )
                self.assert_security_headers(response)

        self.assertEqual(self.transactions(), [])

        # Valid counterpart: an ordinary HTTPS authorization URL still starts
        # one transaction and sets the browser binding cookie.
        self.provider.authorization_url = ISSUER + "/authorize?state=ok"
        valid = self.start()
        self.assertEqual(valid.status_code, 302)
        self.assertTrue(valid.headers["location"].startswith(ISSUER + "/authorize"))
        self.assertIn("pc_oidc_browser=", valid.headers["set-cookie"])
        self.assertEqual(len(self.transactions()), 1)


class MalformedBodyTests(AdversarialRouteTestCase):
    BAD_JSON_BODIES = (
        b"{",
        b"null",
        b"[]",
        b'"a-string"',
        b"\xff\xfe\x00",
        b'{"current_password": 123}',
        b'{"current_password": true}',
        b'{"current_password": ["nested"]}',
    )

    def test_link_rejects_malformed_or_non_object_json_without_side_effects(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)

        for body in self.BAD_JSON_BODIES:
            with self.subTest(body=body):
                response = self.link_start(token=token, body=body)
                self.assertEqual(response.status_code, 400)
                self.assert_security_headers(response)
                self.assertEqual(
                    response.json(), {"detail": "Current password is required"}
                )
                self.assertEqual(self.transactions(), [])

        # Valid counterpart: a real JSON object with the password creates one
        # transaction, so the failures above are not caused by blanket rejection.
        valid = self.link_start(
            token=token,
            body=json.dumps({"current_password": PASSWORD}).encode(),
        )
        self.assertEqual(valid.status_code, 200)
        self.assertEqual(len(self.transactions()), 1)

    def test_unlink_rejects_malformed_json_without_mutating_the_identity(self):
        user = self.add_user("admin", role="admin", password=PASSWORD)
        self.link(user)
        token = self.bearer(user)

        malformed_with_confirmation = (
            b"{",
            b"null",
            b"[]",
            b'"confirmation"',
            b'{"confirmation": true, "current_password": "' + PASSWORD.encode(),
        )
        for body in malformed_with_confirmation:
            with self.subTest(body=body):
                response = self.unlink(token=token, body=body)
                self.assertEqual(response.status_code, 400)
                self.assert_security_headers(response)
                self.assertNotIn("linked", response.text)
                self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

        # Valid counterpart: the same endpoint removes the identity once the
        # request is a real JSON object with the exact confirmation.
        valid = self.unlink(
            token=token,
            body=json.dumps(
                {"current_password": PASSWORD, "confirmation": True}
            ).encode(),
        )
        self.assertEqual(valid.status_code, 200)
        self.assertEqual(valid.json(), {"linked": False})
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))


class OriginAmbiguityTests(AdversarialRouteTestCase):
    def test_lookalike_origins_are_rejected_and_the_exact_origin_is_accepted(self):
        """Origin comparison must be exact, not prefix/userinfo/port tolerant.

        Existing tests use a plainly different origin. These parser-boundary
        values catch a future change to ``startswith`` or a naive URL compare.
        """
        self.login_handoff()

        lookalikes = (
            "https://app.example.test.evil.test",
            "https://app.example.test@evil.test",
            "https://app.example.test:443",
            "https://APP.EXAMPLE.TEST",
            "https://app.example.test/",
            "http://app.example.test",
            "https://app.example.test.evil.test/..",
        )
        for origin in lookalikes:
            with self.subTest(origin=origin):
                response = self.complete(origin=origin)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json(), {"detail": "Invalid request origin"})
                self.assert_security_headers(response)
                self.assertNotIn("access_token", response.text)

        # The rejected attempts must not consume the handoff.
        allowed = self.complete(origin=APP_ORIGIN)
        self.assertEqual(allowed.status_code, 200)
        self.assertIn("access_token", allowed.json())


# ---------------------------------------------------------------------------
# Provider boundary harness
# ---------------------------------------------------------------------------

_REMOVE = object()

if DEPS_AVAILABLE:
    RSA_KEY = RSAKey.generate_key(2048, private=True, auto_kid=True)


class SyntheticProvider:
    """Minimal controlled discovery/JWKS/token provider over MockTransport."""

    def __init__(self):
        self.discovery_requests = 0
        self.jwks_requests = 0
        self.token_requests = 0
        self.metadata_overrides = {}
        self.discovery_payload = None
        self.id_token = None
        self.transport = httpx2.MockTransport(self.handle)

    def metadata(self):
        metadata = {
            "issuer": ISSUER,
            "authorization_endpoint": ISSUER + "/authorize",
            "token_endpoint": ISSUER + "/token",
            "jwks_uri": ISSUER + "/jwks",
            "id_token_signing_alg_values_supported": ["RS256", "ES256"],
            "token_endpoint_auth_methods_supported": ["client_secret_basic"],
        }
        metadata.update(self.metadata_overrides)
        return metadata

    def claims(self, **overrides):
        now = int(time.time())
        claims = {
            "iss": ISSUER,
            "sub": SUBJECT,
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

    def sign(self, claims):
        return jose_jwt.encode(
            {"alg": "RS256", "kid": RSA_KEY.kid}, claims, RSA_KEY
        )

    def handle(self, request):
        path = urlsplit(str(request.url)).path
        if path.endswith("/.well-known/openid-configuration"):
            self.discovery_requests += 1
            if self.discovery_payload is not None:
                return httpx2.Response(
                    200,
                    content=self.discovery_payload,
                    headers={"content-type": "application/json"},
                )
            return httpx2.Response(200, json=self.metadata())

        if path.endswith("/jwks"):
            self.jwks_requests += 1
            return httpx2.Response(
                200, json={"keys": [RSA_KEY.as_dict(private=False)]}
            )

        if path.endswith("/token"):
            self.token_requests += 1
            token = self.id_token
            if token is None:
                token = self.sign(self.claims())
            return httpx2.Response(
                200,
                json={
                    "access_token": "synthetic-access-token",
                    "token_type": "Bearer",
                    "id_token": token,
                },
            )

        return httpx2.Response(404)


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class AdversarialProviderTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = SyntheticProvider()
        self.config = OidcConfig(
            issuer_url=ISSUER,
            client_id=CLIENT_ID,
            client_secret=CLIENT_SECRET,
            redirect_uri=REDIRECT_URI,
        )
        self.adapter = OidcProvider(self.config, transport=self.provider.transport)

    async def exchange(self):
        return await self.adapter.exchange_code_for_identity(
            code=CODE, code_verifier=VERIFIER, nonce=NONCE
        )

    async def authorize(self):
        return await self.adapter.build_authorization_url(
            state="state-value", nonce=NONCE, code_verifier=VERIFIER
        )


class MalformedDiscoveryTests(AdversarialProviderTestCase):
    async def test_malformed_discovery_payloads_fail_generically_without_cache_poisoning(self):
        cases = (
            ("non_json", {"discovery_payload": b"not-json"}, OidcDiscoveryError),
            ("json_array", {"discovery_payload": b"[]"}, OidcDiscoveryError),
            (
                "issuer_not_string",
                {"metadata_overrides": {"issuer": [ISSUER]}},
                OidcConfigurationError,
            ),
            (
                "endpoint_not_string",
                {
                    "metadata_overrides": {
                        "token_endpoint": [ISSUER + "/token"]
                    }
                },
                OidcConfigurationError,
            ),
            (
                "algorithm_list_with_non_string",
                {
                    "metadata_overrides": {
                        "id_token_signing_alg_values_supported": [
                            "RS256",
                            123,
                        ]
                    }
                },
                OidcConfigurationError,
            ),
            (
                "auth_methods_not_a_list",
                {
                    "metadata_overrides": {
                        "token_endpoint_auth_methods_supported": (
                            "client_secret_basic"
                        )
                    }
                },
                OidcConfigurationError,
            ),
        )
        for name, settings, expected in cases:
            with self.subTest(case=name):
                self.provider.discovery_payload = settings.get("discovery_payload")
                self.provider.metadata_overrides = settings.get(
                    "metadata_overrides", {}
                )
                with self.assertRaises(expected) as raised:
                    await self.authorize()
                self.assertNotIn(CLIENT_SECRET, str(raised.exception))
                self.assertNotIn("not-json", str(raised.exception))

        # Valid counterpart: failures must not be cached as a usable app.
        self.provider.discovery_payload = None
        self.provider.metadata_overrides = {}
        request = await self.authorize()
        self.assertTrue(request.url.startswith(ISSUER + "/authorize"))
        self.assertGreaterEqual(self.provider.discovery_requests, 2)


class MalformedIdTokenTests(AdversarialProviderTestCase):
    async def test_non_string_id_token_values_are_rejected_generically(self):
        # A provider that returns a non-string id_token must yield the generic
        # validation error, never an unmapped exception or reflected payload.
        for value in (123, ["header.payload.signature"], {"token": "value"}, True):
            with self.subTest(value=type(value).__name__):
                self.provider.id_token = value
                with self.assertRaises(OidcTokenValidationError) as raised:
                    await self.exchange()
                self.assertNotIn("header.payload", str(raised.exception))
                self.assertNotIn(CLIENT_SECRET, str(raised.exception))

        # Valid counterpart on the same adapter/provider.
        self.provider.id_token = self.provider.sign(self.provider.claims())
        identity = await self.exchange()
        self.assertEqual(identity.subject, SUBJECT)


class SubjectAndProfileBoundaryTests(AdversarialProviderTestCase):
    async def test_subject_length_matches_the_identity_column_boundary(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(sub="s" * 255)
        )
        identity = await self.exchange()
        self.assertEqual(len(identity.subject), 255)

        self.provider.id_token = self.provider.sign(
            self.provider.claims(sub="s" * 256)
        )
        with self.assertRaises(OidcTokenValidationError):
            await self.exchange()

    async def test_overlong_profile_claims_are_dropped_without_dropping_valid_ones(self):
        self.provider.id_token = self.provider.sign(
            self.provider.claims(
                preferred_username="p" * 257,
                name="Valid Name",
            )
        )
        identity = await self.exchange()
        self.assertIsNone(identity.preferred_username)
        self.assertEqual(identity.name, "Valid Name")

        # 256 is the inclusive upper bound; 257 is dropped above.
        self.provider.id_token = self.provider.sign(
            self.provider.claims(preferred_username="p" * 256)
        )
        identity = await self.exchange()
        self.assertEqual(len(identity.preferred_username), 256)


if __name__ == "__main__":
    unittest.main()
