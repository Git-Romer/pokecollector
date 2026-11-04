"""Focused P5 tests: identity status, explicit linking and unlink safeguards.

These drive the real ASGI routes through ``TestClient`` against synthetic SQLite
with ``PRAGMA foreign_keys=ON``. The provider boundary is a stub here; the real
signed-token boundary is covered by the P3 provider suite. No Dev/Prod instance,
network provider or real credentials are used.
"""
import asyncio
import json
import os
import secrets
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-identity-test-secret")

try:
    # Third-party dependencies only; internal import errors below must fail.
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

if DEPS_AVAILABLE:
    import api.auth as auth_api
    from database import Base, get_db
    from models import CollectionItem, OidcAuthTransaction, OidcIdentity, User
    from services.auth import (
        create_access_token,
        hash_password,
        has_valid_password_hash,
    )
    from services.auth_admin import count_usable_admins, is_usable_admin
    from services.auth_policy import load_auth_policy
    from services.oidc_identity import find_identity, find_user_identity
    from services.oidc_provider import (
        AuthorizationRequest,
        OidcDiscoveryError,
        OidcFreshAuthenticationError,
        OidcIdentity as ProviderIdentity,
    )
    from services.oidc_transactions import (
        OPERATION_LINK,
        OPERATION_LOGIN,
        PHASE_HANDOFF,
        bearer_token_fingerprint,
        start_transaction,
    )

ISSUER = "https://idp.example.test"
OTHER_ISSUER = "https://other-idp.example.test"
CLIENT_SECRET = "synthetic-client-secret-do-not-print"
APP_ORIGIN = "https://app.example.test"
REDIRECT_URI = APP_ORIGIN + "/api/auth/oidc/callback"
SUBJECT = "provider-subject-1"
OTHER_SUBJECT = "provider-subject-2"
PASSWORD = "local-password"

VALID_OIDC = {
    "AUTH_MODE": "mixed",
    "USER_MODE": "",
    "OIDC_ISSUER_URL": ISSUER,
    "OIDC_CLIENT_ID": "pokecollector",
    "OIDC_CLIENT_SECRET": CLIENT_SECRET,
    "OIDC_REDIRECT_URI": REDIRECT_URI,
    "OIDC_DISPLAY_NAME": "Single sign-on",
}


def oidc_env(**overrides):
    values = dict(VALID_OIDC)
    values.update(overrides)
    return patch.dict(os.environ, values, clear=False)


def local_env():
    values = {key: "" for key in VALID_OIDC}
    values["AUTH_MODE"] = "local"
    return patch.dict(os.environ, values, clear=False)


def state_from(location: str) -> str:
    return parse_qs(urlsplit(location).query)["state"][0]


def json_body_of_exact_size(base: dict, size: int) -> bytes:
    """Build a valid JSON object whose UTF-8 encoding is exactly ``size`` bytes."""
    prefix = json.dumps(base, separators=(",", ":"))[:-1]
    empty_padding_suffix = ',"padding":""}'
    padding_length = size - len(prefix) - len(empty_padding_suffix)
    if padding_length < 0:
        raise ValueError("size is too small for the required JSON fields")
    body = prefix + ',"padding":"' + ("x" * padding_length) + '"}'
    assert len(body.encode("utf-8")) == size
    return body.encode("utf-8")


class FakeProvider:
    """Provider boundary stub: no network, no token material."""

    def __init__(self):
        self.identity = ProviderIdentity(
            issuer=ISSUER, subject=SUBJECT, auth_time=1_800_000_000
        )
        self.build_kwargs = []
        self.authorization_url = None
        self.build_error = None
        self.exchange_error = None
        self.exchange_calls = []

    async def build_authorization_url(self, **kwargs):
        self.build_kwargs.append(dict(kwargs))
        if self.build_error is not None:
            raise self.build_error
        state = secrets.token_urlsafe(16)
        return AuthorizationRequest(
            url=self.authorization_url or f"{ISSUER}/authorize?state={state}",
            state=state,
            nonce=secrets.token_urlsafe(16),
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
class IdentityRouteTestCase(unittest.TestCase):
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
    def add_user(
        self,
        username,
        *,
        role="trainer",
        is_active=True,
        password=None,
        hashed_password=None,
    ):
        if hashed_password is not None:
            stored = hashed_password
        elif password:
            stored = hash_password(password)
        else:
            stored = None
        user = User(
            username=username,
            hashed_password=stored,
            role=role,
            is_active=is_active,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def link(self, user, *, issuer=ISSUER, subject=SUBJECT):
        identity = OidcIdentity(issuer=issuer, subject=subject, user_id=user.id)
        self.db.add(identity)
        self.db.commit()
        return identity

    def add_collection(self, user):
        item = CollectionItem(user_id=user.id, quantity=1, variant="Normal")
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        return item

    def bearer(self, user):
        return create_access_token({"sub": str(user.id), "role": user.role})

    def headers(self, *, token=None, origin=APP_ORIGIN, content_type="application/json"):
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if content_type is not None:
            headers["Content-Type"] = content_type
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def identity_info(self, *, token=None):
        return self.client.get(
            "/api/auth/oidc/identity",
            headers=self.headers(token=token),
        )

    def link_start(
        self,
        user,
        *,
        token=None,
        password=PASSWORD,
        origin=APP_ORIGIN,
        content_type="application/json",
        body=None,
    ):
        token = self.bearer(user) if token is None else token
        payload = {"current_password": password}
        if body is not None:
            payload = body
        import json

        return self.client.post(
            "/api/auth/oidc/link",
            content=json.dumps(payload).encode(),
            headers=self.headers(
                token=token, origin=origin, content_type=content_type
            ),
        )

    def unlink(
        self,
        user,
        *,
        token=None,
        password=PASSWORD,
        confirmation=True,
        origin=APP_ORIGIN,
        content_type="application/json",
        omit_confirmation=False,
    ):
        token = self.bearer(user) if token is None else token
        payload = {"current_password": password}
        if not omit_confirmation:
            payload["confirmation"] = confirmation
        import json

        return self.client.post(
            "/api/auth/oidc/unlink",
            content=json.dumps(payload).encode(),
            headers=self.headers(
                token=token, origin=origin, content_type=content_type
            ),
        )

    def callback(self, state):
        return self.client.get(
            "/api/auth/oidc/callback",
            params={"state": state, "code": "synthetic-code"},
        )

    def complete(self, *, token=None, origin=APP_ORIGIN, content_type="application/json"):
        return self.client.post(
            "/api/auth/oidc/complete",
            content=b"{}",
            headers=self.headers(
                token=token, origin=origin, content_type=content_type
            ),
        )

    def replace_browser_cookie(self, value):
        for cookie in self.client.cookies.jar:
            if cookie.name == auth_api.OIDC_BROWSER_COOKIE:
                cookie.value = value
                return
        self.client.cookies.set(
            auth_api.OIDC_BROWSER_COOKIE, value, path="/api/auth/oidc"
        )

    def assert_security_headers(self, response):
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(response.headers.get("referrer-policy"), "no-referrer")


class IdentityStatusTests(IdentityRouteTestCase):
    def test_requires_authentication(self):
        response = self.identity_info()

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": "Not authenticated"})
        self.assert_security_headers(response)

    def test_local_mode_returns_generic_404_even_unauthenticated(self):
        with local_env():
            response = self.identity_info()

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"detail": "Not found"})
        self.assert_security_headers(response)

    def test_exact_safe_shape_true_and_false(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)

        unlinked = self.identity_info(token=token)
        self.assertEqual(unlinked.status_code, 200)
        self.assertEqual(
            set(unlinked.json().keys()),
            {"linked", "display_name", "unlink_permitted"},
        )
        self.assertEqual(unlinked.json()["linked"], False)
        self.assertEqual(unlinked.json()["display_name"], "Single sign-on")
        self.assertEqual(unlinked.json()["unlink_permitted"], False)
        self.assertNotIn(ISSUER, unlinked.text)
        self.assertNotIn(SUBJECT, unlinked.text)
        self.assert_security_headers(unlinked)

        self.link(user)
        linked = self.identity_info(token=token)
        self.assertEqual(linked.status_code, 200)
        self.assertEqual(linked.json()["linked"], True)
        self.assertEqual(linked.json()["unlink_permitted"], True)
        self.assertNotIn(SUBJECT, linked.text)
        self.assertNotIn(CLIENT_SECRET, linked.text)

    def test_configured_display_name_is_returned(self):
        user = self.add_user("trainer", password=PASSWORD)
        with oidc_env(OIDC_DISPLAY_NAME="Test SSO"):
            response = self.identity_info(token=self.bearer(user))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["display_name"], "Test SSO")

    def test_passwordless_linked_user_cannot_unlink(self):
        user = self.add_user("sso-only")
        self.link(user)

        response = self.identity_info(token=self.bearer(user))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["linked"], True)
        self.assertEqual(response.json()["unlink_permitted"], False)

    def test_oidc_only_never_permits_unlink(self):
        user = self.add_user("sso-only", password=PASSWORD)
        self.link(user)

        with oidc_env(AUTH_MODE="oidc-only"):
            response = self.identity_info(token=self.bearer(user))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["linked"], True)
        self.assertEqual(response.json()["unlink_permitted"], False)

    def test_identity_for_another_issuer_is_not_counted(self):
        user = self.add_user("trainer", password=PASSWORD)
        self.link(user, issuer=OTHER_ISSUER, subject=OTHER_SUBJECT)

        response = self.identity_info(token=self.bearer(user))

        self.assertEqual(response.json()["linked"], False)
        self.assertEqual(response.json()["unlink_permitted"], False)


class LinkStartTests(IdentityRouteTestCase):
    def _transactions(self):
        return self.db.query(OidcAuthTransaction).all()

    def test_start_creates_operation_bound_transaction_and_cookie(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)

        response = self.link_start(user, token=token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json().keys()), {"authorization_url"})
        self.assertTrue(response.json()["authorization_url"].startswith(ISSUER))
        self.assertEqual(self.provider.build_kwargs, [{"prompt": "login", "max_age": 0}])
        self.assert_security_headers(response)

        set_cookie = response.headers["set-cookie"]
        self.assertIn("pc_oidc_browser=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=lax", set_cookie)
        self.assertIn("Path=/api/auth/oidc", set_cookie)
        self.assertIn("Secure", set_cookie)

        row = self.db.query(OidcAuthTransaction).one()
        self.assertEqual(row.operation, OPERATION_LINK)
        self.assertEqual(row.phase, "authorization")
        self.assertEqual(row.issuer, ISSUER)
        self.assertEqual(row.user_id, user.id)
        self.assertEqual(row.bearer_fingerprint, bearer_token_fingerprint(token))
        self.assertIsNotNone(row.state_digest)
        self.assertIsNotNone(row.nonce_ciphertext)
        self.assertIsNotNone(row.verifier_ciphertext)
        self.assertIsNone(row.consumed_at)

    def test_origin_failures_have_no_side_effects(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)

        for origin in (None, "null", "https://evil.example.test"):
            response = self.link_start(user, token=token, origin=origin)
            self.assertEqual(response.status_code, 403, origin)
            self.assertEqual(response.json(), {"detail": "Invalid request origin"})
            self.assertNotIn("set-cookie", response.headers)
            self.assert_security_headers(response)

        self.assertEqual(self._transactions(), [])

    def test_requires_json_content_type(self):
        user = self.add_user("trainer", password=PASSWORD)

        response = self.link_start(user, content_type="text/plain")

        self.assertEqual(response.status_code, 415)
        self.assertEqual(self._transactions(), [])

    def test_json_body_at_exact_limit_is_accepted(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)
        body = json_body_of_exact_size(
            {"current_password": PASSWORD},
            auth_api._OIDC_MAX_JSON_BODY_BYTES,
        )

        response = self.client.post(
            "/api/auth/oidc/link",
            content=body,
            headers=self.headers(token=token),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self._transactions()), 1)

    def test_oversize_json_body_is_rejected_without_side_effects(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)
        body = json_body_of_exact_size(
            {"current_password": PASSWORD},
            auth_api._OIDC_MAX_JSON_BODY_BYTES + 1,
        )

        response = self.client.post(
            "/api/auth/oidc/link",
            content=body,
            headers=self.headers(token=token),
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json(), {"detail": "Request body too large"})
        self.assert_security_headers(response)
        self.assertEqual(self._transactions(), [])

    def test_streaming_limit_ignores_a_misleading_content_length(self):
        class LyingRequest:
            headers = {"content-length": "1"}

            async def stream(self):
                yield b"{" + (b"x" * 4096)
                yield b"y" * 4097

        with self.assertRaises(auth_api.OidcRequestBodyTooLarge):
            asyncio.run(auth_api._read_oidc_json_object(LyingRequest()))

    def test_wrong_or_missing_password_creates_no_transaction(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self.bearer(user)

        wrong = self.link_start(user, token=token, password="wrong-password")
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(self._transactions(), [])

        missing = self.link_start(user, token=token, body={})
        self.assertIn(missing.status_code, (400, 422))
        self.assertEqual(self._transactions(), [])

    def test_missing_or_malformed_password_hash_is_rejected(self):
        no_hash = self.add_user("no-hash")
        malformed = self.add_user("malformed", hashed_password="not-a-bcrypt-hash")

        for user in (no_hash, malformed):
            response = self.link_start(user)
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json(), {"detail": "Account linking is not available"})

        self.assertEqual(self._transactions(), [])

    def test_inactive_user_is_rejected(self):
        user = self.add_user("inactive", password=PASSWORD, is_active=False)

        response = self.link_start(user)

        self.assertEqual(response.status_code, 401)
        self.assertEqual(self._transactions(), [])

    def test_local_and_oidc_only_policies_are_rejected(self):
        user = self.add_user("trainer", password=PASSWORD)

        with local_env():
            local = self.link_start(user)
        self.assertEqual(local.status_code, 404)
        self.assertEqual(local.json(), {"detail": "Not found"})

        with oidc_env(AUTH_MODE="oidc-only"):
            oidc_only = self.link_start(user)
        self.assertEqual(oidc_only.status_code, 403)
        self.assertEqual(
            oidc_only.json(), {"detail": "Account linking is not available"}
        )

        self.assertEqual(self._transactions(), [])

    def test_existing_identity_for_issuer_is_rejected(self):
        user = self.add_user("trainer", password=PASSWORD)
        self.link(user)

        response = self.link_start(user)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "Account could not be linked"})
        self.assertEqual(self._transactions(), [])

    def test_identity_for_another_issuer_does_not_block_linking(self):
        user = self.add_user("trainer", password=PASSWORD)
        self.link(user, issuer=OTHER_ISSUER, subject=OTHER_SUBJECT)

        response = self.link_start(user)

        self.assertEqual(response.status_code, 200)

    def test_provider_failure_is_generic_and_creates_no_transaction(self):
        user = self.add_user("trainer", password=PASSWORD)
        self.provider.build_error = OidcDiscoveryError("upstream internal detail")

        response = self.link_start(user)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(), {"detail": "Sign-in provider is unavailable"}
        )
        self.assertNotIn("internal detail", response.text)
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self._transactions(), [])

    def test_unsafe_authorization_url_is_rejected(self):
        user = self.add_user("trainer", password=PASSWORD)
        self.provider.authorization_url = "javascript:alert(1)"

        response = self.link_start(user)

        self.assertEqual(response.status_code, 503)
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self._transactions(), [])

    def test_target_fields_in_body_are_ignored(self):
        user = self.add_user("trainer", password=PASSWORD)
        other = self.add_user("other", password=PASSWORD)

        response = self.link_start(
            user,
            body={
                "current_password": PASSWORD,
                "user_id": other.id,
                "subject": "attacker-chosen-subject",
                "email": "attacker@example.test",
            },
        )

        self.assertEqual(response.status_code, 200)
        row = self.db.query(OidcAuthTransaction).one()
        self.assertEqual(row.user_id, user.id)
        self.assertNotEqual(row.user_id, other.id)

    def test_rate_limited_response_is_generic(self):
        user = self.add_user("trainer", password=PASSWORD)
        with patch.object(auth_api, "_consume_oidc_rate_limit", return_value=False):
            response = self.link_start(user)

        self.assertEqual(response.status_code, 429)
        self.assert_security_headers(response)
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self._transactions(), [])


class LinkCompletionTests(IdentityRouteTestCase):
    def _begin(self, user):
        token = self.bearer(user)
        started = self.link_start(user, token=token)
        self.assertEqual(started.status_code, 200)
        state = state_from(started.json()["authorization_url"])
        callback = self.callback(state)
        self.assertEqual(callback.status_code, 302)
        self.assertEqual(callback.headers["location"], "/auth/oidc/complete")
        return token

    def test_link_completes_without_replacing_session_or_data(self):
        admin = self.add_user("admin", role="admin", password=PASSWORD)
        collection = self.add_collection(admin)
        token = self._begin(admin)

        response = self.complete(token=token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"linked": True})
        self.assertNotIn("access_token", response.json())
        self.assert_security_headers(response)
        self.db.refresh(admin)
        self.assertEqual(admin.role, "admin")
        self.assertEqual(
            find_identity(self.db, ISSUER, SUBJECT).user_id, admin.id
        )
        self.assertIsNotNone(
            self.db.query(CollectionItem).filter(CollectionItem.id == collection.id).first()
        )

    def test_completion_requires_same_bearer_and_user(self):
        user = self.add_user("trainer", password=PASSWORD)
        other = self.add_user("other", password=PASSWORD)
        token = self._begin(user)

        self.assertEqual(self.complete().status_code, 400)
        self.assertEqual(self.complete(token=self.bearer(other)).status_code, 400)
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))

        success = self.complete(token=token)
        self.assertEqual(success.status_code, 200)
        self.assertEqual(success.json(), {"linked": True})

    def test_replay_is_rejected(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self._begin(user)

        self.assertEqual(self.complete(token=token).status_code, 200)
        replay = self.complete(token=token)
        self.assertEqual(replay.status_code, 400)
        self.assertNotIn("access_token", replay.json())

    def test_wrong_browser_cannot_complete(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self._begin(user)
        self.replace_browser_cookie("different-browser")

        response = self.complete(token=token)

        self.assertEqual(response.status_code, 400)
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_provider_freshness_failure_is_rejected(self):
        user = self.add_user("trainer", password=PASSWORD)
        self.provider.exchange_error = OidcFreshAuthenticationError("stale")

        token = self.bearer(user)
        started = self.link_start(user, token=token)
        state = state_from(started.json()["authorization_url"])
        callback = self.callback(state)

        self.assertEqual(callback.status_code, 302)
        self.assertEqual(
            callback.headers["location"], "/login?oidc_error=reauth_required"
        )
        self.assertEqual(self.complete(token=token).status_code, 400)
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_stale_local_reauth_is_rejected(self):
        user = self.add_user("trainer", password=PASSWORD)
        token = self._begin(user)
        row = self.db.query(OidcAuthTransaction).one()
        row.created_at = datetime.utcnow() - timedelta(minutes=6)
        row.expires_at = datetime.utcnow() + timedelta(seconds=30)
        self.db.commit()

        response = self.complete(token=token)

        self.assertEqual(response.status_code, 400)
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))


class UnlinkTests(IdentityRouteTestCase):
    def _seed(self, *, role="admin", password=PASSWORD):
        user = self.add_user("admin", role=role, password=password)
        token = self.bearer(user)
        identity = self.link(user)
        other_identity = self.link(
            user, issuer=OTHER_ISSUER, subject=OTHER_SUBJECT
        )
        collection = self.add_collection(user)

        link_tx = start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LINK,
            state="unlink-link-state",
            browser_secret="unlink-browser",
            nonce="unlink-nonce",
            code_verifier="unlink-verifier",
            user_id=user.id,
            bearer_token=token,
        )
        now = datetime.utcnow()
        handoff = OidcAuthTransaction(
            operation=OPERATION_LOGIN,
            phase=PHASE_HANDOFF,
            issuer=ISSUER,
            browser_digest="b" * 64,
            subject=SUBJECT,
            handoff_digest="h" * 64,
            expires_at=now + timedelta(minutes=5),
            created_at=now,
        )
        other_issuer = OidcAuthTransaction(
            operation=OPERATION_LOGIN,
            phase=PHASE_HANDOFF,
            issuer=OTHER_ISSUER,
            browser_digest="c" * 64,
            subject=SUBJECT,
            handoff_digest="i" * 64,
            expires_at=now + timedelta(minutes=5),
            created_at=now,
        )
        unrelated = OidcAuthTransaction(
            operation=OPERATION_LOGIN,
            phase=PHASE_HANDOFF,
            issuer=ISSUER,
            browser_digest="d" * 64,
            subject="unrelated-subject",
            handoff_digest="u" * 64,
            expires_at=now + timedelta(minutes=5),
            created_at=now,
        )
        self.db.add_all([handoff, other_issuer, unrelated])
        self.db.commit()
        return {
            "user": user,
            "token": token,
            "identity": identity,
            "other_identity": other_identity,
            "collection": collection,
            "link_tx_id": link_tx.id,
            "handoff_id": handoff.id,
            "other_issuer_id": other_issuer.id,
            "unrelated_id": unrelated.id,
        }

    def test_unlink_removes_only_configured_issuer_and_invalidates_state(self):
        seeded = self._seed()

        response = self.unlink(seeded["user"], token=seeded["token"])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"linked": False})
        self.assert_security_headers(response)

        user = seeded["user"]
        self.db.refresh(user)
        self.assertEqual(user.role, "admin")
        self.assertIsNotNone(
            self.db.query(User).filter(User.id == user.id).first()
        )
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))
        self.assertIsNotNone(
            find_identity(self.db, OTHER_ISSUER, OTHER_SUBJECT)
        )
        self.assertIsNotNone(
            self.db.query(CollectionItem)
            .filter(CollectionItem.id == seeded["collection"].id)
            .first()
        )

        remaining = {
            row.id for row in self.db.query(OidcAuthTransaction).all()
        }
        self.assertNotIn(seeded["link_tx_id"], remaining)
        self.assertNotIn(seeded["handoff_id"], remaining)
        self.assertIn(seeded["other_issuer_id"], remaining)
        self.assertIn(seeded["unrelated_id"], remaining)

    def test_unlink_accepts_json_body_at_exact_limit(self):
        seeded = self._seed()
        body = json_body_of_exact_size(
            {"current_password": PASSWORD, "confirmation": True},
            auth_api._OIDC_MAX_JSON_BODY_BYTES,
        )

        response = self.client.post(
            "/api/auth/oidc/unlink",
            content=body,
            headers=self.headers(token=seeded["token"]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"linked": False})
        self.assertIsNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_unlink_oversize_json_body_is_rejected_without_mutation(self):
        seeded = self._seed()
        body = json_body_of_exact_size(
            {"current_password": PASSWORD, "confirmation": True},
            auth_api._OIDC_MAX_JSON_BODY_BYTES + 1,
        )

        response = self.client.post(
            "/api/auth/oidc/unlink",
            content=body,
            headers=self.headers(token=seeded["token"]),
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json(), {"detail": "Request body too large"})
        self.assert_security_headers(response)
        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))
        remaining = {row.id for row in self.db.query(OidcAuthTransaction).all()}
        self.assertIn(seeded["link_tx_id"], remaining)
        self.assertIn(seeded["handoff_id"], remaining)

    def test_origin_and_json_enforcement(self):
        seeded = self._seed()

        for origin in (None, "null", "https://evil.example.test"):
            response = self.unlink(
                seeded["user"], token=seeded["token"], origin=origin
            )
            self.assertEqual(response.status_code, 403, origin)

        plain = self.unlink(
            seeded["user"], token=seeded["token"], content_type="text/plain"
        )
        self.assertEqual(plain.status_code, 415)

        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_unlink_failures_keep_security_headers(self):
        seeded = self._seed()

        failures = [
            (
                self.unlink(
                    seeded["user"], token=seeded["token"], origin=None
                ),
                403,
            ),
            (
                self.unlink(
                    seeded["user"],
                    token=seeded["token"],
                    origin="https://evil.example.test",
                ),
                403,
            ),
            (
                self.unlink(
                    seeded["user"],
                    token=seeded["token"],
                    password="wrong-password",
                ),
                401,
            ),
            (
                self.unlink(
                    seeded["user"],
                    token=seeded["token"],
                    omit_confirmation=True,
                ),
                400,
            ),
            (
                self.unlink(
                    seeded["user"],
                    token=seeded["token"],
                    confirmation=False,
                ),
                400,
            ),
        ]

        not_linked = self.add_user("not-linked", password=PASSWORD)
        failures.append((self.unlink(not_linked), 409))

        for response, expected_status in failures:
            self.assertEqual(response.status_code, expected_status)
            self.assert_security_headers(response)

        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_confirmation_must_be_exactly_true(self):
        seeded = self._seed()

        false = self.unlink(
            seeded["user"], token=seeded["token"], confirmation=False
        )
        self.assertEqual(false.status_code, 400)

        missing = self.unlink(
            seeded["user"], token=seeded["token"], omit_confirmation=True
        )
        self.assertEqual(missing.status_code, 400)

        for value in (1, "true"):
            coerced = self.unlink(
                seeded["user"], token=seeded["token"], confirmation=value
            )
            self.assertEqual(coerced.status_code, 400, value)

        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_wrong_password_is_rejected(self):
        seeded = self._seed()

        response = self.unlink(
            seeded["user"], token=seeded["token"], password="wrong-password"
        )

        self.assertEqual(response.status_code, 401)
        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_passwordless_and_oidc_only_unlinking_is_rejected(self):
        passwordless = self.add_user("sso-only")
        self.link(passwordless)
        response = self.unlink(passwordless)
        self.assertEqual(response.status_code, 403)
        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

        oidc_only = self.add_user("oidc-admin", role="admin", password=PASSWORD)
        self.link(oidc_only, subject=OTHER_SUBJECT)
        with oidc_env(AUTH_MODE="oidc-only"):
            response = self.unlink(oidc_only)
        self.assertEqual(response.status_code, 403)

    def test_inactive_user_and_local_mode_are_rejected(self):
        seeded = self._seed()
        self.db.query(User).filter(User.id == seeded["user"].id).update(
            {"is_active": False}
        )
        self.db.commit()
        inactive = self.unlink(seeded["user"], token=seeded["token"])
        self.assertEqual(inactive.status_code, 401)

        with local_env():
            local = self.unlink(seeded["user"], token=seeded["token"])
        self.assertEqual(local.status_code, 404)

    def test_not_linked_is_rejected(self):
        user = self.add_user("admin", role="admin", password=PASSWORD)

        response = self.unlink(user)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "Account is not linked"})

    def test_last_usable_admin_remains_usable(self):
        seeded = self._seed()
        policy = load_auth_policy()
        self.assertTrue(is_usable_admin(self.db, seeded["user"], policy))

        response = self.unlink(seeded["user"], token=seeded["token"])

        self.assertEqual(response.status_code, 200)
        self.db.refresh(seeded["user"])
        self.assertTrue(is_usable_admin(self.db, seeded["user"], policy))
        self.assertGreaterEqual(count_usable_admins(self.db, policy), 1)

    def test_lock_is_taken_and_structural_guard_is_correct(self):
        seeded = self._seed()
        calls = []
        real_lock = auth_api.lock_admin_transitions

        def recording_lock(db):
            calls.append(db)
            return real_lock(db)

        with patch.object(auth_api, "lock_admin_transitions", recording_lock):
            response = self.unlink(seeded["user"], token=seeded["token"])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(calls), 1)

        policy = load_auth_policy()
        passwordless_admin = self.add_user("passwordless-admin", role="admin")
        self.link(passwordless_admin, subject="passwordless-subject")
        # Leave exactly one usable administrator for the structural guard.
        self.db.query(User).filter(
            User.role == "admin", User.id != passwordless_admin.id
        ).update({"is_active": False})
        self.db.commit()
        self.assertTrue(
            auth_api._identity_is_only_remaining_admin_method(
                self.db, passwordless_admin, policy
            )
        )

        second = self.add_user("second-admin", role="admin", password=PASSWORD)
        self.assertFalse(
            auth_api._identity_is_only_remaining_admin_method(
                self.db, passwordless_admin, policy
            )
        )

        self.assertFalse(
            auth_api._identity_is_only_remaining_admin_method(
                self.db, second, policy
            )
        )


if __name__ == "__main__":
    unittest.main()
