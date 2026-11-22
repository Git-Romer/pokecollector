"""Focused P4 tests for the OIDC start/callback/complete HTTP routes.

These drive a real ASGI application through ``TestClient`` with a mocked
provider boundary (the signed-token boundary itself is covered by the P3
provider suite). The database is SQLite with ``PRAGMA foreign_keys=ON``.
No network provider, live instance or real credentials are used.
"""
import json
import dataclasses
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-routes-test-secret")

# The real-nginx checks need a container runtime and a local nginx image, so they
# only run when explicitly requested. They never masquerade as passing coverage.
_NGINX_RUNTIME_TEST_ENABLED = os.environ.get("OIDC_AUTH_NGINX_TEST") == "1"

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
    import services.oidc_identity as oidc_identity
    from database import Base, get_db
    from models import CollectionItem, OidcAuthTransaction, OidcIdentity, User
    from services.auth import create_access_token, decode_token
    from services.oidc_identity import find_identity, find_user_identity
    from services.oidc_provider import (
        AuthorizationRequest,
        OidcIdentity as ProviderIdentity,
        OidcTokenExchangeError,
    )
    from services.oidc_transactions import (
        OPERATION_LINK,
        OPERATION_LOGIN,
        PHASE_HANDOFF,
        TRANSACTION_TTL,
        claim_authorization_transaction,
        promote_authorization_to_handoff,
        start_transaction,
    )
    from services.oidc_transactions import bearer_token_fingerprint

    MAIN_AVAILABLE = False
    try:
        import main as main_module

        MAIN_AVAILABLE = True
    except ModuleNotFoundError as exc:
        if (exc.name or "").split(".", 1)[0] in {
            "api",
            "database",
            "models",
            "schemas",
            "scripts",
            "services",
        }:
            raise
        MAIN_AVAILABLE = False

ISSUER = "https://idp.example.test"
OTHER_ISSUER = "https://other-idp.example.test"
CLIENT_SECRET = "synthetic-client-secret"
APP_ORIGIN = "https://app.example.test"
REDIRECT_URI = APP_ORIGIN + "/api/auth/oidc/callback"
SUBJECT = "provider-subject-1"

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


class FakeProvider:
    """Provider boundary stub: no network, no token material."""

    def __init__(self):
        self.identity = ProviderIdentity(
            issuer=ISSUER, subject=SUBJECT, auth_time=None
        )
        self.state = None
        self.build_calls = []
        self.build_error = None
        self.exchange_error = None
        self.exchange_calls = []

    async def build_authorization_url(self, **_kwargs):
        self.build_calls.append(dict(_kwargs))
        if self.build_error is not None:
            raise self.build_error
        self.state = secrets.token_urlsafe(16)
        nonce = secrets.token_urlsafe(16)
        params = {"state": self.state, "nonce": nonce, **_kwargs}
        return AuthorizationRequest(
            url=f"{ISSUER}/authorize?{urlencode(params)}",
            state=self.state,
            nonce=nonce,
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
class RouteTestCase(unittest.TestCase):
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
        # HTTPS base so Secure cookies (from the synthetic HTTPS callback URL)
        # are sent back by the cookie jar.
        self.client = TestClient(
            app, base_url="https://testserver", follow_redirects=False
        )
        self.addCleanup(self.client.close)

    # -- helpers ---------------------------------------------------------
    def add_user(self, username, *, role="trainer", is_active=True, password=None):
        from services.auth import hash_password

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
        identity = OidcIdentity(issuer=issuer, subject=subject, user_id=user.id)
        self.db.add(identity)
        self.db.commit()
        return identity

    def start(self):
        return self.client.get("/api/auth/oidc/start")

    def callback(self, state, code="synthetic-code"):
        return self.client.get(
            "/api/auth/oidc/callback",
            params={"state": state, "code": code},
        )

    def login_handoff(
        self, subject=SUBJECT, *, preferred_username=None, name=None
    ):
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
        return callback

    def complete(
        self, *, origin=APP_ORIGIN, token=None,
        content_type="application/json", body=b"{}",
    ):
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if content_type is not None:
            headers["Content-Type"] = content_type
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        # Send raw bytes so a deliberately missing Content-Type stays missing.
        return self.client.post(
            "/api/auth/oidc/complete", content=body, headers=headers
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


class StartRouteTests(RouteTestCase):
    def test_start_redirects_only_to_provider_and_sets_stable_cookie(self):
        response = self.start()

        self.assertEqual(response.status_code, 302)
        location = response.headers["location"]
        self.assertTrue(location.startswith(ISSUER + "/authorize?"))
        self.assert_security_headers(response)
        set_cookie = response.headers["set-cookie"]
        self.assertIn("pc_oidc_browser=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=lax", set_cookie)
        self.assertIn("Path=/api/auth/oidc", set_cookie)
        self.assertIn("Secure", set_cookie)

    def test_start_cookie_flags_follow_configured_scheme_not_headers(self):
        with oidc_env(
            OIDC_REDIRECT_URI="http://127.0.0.1:13000/api/auth/oidc/callback"
        ):
            response = self.client.get(
                "/api/auth/oidc/start",
                headers={"X-Forwarded-Proto": "https"},
            )
        self.assertEqual(response.status_code, 302)
        self.assertNotIn("Secure", response.headers["set-cookie"])

    def test_start_does_not_trust_host_header(self):
        response = self.client.get(
            "/api/auth/oidc/start", headers={"Host": "evil.example.test"}
        )

        self.assertEqual(response.status_code, 302)
        host = urlsplit(response.headers["location"]).hostname
        self.assertEqual(host, "idp.example.test")

    def test_start_reuses_the_browser_binding_cookie(self):
        first = self.start()
        self.assertEqual(first.status_code, 302)
        second = self.start()
        self.assertEqual(second.status_code, 302)

        first_cookie = first.headers["set-cookie"].split(";", 1)[0]
        second_cookie = second.headers["set-cookie"].split(";", 1)[0]
        self.assertEqual(first_cookie, second_cookie)

    def test_start_provider_failure_is_a_fixed_redirect(self):
        from services.oidc_provider import OidcDiscoveryError

        self.provider.build_error = OidcDiscoveryError("internal detail")
        response = self.start()

        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=provider_unavailable"
        )
        self.assert_security_headers(response)
        self.assertNotIn("internal detail", response.headers["location"])

    def test_disabled_provider_returns_generic_404_on_all_routes(self):
        with local_env():
            start = self.start()
            callback = self.client.get("/api/auth/oidc/callback")
            complete = self.complete()

        for response in (start, callback, complete):
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.json(), {"detail": "Not found"})
            self.assert_security_headers(response)

    def test_misconfigured_provider_returns_generic_503_without_env_values(self):
        values = {key: "" for key in VALID_OIDC}
        values["AUTH_MODE"] = "mixed"
        with patch.dict(os.environ, values, clear=False):
            response = self.start()

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(), {"detail": "Authentication is misconfigured"}
        )
        self.assert_security_headers(response)
        self.assertNotIn(CLIENT_SECRET, response.text)


class CallbackRouteTests(RouteTestCase):
    def test_success_uses_fixed_completion_path_and_sets_handoff_cookie(self):
        start = self.start()
        response = self.callback(state_from(start.headers["location"]))

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/auth/oidc/complete")
        self.assertNotIn("?", response.headers["location"])
        self.assert_security_headers(response)
        set_cookie = response.headers["set-cookie"]
        self.assertIn("pc_oidc_handoff=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=lax", set_cookie)
        self.assertIn("Path=/api/auth/oidc", set_cookie)
        self.assertIn("Max-Age=60", set_cookie)
        self.assertIn("Secure", set_cookie)

    def test_provider_denial_consumes_state_and_never_exchanges_or_replays(self):
        start = self.start()
        state = state_from(start.headers["location"])

        response = self.client.get(
            "/api/auth/oidc/callback",
            params={
                "error": "access_denied",
                "error_description": "<script>alert(1)</script>",
                "state": state,
            },
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=provider_denied"
        )
        self.assertNotIn("access_denied", response.headers["location"])
        self.assertNotIn("script", response.headers["location"])
        self.assert_security_headers(response)
        self.assertEqual(self.provider.exchange_calls, [])

        # Replaying the denial is a consumed/replayed state.
        replay = self.client.get(
            "/api/auth/oidc/callback",
            params={"error": "access_denied", "state": state},
        )
        self.assertEqual(
            replay.headers["location"], "/login?oidc_error=invalid_state"
        )

        # Presenting a code for the denied state can never complete login.
        future = self.callback(state)
        self.assertEqual(
            future.headers["location"], "/login?oidc_error=invalid_state"
        )
        row = self.db.query(OidcAuthTransaction).one()
        self.assertIsNotNone(row.consumed_at)
        self.assertIsNone(row.handoff_digest)

    def test_denial_without_valid_state_or_browser_is_rejected(self):
        # No state at all: invalid_request before any claim.
        no_state = self.client.get(
            "/api/auth/oidc/callback", params={"error": "access_denied"}
        )
        self.assertEqual(
            no_state.headers["location"], "/login?oidc_error=invalid_request"
        )

        # Valid-looking but unknown state: no browser-bound row, no denial success.
        unknown = self.client.get(
            "/api/auth/oidc/callback",
            params={"error": "access_denied", "state": "unknown-state"},
        )
        self.assertEqual(
            unknown.headers["location"], "/login?oidc_error=invalid_state"
        )

        # Known state but no browser cookie: cannot consume/deny.
        start = self.start()
        state = state_from(start.headers["location"])
        self.client.cookies.clear()
        no_browser = self.client.get(
            "/api/auth/oidc/callback",
            params={"error": "access_denied", "state": state},
        )
        self.assertEqual(
            no_browser.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_missing_or_duplicate_state_and_code_are_rejected(self):
        # No state and duplicate state fail before any claim.
        for url in (
            "/api/auth/oidc/callback",
            "/api/auth/oidc/callback?code=one",
            "/api/auth/oidc/callback?state=a&state=b&code=c",
        ):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 302)
                self.assertEqual(
                    response.headers["location"],
                    "/login?oidc_error=invalid_request",
                )
                self.assert_security_headers(response)

        # A missing code consumes a valid state and then fails generically.
        missing_code = self.start()
        missing_state = state_from(missing_code.headers["location"])
        response = self.client.get(
            "/api/auth/oidc/callback", params={"state": missing_state}
        )
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=invalid_request"
        )
        self.assertEqual(
            self.callback(missing_state).headers["location"],
            "/login?oidc_error=invalid_state",
        )

        # Duplicate codes consume the state and fail without exchanging.
        duplicate = self.start()
        duplicate_state = state_from(duplicate.headers["location"])
        response = self.client.get(
            "/api/auth/oidc/callback"
            f"?state={duplicate_state}&code=one&code=two"
        )
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=invalid_request"
        )
        self.assertEqual(self.provider.exchange_calls, [])

    def test_state_mismatch_and_replay_fail_closed(self):
        start = self.start()
        state = state_from(start.headers["location"])

        mismatch = self.callback("attacker-state")
        self.assertEqual(
            mismatch.headers["location"], "/login?oidc_error=invalid_state"
        )

        success = self.callback(state)
        self.assertEqual(success.headers["location"], "/auth/oidc/complete")

        replay = self.callback(state)
        self.assertEqual(
            replay.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_wrong_browser_binding_cannot_claim(self):
        start = self.start()
        state = state_from(start.headers["location"])
        self.replace_browser_cookie("different-browser-secret")

        response = self.callback(state)
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_missing_browser_cookie_cannot_claim(self):
        start = self.start()
        state = state_from(start.headers["location"])
        self.client.cookies.clear()

        response = self.callback(state)
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_provider_error_still_consumes_the_transaction(self):
        start = self.start()
        state = state_from(start.headers["location"])
        self.provider.exchange_error = OidcTokenExchangeError("raw provider body")

        failed = self.callback(state)
        self.assertEqual(
            failed.headers["location"], "/login?oidc_error=provider_error"
        )
        self.assertNotIn("raw provider body", failed.headers["location"])

        self.provider.exchange_error = None
        retry = self.callback(state)
        self.assertEqual(
            retry.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_new_start_supersedes_an_older_callback(self):
        first = self.start()
        old_state = state_from(first.headers["location"])
        second = self.start()
        self.assertEqual(second.status_code, 302)

        response = self.callback(old_state)
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_callback_fixed_redirect_does_not_reflect_host(self):
        start = self.start()
        state = state_from(start.headers["location"])

        response = self.client.get(
            "/api/auth/oidc/callback",
            params={"state": state, "code": "synthetic-code"},
            headers={"Host": "evil.example.test"},
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/auth/oidc/complete")

    def test_provider_identity_issuer_mismatch_is_rejected(self):
        from services.oidc_provider import OidcIdentity as ProviderIdentity

        start = self.start()
        state = state_from(start.headers["location"])
        self.provider.identity = ProviderIdentity(
            issuer=OTHER_ISSUER, subject=SUBJECT, auth_time=None
        )

        response = self.callback(state)
        self.assertEqual(
            response.headers["location"], "/login?oidc_error=invalid_state"
        )

    def test_https_cookie_is_secure_and_loopback_http_is_not(self):
        with oidc_env(
            OIDC_REDIRECT_URI="http://127.0.0.1:13000/api/auth/oidc/callback"
        ):
            start = self.start()
            response = self.callback(state_from(start.headers["location"]))
        self.assertEqual(response.status_code, 302)
        self.assertNotIn("Secure", response.headers["set-cookie"])


class CompletionRouteTests(RouteTestCase):
    def test_requires_exact_origin_and_json(self):
        self.login_handoff()

        cases = (
            (None, "application/json", 403),
            ("null", "application/json", 403),
            ("https://evil.example.test", "application/json", 403),
            (APP_ORIGIN, "text/plain", 415),
            (APP_ORIGIN, None, 415),
        )
        for origin, content_type, expected in cases:
            with self.subTest(origin=origin, content_type=content_type):
                response = self.complete(
                    origin=origin, content_type=content_type
                )
                self.assertEqual(response.status_code, expected)
                self.assert_security_headers(response)

    def test_origin_check_is_independent_of_global_cors(self):
        # No CORSMiddleware is installed here; the route still fails closed on a
        # hostile Origin, proving CORS is not used as authorization.
        self.login_handoff()
        response = self.complete(origin="https://hostile.example.test")
        self.assertEqual(response.status_code, 403)

    def test_login_completion_issues_token_for_exact_subject(self):
        trainer = self.add_user("trainer-a")
        admin = self.add_user("trainer-b", role="admin")
        self.link(trainer, subject="subject-a")
        self.link(admin, subject="subject-b")
        self.login_handoff(subject="subject-b")

        response = self.complete()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("access_token", body)
        self.assertEqual(body["user"]["id"], admin.id)
        self.assertEqual(body["user"]["role"], "admin")
        self.assertEqual(decode_token(body["access_token"])["sub"], str(admin.id))
        self.assert_security_headers(response)

    def test_login_completion_provisions_new_trainer_once(self):
        self.login_handoff(preferred_username="synthetic-trainer")

        first = self.complete()
        self.assertEqual(first.status_code, 200)
        body = first.json()
        self.assertIn("access_token", body)
        self.assertEqual(body["user"]["role"], "trainer")

        user = self.db.query(User).filter(User.id == body["user"]["id"]).one()
        self.assertTrue(user.is_active)
        self.assertIsNone(user.hashed_password)
        self.assertFalse(user.must_change_password)
        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

        second = self.complete()
        self.assertEqual(second.status_code, 400)
        self.assertEqual(self.db.query(User).count(), 1)

    def test_login_completion_works_with_an_existing_bearer(self):
        user = self.add_user("linked")
        self.link(user)
        other = self.add_user("other")
        bearer = create_access_token({"sub": str(other.id), "role": other.role})
        self.login_handoff()

        response = self.complete(token=bearer)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["id"], user.id)

    def test_inactive_linked_user_is_rejected_without_provisioning(self):
        inactive = self.add_user("inactive", is_active=False)
        self.link(inactive)
        self.login_handoff()

        response = self.complete()

        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access_token", response.json())
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(User).one().id, inactive.id)

    def test_inactive_race_winner_never_receives_token(self):
        inactive = self.add_user("inactive-winner", is_active=False)
        self.link(inactive)
        real_find = oidc_identity.find_identity
        calls = {"count": 0}

        def miss_once(db, issuer, subject):
            calls["count"] += 1
            if calls["count"] == 1:
                return None
            return real_find(db, issuer, subject)

        self.login_handoff(preferred_username="new-trainer")
        with patch(
            "services.oidc_identity.find_identity", side_effect=miss_once
        ):
            response = self.complete()

        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access_token", response.json())
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(User).one().id, inactive.id)

    def test_provider_hint_reaches_new_trainer_username(self):
        self.login_handoff(preferred_username="Ash Ketchum")

        response = self.complete()

        self.assertEqual(response.status_code, 200)
        user = (
            self.db.query(User)
            .filter(User.id == response.json()["user"]["id"])
            .one()
        )
        self.assertEqual(user.username, "Ash-Ketchum")
        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_name_hint_is_used_when_preferred_username_is_absent(self):
        self.login_handoff(name="Misty Waterflower")

        response = self.complete()

        self.assertEqual(response.status_code, 200)
        user = (
            self.db.query(User)
            .filter(User.id == response.json()["user"]["id"])
            .one()
        )
        self.assertEqual(user.username, "Misty-Waterflower")

    def test_subsequent_login_preserves_local_username_when_profile_changes(self):
        self.login_handoff(preferred_username="first-trainer", name="First Name")
        first = self.complete()
        self.assertEqual(first.status_code, 200)
        user_id = first.json()["user"]["id"]

        # A local rename and changed provider hints must not change ownership or
        # replace the existing account's chosen local username.
        user = self.db.query(User).filter(User.id == user_id).one()
        user.username = "local-chosen-name"
        self.db.commit()
        self.login_handoff(preferred_username="changed-trainer", name="Changed Name")
        second = self.complete()

        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["user"]["id"], user_id)
        self.assertEqual(second.json()["user"]["username"], "local-chosen-name")
        self.db.refresh(user)
        self.assertEqual(user.username, "local-chosen-name")
        self.assertEqual(self.db.query(User).count(), 1)
        identity = find_identity(self.db, ISSUER, SUBJECT)
        self.assertEqual(identity.user_id, user_id)
        self.assertEqual(self.db.query(OidcIdentity).count(), 1)

    def test_hint_collision_uses_suffix_and_never_attaches(self):
        existing = self.add_user("Ash-Ketchum")
        self.login_handoff(preferred_username="Ash Ketchum")

        response = self.complete()

        self.assertEqual(response.status_code, 200)
        user = (
            self.db.query(User)
            .filter(User.id == response.json()["user"]["id"])
            .one()
        )
        self.assertNotEqual(user.id, existing.id)
        self.assertTrue(user.username.startswith("Ash-Ketchum-"))
        self.assertEqual(self.db.query(User).count(), 2)

    def test_email_shaped_hint_is_sanitized_not_an_identity_key(self):
        self.login_handoff(preferred_username="ash@example.test")

        response = self.complete()

        self.assertEqual(response.status_code, 200)
        user = (
            self.db.query(User)
            .filter(User.id == response.json()["user"]["id"])
            .one()
        )
        self.assertEqual(user.username, "ash-example-test")
        self.assertNotIn("@", user.username)
        self.assertIsNotNone(find_identity(self.db, ISSUER, SUBJECT))

    def test_unusable_hint_requires_username_before_provisioning(self):
        self.login_handoff(preferred_username="🔥🔥")

        response = self.complete()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"username_required": True})
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)

    def test_completion_is_browser_bound(self):
        self.login_handoff()
        self.replace_browser_cookie("different-browser")

        response = self.complete()

        self.assertEqual(response.status_code, 400)

    def _link_handoff(self, user, bearer, *, subject="link-subject", browser="link-browser"):
        # Seed the cookie jar with a real browser cookie (domain/path), then
        # bind the link transaction to that same secret.
        self.start()
        self.replace_browser_cookie(browser)
        start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LINK,
            state="link-state",
            browser_secret=browser,
            nonce="link-nonce",
            code_verifier="link-verifier",
            user_id=user.id,
            bearer_token=bearer,
        )
        self.provider.identity = ProviderIdentity(
            issuer=ISSUER, subject=subject, auth_time=1_800_000_000
        )
        callback = self.callback("link-state")
        self.assertEqual(callback.status_code, 302)
        self.assertEqual(callback.headers["location"], "/auth/oidc/complete")

    def test_link_completion_returns_linked_result_without_token_or_role_change(self):
        admin = self.add_user("admin", role="admin", password="local-password")
        bearer = create_access_token(
            {"sub": str(admin.id), "role": admin.role}
        )
        self._link_handoff(admin, bearer)

        response = self.complete(token=bearer, body=b'{"username":null}')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"linked": True})
        self.assertNotIn("access_token", response.json())
        self.db.refresh(admin)
        self.assertEqual(admin.role, "admin")
        self.assertEqual(
            find_identity(self.db, ISSUER, "link-subject").user_id, admin.id
        )
        self.assert_security_headers(response)

    def test_link_completion_requires_matching_bearer_and_user(self):
        admin = self.add_user("admin", role="admin", password="local-password")
        other = self.add_user("other")
        bearer = create_access_token({"sub": str(admin.id), "role": admin.role})
        other_bearer = create_access_token(
            {"sub": str(other.id), "role": other.role}
        )
        self._link_handoff(admin, bearer)

        self.assertEqual(self.complete().status_code, 400)
        self.assertEqual(self.complete(token=other_bearer).status_code, 400)
        self.assertIsNone(find_identity(self.db, ISSUER, "link-subject"))

        success = self.complete(token=bearer)
        self.assertEqual(success.status_code, 200)
        self.assertEqual(success.json(), {"linked": True})

    def test_link_completion_with_an_unresolvable_bearer_returns_401(self):
        admin = self.add_user("admin", role="admin", password="local-password")
        bearer = create_access_token({"sub": str(admin.id), "role": admin.role})
        self._link_handoff(admin, bearer)
        expired = create_access_token(
            {"sub": str(admin.id), "role": admin.role},
            expires_delta=timedelta(seconds=-60),
        )

        for bad_token in (expired, "not-a-jwt"):
            with self.subTest(token=bad_token[:12]):
                response = self.complete(token=bad_token)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(
                    response.json(), {"detail": "Authentication required"}
                )
                self.assert_security_headers(response)

        # The handoff was not consumed by the failed attempts.
        self.assertIsNone(find_identity(self.db, ISSUER, "link-subject"))
        success = self.complete(token=bearer)
        self.assertEqual(success.status_code, 200)
        self.assertEqual(success.json(), {"linked": True})

    def test_login_handoff_ignores_an_unresolvable_bearer(self):
        # Login handoffs are bound to the browser, not to a bearer; a stale token
        # left in the browser must not block sign-in.
        user = self.add_user("trainer", password="local-password")
        self.link(user)
        self.login_handoff()

        response = self.complete(token="not-a-jwt")

        self.assertEqual(response.status_code, 200)
        self.assertIn("access_token", response.json())

    def test_login_handoff_past_its_deadline_never_mints_a_token(self):
        user = self.add_user("trainer", password="local-password")
        self.link(user)
        self.login_handoff()
        real_claim = auth_api.claim_handoff_transaction

        def claim_then_expire(db, **kwargs):
            transaction = real_claim(db, **kwargs)
            transaction.expires_at = datetime.utcnow() - timedelta(seconds=1)
            return transaction

        with patch.object(
            auth_api, "claim_handoff_transaction", claim_then_expire
        ):
            with patch.object(auth_api, "create_access_token") as mint:
                response = self.complete()

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(), {"detail": "Sign-in could not be completed"}
        )
        self.assert_security_headers(response)
        mint.assert_not_called()

    def test_link_conflict_does_not_change_role_or_session(self):
        admin = self.add_user("admin", role="admin", password="local-password")
        bearer = create_access_token({"sub": str(admin.id), "role": admin.role})
        self.link(admin, subject="already-linked")
        self._link_handoff(admin, bearer, subject="new-subject")

        response = self.complete(token=bearer)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "Account could not be linked"})
        self.db.refresh(admin)
        self.assertEqual(admin.role, "admin")
        self.assertIsNone(find_identity(self.db, ISSUER, "new-subject"))

    def test_link_handoff_cannot_be_redeemed_as_a_login(self):
        admin = self.add_user("admin", role="admin", password="local-password")
        bearer = create_access_token({"sub": str(admin.id), "role": admin.role})
        self._link_handoff(admin, bearer)

        response = self.complete()

        self.assertEqual(response.status_code, 400)
        self.assertNotIn("access_token", response.json())

    def test_link_rejects_a_mode_switch_after_handoff(self):
        trainer = self.add_user("trainer", password="local-password")
        bearer = create_access_token({"sub": str(trainer.id), "role": trainer.role})
        self._link_handoff(trainer, bearer)

        with oidc_env(AUTH_MODE="oidc-only"):
            response = self.complete(token=bearer)

        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access_token", response.json())
        self.assertIsNone(find_identity(self.db, ISSUER, "link-subject"))

    def test_link_rejects_passwordless_account(self):
        user = self.add_user("passwordless")
        bearer = create_access_token({"sub": str(user.id), "role": user.role})
        self._link_handoff(user, bearer)

        response = self.complete(token=bearer)

        self.assertEqual(response.status_code, 403)
        self.assertIsNone(find_identity(self.db, ISSUER, "link-subject"))

    def test_link_rejects_deactivated_account(self):
        user = self.add_user("deactivated", password="local-password", is_active=False)
        bearer = create_access_token({"sub": str(user.id), "role": user.role})
        self._link_handoff(user, bearer)

        response = self.complete(token=bearer)

        # A bearer that no longer resolves to an active user is an
        # authentication failure, not a malformed request.
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("access_token", response.json())
        self.assertIsNone(find_identity(self.db, ISSUER, "link-subject"))

    def test_link_rejects_expired_local_reauth_deadline(self):
        trainer = self.add_user("trainer", password="local-password")
        bearer = create_access_token({"sub": str(trainer.id), "role": trainer.role})
        self._link_handoff(trainer, bearer)
        row = (
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.operation == OPERATION_LINK)
            .one()
        )
        # Keep the handoff redeemable but move the original transaction start
        # outside the five-minute local reauthentication window.
        row.created_at = datetime.utcnow() - TRANSACTION_TTL - timedelta(seconds=1)
        row.expires_at = datetime.utcnow() + timedelta(seconds=30)
        self.db.commit()

        response = self.complete(token=bearer)

        self.assertEqual(response.status_code, 400)
        self.assertIsNone(find_identity(self.db, ISSUER, "link-subject"))


class UsernameFallbackCompletionTests(RouteTestCase):
    def submit(self, username):
        return self.complete(body=json.dumps({"username": username}).encode())

    def pending(self):
        return self.db.query(OidcAuthTransaction).populate_existing().one()

    def assert_unconsumed(self, deadline):
        row = self.pending()
        self.assertIsNone(row.consumed_at)
        self.assertEqual(row.expires_at, deadline)

    def test_repeated_prompt_does_not_consume_extend_create_or_issue_token(self):
        self.login_handoff()
        row = self.pending()
        deadline, digest = row.expires_at, row.handoff_digest
        cookies = dict(self.client.cookies)
        with patch.object(auth_api, "create_access_token") as mint:
            for _ in range(2):
                response = self.complete()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"username_required": True})
                self.assert_security_headers(response)
                self.assertNotIn("set-cookie", response.headers)
                self.assert_unconsumed(deadline)
            mint.assert_not_called()
        self.assertEqual(self.pending().handoff_digest, digest)
        self.assertEqual(dict(self.client.cookies), cookies)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)

    def test_exact_trimmed_self_service_names_and_length_boundaries(self):
        for index, username in enumerate((" ab ", "x" * 32, "  雪の trainer 名 🔥  ")):
            with self.subTest(username=username):
                auth_api._oidc_rate_state.clear()
                self.login_handoff(subject=f"chosen-{index}")
                response = self.submit(username)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["user"]["username"], username.strip())
                self.assertIn("access_token", response.json())
                user = self.db.query(User).filter_by(id=response.json()["user"]["id"]).one()
                self.assertEqual(user.username, username.strip())
                self.assertEqual(user.role, "trainer")
                self.assertTrue(user.is_active)
                self.assertIsNone(user.hashed_password)
                self.assertFalse(user.must_change_password)
                self.assertEqual(find_identity(self.db, ISSUER, f"chosen-{index}").user_id, user.id)
                self.assertEqual(self.submit(username).status_code, 400)

    def test_invalid_supplied_names_are_retryable_without_consumption(self):
        self.login_handoff()
        deadline = self.pending().expires_at
        for invalid in (None, "", "  ", "x", " x ", "x" * 33, 123, True, [], {}):
            with self.subTest(invalid=invalid):
                auth_api._oidc_rate_state.clear()
                response = self.submit(invalid)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {
                    "code": "invalid_username",
                    "detail": "Username must be between 2 and 32 characters",
                })
                self.assert_security_headers(response)
                self.assert_unconsumed(deadline)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)
        self.assertEqual(self.submit("retry-name").status_code, 200)

    def test_username_collision_never_links_or_suffixes_and_same_handoff_can_retry(self):
        existing = self.add_user("taken-name", role="admin")
        self.login_handoff()
        deadline = self.pending().expires_at
        cookies = dict(self.client.cookies)
        response = self.submit(" taken-name ")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {
            "code": "username_taken", "detail": "Username already taken",
        })
        self.assert_unconsumed(deadline)
        self.assertEqual(dict(self.client.cookies), cookies)
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)
        retry = self.submit("available-name")
        self.assertEqual(retry.status_code, 200)
        self.assertNotEqual(retry.json()["user"]["id"], existing.id)
        self.assertEqual(retry.json()["user"]["username"], "available-name")

    def test_existing_identity_ignores_chosen_field_without_rename_or_prompt(self):
        user = self.add_user("local-name")
        self.link(user)
        for chosen in (None, "replacement-name"):
            with self.subTest(chosen=chosen):
                self.login_handoff()
                response = self.submit(chosen)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["user"]["id"], user.id)
                self.assertEqual(response.json()["user"]["username"], "local-name")
        user.is_active = False
        self.db.commit()
        self.login_handoff()
        self.assertEqual(self.submit("replacement-name").status_code, 403)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(user.username, "local-name")

    def test_provider_named_provisioning_ignores_chosen_name_even_if_invalid(self):
        self.login_handoff(preferred_username="Provider Trainer")
        response = self.submit(None)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["username"], "Provider-Trainer")

    def test_malformed_and_oversized_bodies_fail_before_any_claim(self):
        self.login_handoff()
        deadline = self.pending().expires_at
        for body, status in (
            (b"{", 400), (b"[]", 400), (b"null", 400), (b"", 400),
            (b'{"username":"' + b"x" * 8192 + b'"}', 413),
        ):
            with self.subTest(body_length=len(body)):
                with patch.object(auth_api, "claim_handoff_transaction") as claim:
                    response = self.complete(body=body)
                self.assertEqual(response.status_code, status)
                claim.assert_not_called()
                self.assert_unconsumed(deadline)

    def test_wrong_browser_expired_superseded_and_replayed_handoffs_fail_generically(self):
        self.login_handoff()
        cookies = dict(self.client.cookies)
        self.replace_browser_cookie("wrong-browser")
        wrong_browser = self.submit("chosen-name")
        self.assertEqual(wrong_browser.status_code, 400)
        self.assertEqual(wrong_browser.json(), {"detail": "Sign-in could not be completed"})
        self.replace_browser_cookie(cookies[auth_api.OIDC_BROWSER_COOKIE])
        # Expiry and supersession are independently rejected with no naming retry.
        row = self.pending()
        row.expires_at = datetime.utcnow() - timedelta(seconds=1)
        self.db.commit()
        self.assertEqual(self.submit("chosen-name").status_code, 400)
        self.login_handoff()
        self.start()
        self.assertEqual(self.submit("chosen-name").status_code, 400)
        self.login_handoff()
        self.assertEqual(self.submit("chosen-name").status_code, 200)
        replay = self.submit("other-name")
        self.assertEqual(replay.status_code, 400)
        self.assertNotIn("code", replay.json())

    def test_wrong_issuer_never_prompts_or_provisions(self):
        self.login_handoff()
        with oidc_env(OIDC_ISSUER_URL=OTHER_ISSUER):
            response = self.submit("chosen-name")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "Sign-in could not be completed"})
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.complete().status_code, 400)

    def test_deferred_claim_rechecks_issuer_and_login_operation_after_preview(self):
        self.login_handoff()
        deadline = self.pending().expires_at
        real_claim = auth_api.claim_handoff_transaction
        for field, value in (("issuer", OTHER_ISSUER), ("operation", OPERATION_LINK)):
            with self.subTest(field=field):
                def changed_claim(db, **kwargs):
                    claimed = real_claim(db, **kwargs)
                    setattr(claimed, field, value)
                    return claimed

                with patch.object(auth_api, "claim_handoff_transaction", changed_claim):
                    with patch.object(auth_api, "create_access_token") as mint:
                        response = self.submit("chosen-name")
                        mint.assert_not_called()
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {"detail": "Sign-in could not be completed"})
                self.assert_unconsumed(deadline)
                self.assertEqual(self.db.query(User).count(), 0)
                self.assertEqual(self.db.query(OidcIdentity).count(), 0)

    def test_post_insert_failure_rolls_back_both_rows_and_claim_then_retry_succeeds(self):
        self.login_handoff()
        deadline = self.pending().expires_at
        real_provision = auth_api.provision_user_for_identity_with_username

        def fail_after_insert(db, **kwargs):
            real_provision(db, **kwargs)
            raise RuntimeError("synthetic-private-failure")

        with patch.object(auth_api, "provision_user_for_identity_with_username", fail_after_insert):
            with patch.object(auth_api, "create_access_token") as mint:
                response = self.submit("chosen-name")
                mint.assert_not_called()
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"detail": "Sign-in failed"})
        self.assert_unconsumed(deadline)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)
        self.assertEqual(self.submit("chosen-name").status_code, 200)

    def test_expiry_after_blocking_provisioning_rolls_back_rows_and_claim(self):
        self.login_handoff()
        deadline = self.pending().expires_at
        with patch.object(auth_api, "datetime") as clock:
            clock.utcnow.return_value = deadline + timedelta(seconds=1)
            with patch.object(auth_api, "create_access_token") as mint:
                response = self.submit("chosen-name")
                mint.assert_not_called()
        self.assertEqual(response.status_code, 400)
        self.assert_unconsumed(deadline)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)

    def test_unknown_integrity_error_is_generic_not_a_username_conflict(self):
        from sqlalchemy.exc import IntegrityError

        self.login_handoff()
        deadline = self.pending().expires_at
        real_flush = self.db.flush

        def insert_then_fail(*args, **kwargs):
            candidate_pending = any(
                isinstance(row, User) and row.username == "chosen-name"
                for row in self.db.new
            )
            real_flush(*args, **kwargs)
            if candidate_pending:
                raise IntegrityError("synthetic-statement", {}, Exception("private-error"))

        with patch.object(self.db, "flush", insert_then_fail):
            response = self.submit("chosen-name")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"detail": "Sign-in failed"})
        self.assert_unconsumed(deadline)
        self.assertEqual(self.db.query(User).count(), 0)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)

    def test_identity_appearing_after_preview_is_not_renamed_or_reprovisioned(self):
        user = self.add_user("race-winner")
        self.link(user)
        real_resolve = auth_api.resolve_identity_user
        for active in (True, False):
            with self.subTest(active=active):
                user.is_active = active
                self.db.commit()
                self.login_handoff()
                deadline = self.pending().expires_at
                calls = {"count": 0}

                def miss_preview(db, issuer, subject):
                    calls["count"] += 1
                    return None if calls["count"] == 1 else real_resolve(db, issuer, subject)

                with patch.object(auth_api, "resolve_identity_user", miss_preview):
                    response = self.submit("candidate-name")
                self.assertEqual(response.status_code, 200 if active else 403)
                self.assertEqual(self.db.query(User).count(), 1)
                self.assertEqual(self.db.query(OidcIdentity).count(), 1)
                self.db.refresh(user)
                self.assertEqual(user.username, "race-winner")
                if active:
                    self.assertEqual(response.json()["user"]["id"], user.id)
                else:
                    self.assert_unconsumed(deadline)

    def test_identity_deleted_after_preview_cannot_reprovision_unnamed_trainer(self):
        user = self.add_user("existing-local-name")
        self.link(user)
        self.login_handoff()
        real_claim = auth_api.claim_handoff_transaction

        def claim_then_remove_identity(db, **kwargs):
            transaction = real_claim(db, **kwargs)
            identity = find_identity(db, ISSUER, SUBJECT)
            db.delete(identity)
            db.commit()
            return transaction

        with patch.object(auth_api, "claim_handoff_transaction", claim_then_remove_identity):
            with patch.object(auth_api, "provision_user_for_identity") as provision:
                with patch.object(auth_api, "create_access_token") as mint:
                    response = self.complete()
                    provision.assert_not_called()
                    mint.assert_not_called()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "Sign-in could not be completed"})
        self.assert_security_headers(response)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(OidcIdentity).count(), 0)
        self.assertEqual(self.db.query(User).one().username, "existing-local-name")
        self.assertIsNotNone(self.pending().consumed_at)


class RateLimitTests(RouteTestCase):
    def test_start_throttle_is_generic_and_no_store(self):
        # The first request only has the client address; every later request
        # carries the browser-binding cookie this client received, so that
        # browser's bucket is the one that fills up.
        for _ in range(auth_api._OIDC_RATE_LIMIT_MAX + 1):
            self.assertEqual(self.start().status_code, 302)

        response = self.start()

        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            response.json(), {"detail": "Too many sign-in attempts. Try again in a minute."}
        )
        self.assert_security_headers(response)

    def test_complete_throttle_is_generic_and_no_store(self):
        for _ in range(auth_api._OIDC_RATE_LIMIT_MAX):
            self.assertEqual(self.complete().status_code, 400)

        response = self.complete()

        self.assertEqual(response.status_code, 429)
        self.assert_security_headers(response)


class ServingConfigurationTests(unittest.TestCase):
    """Static assertions for the native serving configuration (no live instance)."""

    def setUp(self):
        self.repo_root = Path(__file__).resolve().parents[2]

    def test_uvicorn_access_log_is_enabled(self):
        # Access logging must stay on; the OIDC query string is redacted by the
        # uvicorn.access filter instead of by disabling logging for the app.
        dockerfile = (self.repo_root / "backend" / "Dockerfile").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("--no-access-log", dockerfile)
        self.assertIn('CMD ["uvicorn", "main:app"', dockerfile)
        main_source = (self.repo_root / "backend" / "main.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("install_oidc_access_log_redaction", main_source)

    def test_nginx_callback_is_path_only_logged_without_query(self):
        nginx = (self.repo_root / "frontend" / "nginx.conf").read_text(
            encoding="utf-8"
        )
        # A dedicated format logs the method and path only ($uri excludes the
        # query string), and the OIDC location must use it with logging on.
        self.assertIn("log_format oidc_path_only", nginx)
        log_format = nginx.split("log_format oidc_path_only", 1)[1]
        log_format = log_format.split(";", 1)[0]
        self.assertIn("$request_method $uri", log_format)
        self.assertNotIn("$request_uri", log_format)
        self.assertNotIn("$request ", log_format)
        self.assertIn(
            "access_log /var/log/nginx/access.log oidc_path_only;", nginx
        )
        self.assertNotIn("access_log off;", nginx)
        self.assertIn(
            "location ^~ /api/auth/oidc/", nginx, "OIDC location is required"
        )
        oidc_block = nginx.split("location ^~ /api/auth/oidc/", 1)[1]
        oidc_block = oidc_block.split("}", 1)[0]
        self.assertIn("error_log /dev/null crit;", oidc_block)
        # No location-level add_header: it would suppress the inherited
        # server-level CSP/frame/permissions headers.
        self.assertEqual(
            [
                line.strip()
                for line in oidc_block.splitlines()
                if line.strip().startswith("add_header")
            ],
            [],
        )
        self.assertNotIn("proxy_hide_header Cache-Control;", oidc_block)

    def _podman_nginx_image(self):
        if shutil.which("podman") is None:
            self.skipTest("podman is not available for a real nginx check")
        if (
            subprocess.run(
                ["podman", "image", "exists", "docker.io/library/nginx:alpine"],
                capture_output=True,
            ).returncode
            != 0
        ):
            self.skipTest("nginx:alpine image is not available locally")
        return "docker.io/library/nginx:alpine"

    @unittest.skipUnless(
        _NGINX_RUNTIME_TEST_ENABLED,
        "set OIDC_AUTH_NGINX_TEST=1 to run the real-nginx serving checks",
    )
    def test_nginx_config_syntax_with_real_nginx(self):
        image = self._podman_nginx_image()
        nginx_conf = self.repo_root / "frontend" / "nginx.conf"
        with tempfile.TemporaryDirectory():
            result = subprocess.run(
                [
                    "podman",
                    "run",
                    "--rm",
                    "--add-host",
                    "backend:127.0.0.1",
                    "-v",
                    f"{nginx_conf}:/etc/nginx/conf.d/default.conf:ro,z",
                    image,
                    "nginx",
                    "-t",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(
            result.returncode,
            0,
            f"real nginx config check failed: {result.stdout}\n{result.stderr}",
        )
        self.assertIn("syntax is ok", (result.stdout + result.stderr).lower())

    @unittest.skipUnless(
        _NGINX_RUNTIME_TEST_ENABLED,
        "set OIDC_AUTH_NGINX_TEST=1 to run the real-nginx serving checks",
    )
    def test_nginx_error_path_logs_path_only_without_query(self):
        image = self._podman_nginx_image()
        nginx_conf = self.repo_root / "frontend" / "nginx.conf"
        name = f"oidc-nginx-{secrets.token_hex(4)}"
        started = subprocess.run(
            [
                "podman",
                "run",
                "-d",
                "--rm",
                "--name",
                name,
                "--add-host",
                "backend:127.0.0.1",
                "-p",
                "127.0.0.1::80",
                "-v",
                f"{nginx_conf}:/etc/nginx/conf.d/default.conf:ro,z",
                image,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(started.returncode, 0, started.stderr)
        try:
            port_result = subprocess.run(
                ["podman", "port", name, "80/tcp"],
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(port_result.returncode, 0, port_result.stderr)
            port = int(port_result.stdout.strip().rsplit(":", 1)[1])
            for _ in range(50):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                self.fail("nginx test container did not start listening")

            url = (
                f"http://127.0.0.1:{port}/api/auth/oidc/callback"
                "?code=URI_SECRET_VALUE&state=STATE_SECRET_VALUE"
            )
            try:
                with urllib.request.urlopen(url, timeout=10) as response:
                    status = response.status
            except urllib.error.HTTPError as exc:
                status = exc.code
            self.assertIn(status, (500, 502, 503, 504))

            time.sleep(0.2)
            logs = subprocess.run(
                ["podman", "logs", name],
                capture_output=True,
                text=True,
                timeout=20,
            )
            combined = logs.stdout + logs.stderr
            # The attempt is recorded, but only as method plus path.
            self.assertIn("/api/auth/oidc/callback", combined)
            self.assertNotIn("URI_SECRET_VALUE", combined)
            self.assertNotIn("STATE_SECRET_VALUE", combined)
            self.assertNotIn("?code=", combined)
        finally:
            subprocess.run(
                ["podman", "rm", "-f", name],
                capture_output=True,
                timeout=30,
            )


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OidcRateLimitBucketTests(unittest.TestCase):
    """The OIDC limiter keys per browser, not per shared proxy address."""

    def setUp(self):
        from types import SimpleNamespace

        self._SimpleNamespace = SimpleNamespace
        auth_api._oidc_rate_state.clear()
        self.addCleanup(auth_api._oidc_rate_state.clear)

    def _request(self, *, cookie=None, host="172.18.0.5"):
        cookies = {} if cookie is None else {auth_api.OIDC_BROWSER_COOKIE: cookie}
        return self._SimpleNamespace(
            cookies=cookies, client=self._SimpleNamespace(host=host)
        )

    def _consume(self, request, times, bucket="start"):
        return [
            auth_api._consume_oidc_rate_limit(request, bucket) for _ in range(times)
        ]

    def test_browsers_behind_one_proxy_address_have_independent_budgets(self):
        first = self._request(cookie="browser-secret-one")
        second = self._request(cookie="browser-secret-two")

        allowed = self._consume(first, auth_api._OIDC_RATE_LIMIT_MAX)
        self.assertTrue(all(allowed))
        self.assertFalse(auth_api._consume_oidc_rate_limit(first, "start"))

        # Same source address, different browser: still has its own budget.
        self.assertTrue(auth_api._consume_oidc_rate_limit(second, "start"))

    def test_requests_without_a_cookie_share_the_address_bucket(self):
        anonymous = self._request()

        allowed = self._consume(anonymous, auth_api._OIDC_RATE_LIMIT_MAX)
        self.assertTrue(all(allowed))
        self.assertFalse(auth_api._consume_oidc_rate_limit(anonymous, "start"))

        # A different proxy address is a different fallback bucket.
        other = self._request(host="172.18.0.6")
        self.assertTrue(auth_api._consume_oidc_rate_limit(other, "start"))

    def test_browser_bucket_does_not_collide_with_the_address_fallback(self):
        anonymous = self._request()
        self._consume(anonymous, auth_api._OIDC_RATE_LIMIT_MAX)
        self.assertFalse(auth_api._consume_oidc_rate_limit(anonymous, "start"))

        bound = self._request(cookie="browser-secret-three")
        self.assertTrue(auth_api._consume_oidc_rate_limit(bound, "start"))

    def test_cookie_value_is_not_stored_verbatim(self):
        secret = "browser-cookie-secret-value"
        self._consume(self._request(cookie=secret), 1)

        keys = [key for key in auth_api._oidc_rate_state if key[0] == "start"]
        self.assertEqual(len(keys), 1)
        self.assertNotIn(secret, keys[0][1])
        self.assertTrue(keys[0][1].startswith("browser:"))

    def test_buckets_are_separate_per_endpoint(self):
        request = self._request(cookie="browser-secret-four")
        self._consume(request, auth_api._OIDC_RATE_LIMIT_MAX, bucket="start")

        self.assertFalse(auth_api._consume_oidc_rate_limit(request, "start"))
        self.assertTrue(auth_api._consume_oidc_rate_limit(request, "complete"))


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ProviderAdapterCacheTests(unittest.TestCase):
    """The route layer must reuse one adapter per configuration."""

    def setUp(self):
        from services.auth_policy import OidcConfig

        self.config = OidcConfig(
            issuer_url=ISSUER,
            client_id="pokecollector",
            client_secret=CLIENT_SECRET,
            redirect_uri=REDIRECT_URI,
        )
        self.addCleanup(auth_api._oidc_provider_cache.clear)

    def test_same_configuration_reuses_the_adapter(self):
        first = auth_api._build_oidc_provider(self.config)
        second = auth_api._build_oidc_provider(self.config)

        self.assertIs(first, second)

    def test_changed_configuration_replaces_the_cached_adapter(self):
        first = auth_api._build_oidc_provider(self.config)
        changed = dataclasses.replace(self.config, client_id="other-client")

        second = auth_api._build_oidc_provider(changed)

        self.assertIsNot(first, second)
        self.assertIs(auth_api._build_oidc_provider(changed), second)
        # Only the active configuration stays cached, so a changed issuer or
        # client can never be served by a stale adapter.
        self.assertEqual(len(auth_api._oidc_provider_cache), 1)


@unittest.skipUnless(
    DEPS_AVAILABLE and MAIN_AVAILABLE,
    "production application stack is not available",
)
class ProductionStackMiddlewareTests(unittest.TestCase):
    """Exercise the real application middleware, not a minimal mock app."""

    def setUp(self):
        self.env = oidc_env()
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(
            main_module.app, base_url="https://testserver", follow_redirects=False
        )
        self.addCleanup(self.client.close)

    def assert_security_headers(self, response):
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(response.headers.get("referrer-policy"), "no-referrer")

    def test_oidc_preflight_rejects_bad_origin_without_wildcard_echo(self):
        response = self.client.options(
            "/api/auth/oidc/complete",
            headers={
                "Origin": "https://evil.example.test",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access-control-allow-origin", response.headers)
        self.assert_security_headers(response)

    def test_oidc_preflight_allows_exact_origin_only(self):
        response = self.client.options(
            "/api/auth/oidc/complete",
            headers={
                "Origin": APP_ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(
            response.headers.get("access-control-allow-origin"), APP_ORIGIN
        )
        self.assertNotEqual(
            response.headers.get("access-control-allow-origin"), "*"
        )
        self.assertEqual(
            response.headers.get("access-control-allow-credentials"), "true"
        )
        self.assert_security_headers(response)

    def test_oidc_link_and_unlink_preflight_are_exact_origin_only(self):
        for path in ("/api/auth/oidc/link", "/api/auth/oidc/unlink"):
            with self.subTest(path=path):
                response = self.client.options(
                    path,
                    headers={
                        "Origin": APP_ORIGIN,
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "content-type",
                    },
                )

                self.assertEqual(response.status_code, 204)
                self.assertEqual(
                    response.headers.get("access-control-allow-origin"),
                    APP_ORIGIN,
                )
                self.assertNotEqual(
                    response.headers.get("access-control-allow-origin"),
                    "*",
                )
                self.assertEqual(
                    response.headers.get("access-control-allow-credentials"),
                    "true",
                )
                self.assert_security_headers(response)

                hostile = self.client.options(
                    path,
                    headers={
                        "Origin": "https://evil.example.test",
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "content-type",
                    },
                )

                self.assertEqual(hostile.status_code, 403)
                self.assertNotIn(
                    "access-control-allow-origin", hostile.headers
                )
                self.assert_security_headers(hostile)

    def test_oidc_unhandled_500_keeps_security_headers_and_generic_body(self):
        from starlette.routing import Route

        async def crash(_request):
            raise RuntimeError("synthetic callback?code=URI_SECRET_VALUE")

        route = Route("/api/auth/oidc/_test_failure", crash, methods=["GET"])
        main_module.app.router.routes.append(route)
        try:
            with self.assertLogs("main", level="WARNING") as captured:
                response = self.client.get("/api/auth/oidc/_test_failure")
        finally:
            main_module.app.router.routes.remove(route)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            response.json(), {"detail": "Internal server error"}
        )
        self.assert_security_headers(response)
        self.assertNotIn("URI_SECRET_VALUE", response.text)
        self.assertNotIn("URI_SECRET_VALUE", "\n".join(captured.output))

    def test_legacy_cors_preflight_behavior_is_preserved(self):
        response = self.client.options(
            "/api/auth/login",
            headers={
                "Origin": "https://legacy.example.test",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("access-control-allow-origin", response.headers)


class OidcAccountManagementRouteTests(RouteTestCase):
    def bearer(self, user):
        token = create_access_token({"sub": str(user.id), "role": user.role})
        return token, {"Authorization": f"Bearer {token}"}

    def test_identity_endpoint_returns_only_safe_configured_fields(self):
        user = self.add_user("existing", password="correct horse")
        self.link(user, subject="private-subject-value")
        _token, headers = self.bearer(user)

        response = self.client.get("/api/auth/oidc/identity", headers=headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "linked": True,
                "display_name": "Single sign-on",
                "unlink_permitted": True,
            },
        )
        self.assertNotIn("private-subject-value", response.text)
        self.assert_security_headers(response)

    def test_identity_endpoint_reports_unlinked_without_subject_metadata(self):
        user = self.add_user("existing", password="correct horse")
        _token, headers = self.bearer(user)

        response = self.client.get("/api/auth/oidc/identity", headers=headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "linked": False,
                "display_name": "Single sign-on",
                "unlink_permitted": False,
            },
        )

    def test_link_start_requires_fresh_local_password_and_exact_origin(self):
        user = self.add_user("existing", password="correct horse")
        _token, bearer = self.bearer(user)
        headers = {**bearer, "Origin": APP_ORIGIN}

        wrong_password = self.client.post(
            "/api/auth/oidc/link",
            json={"current_password": "wrong"},
            headers=headers,
        )
        self.assertEqual(wrong_password.status_code, 401)
        self.assertEqual(self.provider.build_calls, [])

        mismatched_origin = self.client.post(
            "/api/auth/oidc/link",
            json={"current_password": "correct horse"},
            headers={**bearer, "Origin": "https://evil.example.test"},
        )
        self.assertEqual(mismatched_origin.status_code, 403)
        self.assertEqual(self.provider.build_calls, [])

        missing_origin = self.client.post(
            "/api/auth/oidc/link",
            json={"current_password": "correct horse"},
            headers=bearer,
        )
        self.assertEqual(missing_origin.status_code, 403)
        self.assertEqual(self.provider.build_calls, [])

    def test_link_start_uses_fresh_provider_prompt_and_binds_bearer(self):
        user = self.add_user("existing", password="correct horse")
        token, bearer = self.bearer(user)
        response = self.client.post(
            "/api/auth/oidc/link",
            json={"current_password": "correct horse"},
            headers={**bearer, "Origin": APP_ORIGIN},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.provider.build_calls, [{"prompt": "login"}])
        params = parse_qs(urlsplit(response.json()["authorization_url"]).query)
        self.assertEqual(params["prompt"], ["login"])
        self.assertNotIn("max_age", params)
        transaction = self.db.query(OidcAuthTransaction).one()
        self.assertEqual(transaction.operation, OPERATION_LINK)
        self.assertEqual(transaction.user_id, user.id)
        self.assertEqual(
            transaction.bearer_fingerprint,
            bearer_token_fingerprint(token),
        )
        self.assertIn("pc_oidc_browser=", response.headers.get("set-cookie", ""))
        self.assert_security_headers(response)

    def test_link_start_rejects_account_already_linked_to_issuer(self):
        user = self.add_user("existing", password="correct horse")
        self.link(user)
        _token, bearer = self.bearer(user)

        response = self.client.post(
            "/api/auth/oidc/link",
            json={"current_password": "correct horse"},
            headers={**bearer, "Origin": APP_ORIGIN},
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.provider.build_calls, [])

    def test_link_start_is_unavailable_outside_mixed_mode(self):
        user = self.add_user("existing", password="correct horse")
        _token, bearer = self.bearer(user)
        with oidc_env(AUTH_MODE="oidc-only"):
            response = self.client.post(
                "/api/auth/oidc/link",
                json={"current_password": "correct horse"},
                headers={**bearer, "Origin": APP_ORIGIN},
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.provider.build_calls, [])

    def test_unlink_preserves_user_role_collection_and_invalidates_flows(self):
        user = self.add_user("admin-user", role="admin", password="correct horse")
        identity = self.link(user, subject=SUBJECT)
        collection = CollectionItem(user_id=user.id, quantity=2, variant="Normal")
        self.db.add(collection)
        self.db.commit()
        collection_id = collection.id
        token, bearer = self.bearer(user)

        # A link transaction is user-bound; an outstanding login handoff is
        # identity-bound. Unlink must invalidate both in the same DB commit.
        start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LINK,
            state="pending-link-state",
            browser_secret="separate-link-browser",
            nonce="nonce",
            code_verifier="verifier",
            user_id=user.id,
            bearer_token=token,
        )
        start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LOGIN,
            state="pending-login-state",
            browser_secret="separate-login-browser",
            nonce="nonce",
            code_verifier="verifier",
        )
        claimed = claim_authorization_transaction(
            self.db,
            state="pending-login-state",
            browser_secret="separate-login-browser",
        )
        self.assertIsNotNone(claimed)
        promoted = promote_authorization_to_handoff(
            self.db,
            transaction_id=claimed.id,
            state="pending-login-state",
            browser_secret="separate-login-browser",
            issuer=ISSUER,
            handoff_secret="pending-handoff-secret",
            subject=identity.subject,
        )
        self.assertIsNotNone(promoted)

        response = self.client.post(
            "/api/auth/oidc/unlink",
            json={"current_password": "correct horse", "confirmation": True},
            headers={**bearer, "Origin": APP_ORIGIN},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"linked": False})
        self.assertIsNone(find_user_identity(self.db, user.id, ISSUER))
        self.assertEqual(self.db.query(User).filter_by(id=user.id).one().role, "admin")
        self.assertEqual(
            self.db.query(CollectionItem).filter_by(id=collection_id).one().quantity,
            2,
        )
        self.assertEqual(self.db.query(OidcAuthTransaction).count(), 0)
        self.assert_security_headers(response)

    def test_unlink_requires_json_origin_password_and_confirmation(self):
        user = self.add_user("existing", password="correct horse")
        self.link(user)
        _token, bearer = self.bearer(user)

        cases = [
            ({"Origin": "https://evil.example.test"}, {"current_password": "correct horse", "confirmation": True}, 403),
            ({}, {"current_password": "correct horse", "confirmation": True}, 403),
            ({"Origin": APP_ORIGIN, "Content-Type": "text/plain"}, {"current_password": "correct horse", "confirmation": True}, 415),
            ({"Origin": APP_ORIGIN}, {"current_password": "wrong", "confirmation": True}, 401),
            ({"Origin": APP_ORIGIN}, {"current_password": "correct horse", "confirmation": False}, 400),
        ]
        for extra_headers, payload, expected in cases:
            with self.subTest(payload=payload, extra_headers=extra_headers):
                response = self.client.post(
                    "/api/auth/oidc/unlink",
                    json=payload,
                    headers={**bearer, **extra_headers},
                )
                self.assertEqual(response.status_code, expected)
                self.assertIsNotNone(find_user_identity(self.db, user.id, ISSUER))

    def test_unlink_rejects_passwordless_user_without_mutation(self):
        user = self.add_user("passwordless")
        self.link(user)
        token = create_access_token({"sub": str(user.id), "role": user.role})
        response = self.client.post(
            "/api/auth/oidc/unlink",
            json={"current_password": "anything", "confirmation": True},
            headers={
                "Authorization": f"Bearer {token}",
                "Origin": APP_ORIGIN,
            },
        )
        self.assertEqual(response.status_code, 403)
        self.assertIsNotNone(find_user_identity(self.db, user.id, ISSUER))


if __name__ == "__main__":
    unittest.main()
