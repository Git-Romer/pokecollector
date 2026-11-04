"""Focused tests for AUTH_MODE policy, OIDC configuration and endpoint gates.

Covers the approved truth table for local / mixed / oidc-only deployments:
environment parsing, startup syntax validation, capability payloads, implicit
access and password gates. No provider network, database server or real
credentials are used.
"""
import asyncio
import json
import os
import unittest
from unittest.mock import patch

try:
    # Third-party dependencies only: a missing package may skip the suite, but
    # internal module import errors below must fail loudly instead of skipping.
    from fastapi import HTTPException
    from fastapi.security import OAuth2PasswordRequestForm
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False

if API_TEST_DEPS_AVAILABLE:
    import database
    from api.auth import (
        ChangePasswordRequest,
        CreateUserRequest,
        ForceChangePasswordRequest,
        UpdateUserRequest,
        change_password,
        create_user,
        force_change_password,
        get_auth_mode,
        get_current_user,
        login,
        multi_user_enabled,
        set_auth_mode,
        update_user,
    )
    from database import Base, get_setting, save_setting
    from models import User
    from services.auth import create_access_token, hash_password, verify_password
    from services.auth_policy import (
        AUTH_MODE_LOCAL,
        AUTH_MODE_MIXED,
        AUTH_MODE_OIDC_ONLY,
        AuthConfigError,
        load_auth_policy,
        resolve_auth_mode,
        validate_startup_auth_config,
    )

_PROJECT_PACKAGES = frozenset({"api", "database", "models", "schemas", "scripts", "services"})

MAIN_AVAILABLE = False
if API_TEST_DEPS_AVAILABLE:
    try:
        import main as main_module

        MAIN_AVAILABLE = True
    except ModuleNotFoundError as exc:
        # A missing project module is an internal import error, not a dependency skip.
        if (exc.name or "").split(".")[0] in _PROJECT_PACKAGES:
            raise
        MAIN_AVAILABLE = False


PASSWORD = "known-admin-password"
CLIENT_SECRET = "synthetic-client-secret"

_ENV_KEYS = (
    "AUTH_MODE",
    "USER_MODE",
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
    "OIDC_DISPLAY_NAME",
)

VALID_OIDC = {
    "OIDC_ISSUER_URL": "https://idp.example.test",
    "OIDC_CLIENT_ID": "pokecollector",
    "OIDC_CLIENT_SECRET": CLIENT_SECRET,
    "OIDC_REDIRECT_URI": "https://app.example.test/api/auth/oidc/callback",
}


def env(**overrides):
    """Patch the full authentication environment; blank values mean "not set"."""
    values = {key: "" for key in _ENV_KEYS}
    values.update(overrides)
    return patch.dict(os.environ, values, clear=False)


def oidc_env(mode, **overrides):
    values = dict(VALID_OIDC)
    values.update(overrides)
    return env(AUTH_MODE=mode, **values)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class AuthModeConfigTests(unittest.TestCase):
    def test_unset_or_blank_auth_mode_defaults_to_local(self):
        with env(AUTH_MODE=""):
            self.assertEqual(resolve_auth_mode(), AUTH_MODE_LOCAL)
            self.assertEqual(resolve_auth_mode(None), AUTH_MODE_LOCAL)
            policy = load_auth_policy()

        self.assertEqual(policy.auth_mode, AUTH_MODE_LOCAL)
        self.assertFalse(policy.authentication_required)
        self.assertFalse(policy.oidc_enabled)
        self.assertTrue(policy.password_login_enabled)
        self.assertFalse(policy.mode_locked)
        self.assertIsNone(policy.oidc_display_name)

    def test_local_mode_ignores_stray_or_invalid_oidc_configuration(self):
        with env(
            AUTH_MODE="local",
            OIDC_ISSUER_URL="not an absolute url",
            OIDC_CLIENT_ID="",
            OIDC_CLIENT_SECRET="",
            OIDC_REDIRECT_URI="/relative",
            OIDC_DISPLAY_NAME="Should be ignored",
        ):
            policy = load_auth_policy()

        self.assertFalse(policy.oidc_enabled)
        self.assertIsNone(policy.oidc)
        self.assertIsNone(policy.oidc_display_name)
        self.assertEqual(policy.capabilities(multi_user=False, locked=False)["auth_mode"], "local")

    def test_unknown_nonblank_auth_modes_fail(self):
        for value in ("saml", "oidc", "single", "off", "true", "locale"):
            with self.subTest(value=value), env(AUTH_MODE=value):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn("AUTH_MODE", str(exc.exception))

    def test_auth_mode_is_trimmed_and_case_insensitive(self):
        with oidc_env(" MIXED "):
            self.assertEqual(load_auth_policy().auth_mode, AUTH_MODE_MIXED)
        with oidc_env("OIDC-ONLY"):
            self.assertEqual(load_auth_policy().auth_mode, AUTH_MODE_OIDC_ONLY)
        with env(AUTH_MODE="  LOCAL  "):
            self.assertEqual(load_auth_policy().auth_mode, AUTH_MODE_LOCAL)

    def test_oidc_modes_require_each_oidc_setting(self):
        required = (
            "OIDC_ISSUER_URL",
            "OIDC_CLIENT_ID",
            "OIDC_CLIENT_SECRET",
            "OIDC_REDIRECT_URI",
        )
        for mode in (AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY):
            for key in required:
                values = dict(VALID_OIDC)
                values[key] = ""
                with self.subTest(mode=mode, key=key), env(AUTH_MODE=mode, **values):
                    with self.assertRaises(AuthConfigError) as exc:
                        load_auth_policy()
                    self.assertIn(key, str(exc.exception))

    def test_invalid_issuer_urls_are_rejected(self):
        invalid = (
            "idp.example.test",
            "ftp://idp.example.test",
            "https://user:secret@idp.example.test",
            "https://idp.example.test/?x=1",
            "https://idp.example.test/#fragment",
            "http://idp.example.test",
            "https://idp.example.test:notaport",
            "https://idp.example.test/path with space",
        )
        for issuer in invalid:
            with self.subTest(issuer=issuer), oidc_env(
                AUTH_MODE_MIXED, OIDC_ISSUER_URL=issuer
            ):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn("OIDC_ISSUER_URL", str(exc.exception))
                self.assertNotIn("secret", str(exc.exception))

    def test_loopback_http_issuer_is_allowed_for_development(self):
        for issuer in (
            "http://localhost:9091",
            "http://127.0.0.1:9091",
            "http://[::1]:9091",
        ):
            with self.subTest(issuer=issuer), oidc_env(
                AUTH_MODE_MIXED, OIDC_ISSUER_URL=issuer
            ):
                self.assertEqual(load_auth_policy().oidc.issuer_url, issuer)

    def test_redirect_uri_must_be_the_exact_callback_path(self):
        invalid = (
            "https://app.example.test/auth/oidc/callback",
            "https://app.example.test/api/auth/oidc/callback/",
            "https://app.example.test/",
            "https://app.example.test/api/auth/oidc/callback?next=/",
            "https://app.example.test/api/auth/oidc/callback#done",
            "https://user:pass@app.example.test/api/auth/oidc/callback",
            "http://app.example.test/api/auth/oidc/callback",
            "/api/auth/oidc/callback",
        )
        for redirect in invalid:
            with self.subTest(redirect=redirect), oidc_env(
                AUTH_MODE_MIXED, OIDC_REDIRECT_URI=redirect
            ):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn("OIDC_REDIRECT_URI", str(exc.exception))

    def test_redirect_uri_loopback_http_is_allowed(self):
        with oidc_env(
            AUTH_MODE_MIXED,
            OIDC_REDIRECT_URI="http://localhost:5173/api/auth/oidc/callback",
        ):
            self.assertEqual(
                load_auth_policy().oidc.app_origin, "http://localhost:5173"
            )

    def test_client_credentials_must_be_nonblank(self):
        for key in ("OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            values = dict(VALID_OIDC)
            values[key] = "   "
            with self.subTest(key=key), env(AUTH_MODE=AUTH_MODE_OIDC_ONLY, **values):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn(key, str(exc.exception))

    def test_app_origin_ignores_default_ports_and_normalises_host(self):
        with oidc_env(
            AUTH_MODE_MIXED,
            OIDC_REDIRECT_URI="https://APP.Example.Test:443/api/auth/oidc/callback",
        ):
            self.assertEqual(load_auth_policy().oidc.app_origin, "https://app.example.test")
        with oidc_env(
            AUTH_MODE_MIXED,
            OIDC_REDIRECT_URI="https://app.example.test:8443/api/auth/oidc/callback",
        ):
            self.assertEqual(
                load_auth_policy().oidc.app_origin, "https://app.example.test:8443"
            )

    def test_app_origin_preserves_bracketed_ipv6_and_default_ports(self):
        cases = {
            "http://[::1]:5173/api/auth/oidc/callback": "http://[::1]:5173",
            "https://[::1]/api/auth/oidc/callback": "https://[::1]",
            "https://[::1]:443/api/auth/oidc/callback": "https://[::1]",
            "https://[::1]:8443/api/auth/oidc/callback": "https://[::1]:8443",
        }
        for redirect, expected in cases.items():
            with self.subTest(redirect=redirect), oidc_env(
                AUTH_MODE_MIXED, OIDC_REDIRECT_URI=redirect
            ):
                self.assertEqual(load_auth_policy().oidc.app_origin, expected)

    def test_urls_require_a_hostname(self):
        invalid = (
            "https://:443",
            "https://",
            "https:///path",
            "http://:80",
            "https://user@:443/path",
        )
        for value in invalid:
            with self.subTest(value=value), oidc_env(
                AUTH_MODE_MIXED, OIDC_ISSUER_URL=value
            ):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn("OIDC_ISSUER_URL", str(exc.exception))
                self.assertNotIn(value, str(exc.exception))

    def test_malformed_ipv6_and_brackets_are_rejected(self):
        invalid = (
            "https://[::1/api/auth/oidc/callback",
            "https://[]/api/auth/oidc/callback",
            "http://::1/api/auth/oidc/callback",
            "https://[::1]:bad/api/auth/oidc/callback",
        )
        for value in invalid:
            with self.subTest(value=value), oidc_env(
                AUTH_MODE_MIXED, OIDC_ISSUER_URL=value
            ):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn("OIDC_ISSUER_URL", str(exc.exception))
                self.assertNotIn(value, str(exc.exception))

    def test_empty_or_zero_ports_are_rejected(self):
        cases = (
            ("OIDC_ISSUER_URL", "https://idp.example.test:0"),
            ("OIDC_ISSUER_URL", "https://idp.example.test:"),
            ("OIDC_REDIRECT_URI", "https://app.example.test:0/api/auth/oidc/callback"),
            ("OIDC_REDIRECT_URI", "https://app.example.test:/api/auth/oidc/callback"),
        )
        for key, value in cases:
            values = dict(VALID_OIDC)
            values[key] = value
            with self.subTest(key=key, value=value), env(AUTH_MODE=AUTH_MODE_MIXED, **values):
                with self.assertRaises(AuthConfigError) as exc:
                    load_auth_policy()
                self.assertIn(key, str(exc.exception))
                self.assertNotIn(value, str(exc.exception))

    def test_display_name_defaults_and_override(self):
        with oidc_env(AUTH_MODE_MIXED):
            self.assertEqual(load_auth_policy().oidc_display_name, "Single sign-on")
        with oidc_env(AUTH_MODE_MIXED, OIDC_DISPLAY_NAME="   "):
            self.assertEqual(load_auth_policy().oidc_display_name, "Single sign-on")
        with oidc_env(AUTH_MODE_MIXED, OIDC_DISPLAY_NAME="Authelia"):
            self.assertEqual(load_auth_policy().oidc_display_name, "Authelia")

    def test_user_mode_single_conflicts_with_oidc_modes(self):
        for mode in (AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY):
            with self.subTest(mode=mode), oidc_env(mode, USER_MODE="single"):
                with self.assertRaises(AuthConfigError) as exc:
                    validate_startup_auth_config(user_mode="single")
                self.assertIn("USER_MODE=single", str(exc.exception))
                self.assertIn(mode, str(exc.exception))

    def test_user_mode_multi_or_unset_is_allowed_with_oidc_modes(self):
        for mode in (AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY):
            for user_mode in ("multi", None):
                with self.subTest(mode=mode, user_mode=user_mode), oidc_env(
                    mode, USER_MODE=user_mode or ""
                ):
                    policy = validate_startup_auth_config(user_mode=user_mode)
                    self.assertEqual(policy.auth_mode, mode)

    def test_local_mode_still_allows_user_mode_single_recovery(self):
        with env(AUTH_MODE="local", USER_MODE="single"):
            policy = validate_startup_auth_config(user_mode="single")
        self.assertEqual(policy.auth_mode, AUTH_MODE_LOCAL)

    def test_capability_payload_contains_only_safe_fields(self):
        with oidc_env(AUTH_MODE_OIDC_ONLY):
            policy = load_auth_policy()

        caps = policy.capabilities(multi_user=False, locked=False)
        self.assertEqual(
            set(caps),
            {
                "multi_user",
                "locked",
                "auth_mode",
                "password_login_enabled",
                "oidc_enabled",
                "oidc_display_name",
            },
        )
        # OIDC-enabled modes force the login and lock the mode.
        self.assertTrue(caps["multi_user"])
        self.assertTrue(caps["locked"])
        self.assertEqual(caps["auth_mode"], AUTH_MODE_OIDC_ONLY)
        self.assertFalse(caps["password_login_enabled"])
        self.assertTrue(caps["oidc_enabled"])
        self.assertNotIn(CLIENT_SECRET, json.dumps(caps))
        self.assertNotIn(CLIENT_SECRET, repr(policy))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class AuthModeEnforcementTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

        patcher = patch.object(database, "SessionLocal", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.admin = User(
            username="admin",
            hashed_password=hash_password(PASSWORD),
            role="admin",
            is_active=True,
        )
        self.db.add(self.admin)
        self.db.commit()
        self.db.refresh(self.admin)

    def _form(self, username="admin", password=PASSWORD):
        return OAuth2PasswordRequestForm(username=username, password=password)

    def _set_user_count(self, count):
        self.db.query(User).delete()
        self.db.commit()
        for index in range(count):
            self.db.add(
                User(
                    username=f"user{index}",
                    hashed_password=hash_password("x"),
                    role="admin" if index == 0 else "trainer",
                    is_active=True,
                )
            )
        self.db.commit()

    # --- local mode preserves legacy behaviour -------------------------------

    def test_local_defaults_are_unchanged(self):
        with env(AUTH_MODE="local"):
            self.assertFalse(multi_user_enabled(self.db))
            self.assertEqual(get_current_user(token=None, db=self.db).id, self.admin.id)
            caps = get_auth_mode(db=self.db)
            self.assertEqual(
                caps,
                {
                    "multi_user": False,
                    "locked": False,
                    "auth_mode": "local",
                    "password_login_enabled": True,
                    "oidc_enabled": False,
                    "oidc_display_name": None,
                },
            )
            token = login(None, self._form(), self.db)
            self.assertTrue(token.access_token)
            self.assertEqual(token.user["id"], self.admin.id)
            self.assertTrue(set_auth_mode(enabled=True, db=self.db, current_user=self.admin)["multi_user"])
            self.assertTrue(get_auth_mode(db=self.db)["multi_user"])

    def test_local_user_count_fallback_and_stored_setting_are_unchanged(self):
        with env(AUTH_MODE="local"):
            self.assertFalse(multi_user_enabled(self.db))
            self.db.add(
                User(
                    username="misty",
                    hashed_password=hash_password("x"),
                    role="trainer",
                    is_active=True,
                )
            )
            self.db.commit()
            self.assertTrue(multi_user_enabled(self.db))

            save_setting("multi_user_mode", "false")
            self.assertFalse(multi_user_enabled(self.db))
            save_setting("multi_user_mode", "true")
            self.assertTrue(multi_user_enabled(self.db))

    def test_local_mode_ignores_stray_oidc_configuration_end_to_end(self):
        with env(
            AUTH_MODE="local",
            OIDC_ISSUER_URL="http://insecure.example.test",
            OIDC_CLIENT_ID="x",
            OIDC_CLIENT_SECRET="y",
        ):
            caps = get_auth_mode(db=self.db)
            self.assertEqual(caps["auth_mode"], "local")
            self.assertFalse(caps["oidc_enabled"])
            self.assertTrue(login(None, self._form(), self.db).access_token)

    # --- oidc-enabled modes force authentication -----------------------------

    def test_oidc_modes_force_login_regardless_of_users_and_stored_setting(self):
        for mode in (AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY):
            for count in (0, 1, 2):
                with self.subTest(mode=mode, users=count):
                    self._set_user_count(count)
                    save_setting("multi_user_mode", "false")
                    with oidc_env(mode):
                        self.assertTrue(multi_user_enabled(self.db))
                        caps = get_auth_mode(db=self.db)
                        self.assertTrue(caps["multi_user"])
                        self.assertTrue(caps["locked"])
                        self.assertEqual(caps["auth_mode"], mode)
                        self.assertTrue(caps["oidc_enabled"])
                        self.assertEqual(
                            caps["password_login_enabled"], mode == AUTH_MODE_MIXED
                        )
                        with self.assertRaises(HTTPException) as exc:
                            get_current_user(token=None, db=self.db)
                        self.assertEqual(exc.exception.status_code, 401)

    def test_user_mode_single_cannot_restore_implicit_admin_at_runtime(self):
        # Startup rejects USER_MODE=single with an OIDC mode, but the request path
        # must also fail closed if the process was started anyway.
        for mode in (AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY):
            with self.subTest(mode=mode), oidc_env(mode, USER_MODE="single"):
                self.assertTrue(multi_user_enabled(self.db))
                with self.assertRaises(HTTPException) as exc:
                    get_current_user(token=None, db=self.db)
                self.assertEqual(exc.exception.status_code, 401)

    def test_mode_toggle_is_blocked_in_oidc_modes(self):
        for mode in (AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY):
            with self.subTest(mode=mode):
                save_setting("multi_user_mode", "false")
                with oidc_env(mode):
                    with self.assertRaises(HTTPException) as exc:
                        set_auth_mode(enabled=True, db=self.db, current_user=self.admin)
                    self.assertEqual(exc.exception.status_code, 409)
                    self.assertIn(f"AUTH_MODE={mode}", exc.exception.detail)
                    with self.assertRaises(HTTPException):
                        set_auth_mode(enabled=False, db=self.db, current_user=self.admin)
                self.assertEqual(get_setting("multi_user_mode"), "false")

    # --- password login / password management gates --------------------------

    def test_mixed_mode_keeps_password_login_and_change(self):
        with oidc_env(AUTH_MODE_MIXED):
            token = login(None, self._form(), self.db)
            self.assertEqual(token.user["id"], self.admin.id)
            with self.assertRaises(HTTPException) as wrong:
                login(None, self._form(password="wrong-password"), self.db)
            self.assertEqual(wrong.exception.status_code, 401)

            result = change_password(
                ChangePasswordRequest(
                    current_password=PASSWORD, new_password="brand-new-password"
                ),
                current_user=self.admin,
                db=self.db,
            )
            self.assertEqual(result, {"message": "Password changed"})
            self.db.refresh(self.admin)
            self.assertTrue(verify_password("brand-new-password", self.admin.hashed_password))

    def test_oidc_only_rejects_password_login_even_with_valid_credentials(self):
        with oidc_env(AUTH_MODE_OIDC_ONLY):
            for password in (PASSWORD, "wrong-password"):
                with self.subTest(password=password):
                    with self.assertRaises(HTTPException) as exc:
                        login(None, self._form(password=password), self.db)
                    self.assertEqual(exc.exception.status_code, 403)
                    self.assertIn("single sign-on", exc.exception.detail)

    def test_oidc_only_blocks_http_password_mutations(self):
        with oidc_env(AUTH_MODE_OIDC_ONLY):
            original_hash = self.admin.hashed_password

            with self.assertRaises(HTTPException) as exc:
                change_password(
                    ChangePasswordRequest(
                        current_password=PASSWORD, new_password="brand-new-password"
                    ),
                    current_user=self.admin,
                    db=self.db,
                )
            self.assertEqual(exc.exception.status_code, 403)
            self.db.refresh(self.admin)
            self.assertEqual(self.admin.hashed_password, original_hash)

            self.admin.must_change_password = True
            self.db.commit()
            with self.assertRaises(HTTPException) as forced:
                force_change_password(
                    ForceChangePasswordRequest(new_password="brand-new-password"),
                    current_user=self.admin,
                    db=self.db,
                )
            self.assertEqual(forced.exception.status_code, 403)
            self.db.refresh(self.admin)
            self.assertTrue(self.admin.must_change_password)
            self.assertEqual(self.admin.hashed_password, original_hash)

            with self.assertRaises(HTTPException) as admin_set:
                update_user(
                    self.admin.id,
                    UpdateUserRequest(password="brand-new-password"),
                    current_user=self.admin,
                    db=self.db,
                )
            self.assertEqual(admin_set.exception.status_code, 403)
            self.db.refresh(self.admin)
            self.assertEqual(self.admin.hashed_password, original_hash)

    def test_oidc_only_blocks_password_account_creation(self):
        request = CreateUserRequest(username="misty", password="synthetic-password")
        with oidc_env(AUTH_MODE_OIDC_ONLY):
            with self.assertRaises(HTTPException) as exc:
                create_user(request, current_user=self.admin, db=self.db)
        self.assertEqual(exc.exception.status_code, 403)
        self.assertIsNone(self.db.query(User).filter(User.username == "misty").first())

    def test_mixed_mode_still_allows_password_account_creation(self):
        request = CreateUserRequest(username="misty", password="synthetic-password")
        with oidc_env(AUTH_MODE_MIXED):
            created = create_user(request, current_user=self.admin, db=self.db)
        self.assertEqual(created["username"], "misty")

    def test_oidc_only_does_not_revoke_existing_application_jwts(self):
        # Authentication-method policy only: previously issued app JWTs remain
        # valid until expiry or user deactivation.
        token = create_access_token({"sub": str(self.admin.id), "role": "admin"})
        with oidc_env(AUTH_MODE_OIDC_ONLY):
            resolved = get_current_user(token=token, db=self.db)
        self.assertEqual(resolved.id, self.admin.id)

    def test_oidc_only_still_allows_non_password_admin_edits(self):
        with oidc_env(AUTH_MODE_OIDC_ONLY):
            result = update_user(
                self.admin.id,
                UpdateUserRequest(username="owner"),
                current_user=self.admin,
                db=self.db,
            )
        self.assertEqual(result["username"], "owner")

    # --- misconfiguration fails closed ---------------------------------------

    def test_invalid_configuration_fails_closed_in_request_path(self):
        with env(AUTH_MODE=AUTH_MODE_MIXED):  # no OIDC client configured
            calls = (
                lambda: multi_user_enabled(self.db),
                lambda: get_auth_mode(db=self.db),
                lambda: get_current_user(token=None, db=self.db),
                lambda: login(None, self._form(), self.db),
            )
            for call in calls:
                with self.assertRaises(HTTPException) as exc:
                    call()
                self.assertEqual(exc.exception.status_code, 503)
                self.assertEqual(exc.exception.detail, "Authentication is misconfigured")


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE and MAIN_AVAILABLE,
    "Backend dependencies or application module are not available",
)
class StartupAuthValidationTests(unittest.TestCase):
    def _enter_lifespan(self):
        async def run():
            async with main_module.lifespan(main_module.app):
                pass

        return asyncio.run(run())

    def test_invalid_auth_mode_aborts_before_database_mutation(self):
        with (
            env(AUTH_MODE="saml"),
            patch("database.init_db") as init_db,
            patch("services.pre_upgrade_backup.maybe_create_pre_upgrade_backup") as backup,
        ):
            with self.assertRaises(RuntimeError) as exc:
                self._enter_lifespan()

        init_db.assert_not_called()
        backup.assert_not_called()
        self.assertIn("AUTH_MODE", str(exc.exception))
        self.assertNotIn(CLIENT_SECRET, str(exc.exception))

    def test_user_mode_single_with_mixed_aborts_before_database_mutation(self):
        with (
            oidc_env(AUTH_MODE_MIXED, USER_MODE="single"),
            patch("database.init_db") as init_db,
            patch("services.pre_upgrade_backup.maybe_create_pre_upgrade_backup") as backup,
        ):
            with self.assertRaises(RuntimeError) as exc:
                self._enter_lifespan()

        init_db.assert_not_called()
        backup.assert_not_called()
        self.assertIn("USER_MODE=single", str(exc.exception))

    def test_missing_oidc_configuration_aborts_before_database_mutation(self):
        with (
            env(AUTH_MODE=AUTH_MODE_OIDC_ONLY),
            patch("database.init_db") as init_db,
            patch("services.pre_upgrade_backup.maybe_create_pre_upgrade_backup") as backup,
        ):
            with self.assertRaises(RuntimeError) as exc:
                self._enter_lifespan()

        init_db.assert_not_called()
        backup.assert_not_called()
        self.assertIn("OIDC_ISSUER_URL", str(exc.exception))


if __name__ == "__main__":
    unittest.main()
