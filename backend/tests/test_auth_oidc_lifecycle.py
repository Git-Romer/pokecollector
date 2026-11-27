"""Focused P2 tests for nullable passwords, identity persistence and admin guards.

These run without a provider or a database server. The real PostgreSQL migration,
constraint, cascade and concurrency evidence lives in
``test_auth_oidc_schema_postgres.py``.
"""
import os
import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import sessionmaker

    import database
    from api.auth import (
        ChangePasswordRequest,
        UpdateUserRequest,
        change_password,
        delete_user,
        login,
        update_user,
    )
    from database import Base
    from models import OidcIdentity, User
    from services.auth import (
        has_valid_password_hash,
        hash_password,
        verify_password,
    )
    from services.auth_admin import (
        count_usable_admins,
        initialize_admin_accounts,
        is_usable_admin,
        validate_oidc_only_startup,
    )
    from services.auth_policy import AuthPolicy, OidcConfig

    TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    TEST_DEPS_AVAILABLE = False


PASSWORD = "known-admin-password"
ISSUER = "https://idp.example.test"
OTHER_ISSUER = "https://other-idp.example.test"
CLIENT_SECRET = "synthetic-client-secret"

_ENV_KEYS = (
    "AUTH_MODE",
    "USER_MODE",
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
    "OIDC_DISPLAY_NAME",
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD",
    "ADMIN_BOOTSTRAP_LOG",
    "GEMINI_API_KEY",
)

VALID_OIDC = {
    "OIDC_ISSUER_URL": ISSUER,
    "OIDC_CLIENT_ID": "pokecollector",
    "OIDC_CLIENT_SECRET": CLIENT_SECRET,
    "OIDC_REDIRECT_URI": "https://app.example.test/api/auth/oidc/callback",
}


def env(**overrides):
    values = {key: "" for key in _ENV_KEYS}
    values.update(overrides)
    return patch.dict(os.environ, values, clear=False)


def policy_for(mode):
    if mode == "local":
        return AuthPolicy(auth_mode=mode, oidc=None)
    return AuthPolicy(
        auth_mode=mode,
        oidc=OidcConfig(
            issuer_url=ISSUER,
            client_id="pokecollector",
            client_secret=CLIENT_SECRET,
            redirect_uri="https://app.example.test/api/auth/oidc/callback",
        ),
    )


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class PasswordVerificationSafetyTests(unittest.TestCase):
    def test_absent_or_malformed_hashes_are_false_not_exceptions(self):
        for stored in (None, "", "x", "not-a-bcrypt-hash", "$2b$12$short"):
            with self.subTest(stored=stored):
                self.assertFalse(has_valid_password_hash(stored))
                self.assertFalse(verify_password("anything", stored))

    def test_real_hashes_verify_and_reject_wrong_passwords(self):
        stored = hash_password(PASSWORD)
        self.assertTrue(has_valid_password_hash(stored))
        self.assertTrue(verify_password(PASSWORD, stored))
        self.assertFalse(verify_password("wrong-password", stored))
        self.assertFalse(verify_password("", stored))


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class NullablePasswordLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

        patcher = patch.object(database, "SessionLocal", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _add_user(self, username="sso-user", hashed_password=None, role="trainer"):
        user = User(
            username=username,
            hashed_password=hashed_password,
            role=role,
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def test_passwordless_account_round_trips_and_cannot_password_login(self):
        user = self._add_user()
        self.assertIsNone(user.hashed_password)

        with env(AUTH_MODE="mixed", **VALID_OIDC):
            with self.assertRaises(HTTPException) as exc:
                login(
                    None,
                    type(
                        "Form",
                        (),
                        {"username": user.username, "password": PASSWORD},
                    )(),
                    self.db,
                )
        self.assertEqual(exc.exception.status_code, 401)

    def test_passwordless_account_cannot_change_a_password_without_one(self):
        user = self._add_user()
        with env(AUTH_MODE="mixed", **VALID_OIDC):
            with self.assertRaises(HTTPException) as exc:
                change_password(
                    ChangePasswordRequest(
                        current_password=PASSWORD, new_password="new-password"
                    ),
                    current_user=user,
                    db=self.db,
                )
        self.assertEqual(exc.exception.status_code, 400)
        self.db.refresh(user)
        self.assertIsNone(user.hashed_password)

    def test_oidc_only_blocks_password_change_before_touching_absent_hash(self):
        user = self._add_user()
        with env(AUTH_MODE="oidc-only", **VALID_OIDC):
            with self.assertRaises(HTTPException) as exc:
                change_password(
                    ChangePasswordRequest(
                        current_password="", new_password="new-password"
                    ),
                    current_user=user,
                    db=self.db,
                )
        self.assertEqual(exc.exception.status_code, 403)
        self.db.refresh(user)
        self.assertIsNone(user.hashed_password)


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class UsableAdminGuardTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

        patcher = patch.object(database, "SessionLocal", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _admin(self, username, hashed_password="password-by-default"):
        if hashed_password == "password-by-default":
            hashed_password = hash_password(f"{username}-password")
        user = User(
            username=username,
            hashed_password=hashed_password,
            role="admin",
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def _link(self, user, issuer=ISSUER, subject=None):
        identity = OidcIdentity(
            issuer=issuer,
            subject=subject or f"{user.username}-subject",
            user_id=user.id,
        )
        self.db.add(identity)
        self.db.commit()
        return identity

    def test_usable_admin_definition_follows_policy(self):
        password_admin = self._admin("password-admin")
        sso_admin = self._admin("sso-admin", hashed_password=None)
        self._link(sso_admin)
        broken_admin = self._admin("broken-admin", hashed_password="x")

        self.assertTrue(is_usable_admin(self.db, password_admin, policy_for("local")))
        self.assertFalse(is_usable_admin(self.db, sso_admin, policy_for("local")))
        self.assertFalse(is_usable_admin(self.db, broken_admin, policy_for("local")))

        self.assertTrue(is_usable_admin(self.db, password_admin, policy_for("mixed")))
        self.assertTrue(is_usable_admin(self.db, sso_admin, policy_for("mixed")))
        self.assertFalse(is_usable_admin(self.db, broken_admin, policy_for("mixed")))

        self.assertFalse(
            is_usable_admin(self.db, password_admin, policy_for("oidc-only"))
        )
        self.assertTrue(is_usable_admin(self.db, sso_admin, policy_for("oidc-only")))

    def test_last_usable_admin_cannot_be_demoted_or_deactivated(self):
        admin = self._admin("only-admin")
        with env(AUTH_MODE="local"):
            with self.assertRaises(HTTPException) as demote:
                update_user(
                    admin.id,
                    UpdateUserRequest(role="trainer"),
                    current_user=admin,
                    db=self.db,
                )
            self.assertEqual(demote.exception.status_code, 400)
            with self.assertRaises(HTTPException) as deactivate:
                update_user(
                    admin.id,
                    UpdateUserRequest(is_active=False),
                    current_user=admin,
                    db=self.db,
                )
            self.assertEqual(deactivate.exception.status_code, 400)

        self.db.refresh(admin)
        self.assertEqual(admin.role, "admin")
        self.assertTrue(admin.is_active)

    def test_mixed_mode_allows_demotion_when_another_usable_admin_remains(self):
        first = self._admin("first-admin")
        second = self._admin("second-admin", hashed_password=None)
        self._link(second)

        with env(AUTH_MODE="mixed", **VALID_OIDC):
            result = update_user(
                first.id,
                UpdateUserRequest(role="trainer"),
                current_user=second,
                db=self.db,
            )
        self.assertEqual(result["role"], "trainer")

    def test_mixed_mode_counts_sso_admin_as_a_usable_method(self):
        passwordless = self._admin("passwordless", hashed_password=None)
        self._link(passwordless)
        with env(AUTH_MODE="mixed", **VALID_OIDC):
            self.assertEqual(count_usable_admins(self.db, policy_for("mixed")), 1)
            with self.assertRaises(HTTPException):
                update_user(
                    passwordless.id,
                    UpdateUserRequest(is_active=False),
                    current_user=passwordless,
                    db=self.db,
                )

    def test_delete_user_rejects_removing_the_last_usable_admin(self):
        usable = self._admin("usable-admin")
        caller = self._admin("caller", hashed_password=None)

        with env(AUTH_MODE="local"), patch(
            "services.scan_trace.revoke_user_traces"
        ):
            with self.assertRaises(HTTPException) as exc:
                delete_user(usable.id, current_user=caller, db=self.db)
        self.assertEqual(exc.exception.status_code, 400)
        self.assertIsNotNone(
            self.db.query(User).filter(User.id == usable.id).first()
        )

    def test_delete_user_removes_identity_and_allows_removal_with_another_admin(self):
        target = self._admin("target-admin")
        self._link(target)
        caller = self._admin("caller-admin")

        with env(AUTH_MODE="local"), patch(
            "services.scan_trace.revoke_user_traces"
        ):
            result = delete_user(target.id, current_user=caller, db=self.db)

        self.assertEqual(result, {"message": "User deleted"})
        self.assertIsNone(self.db.query(User).filter(User.id == target.id).first())
        self.assertEqual(
            self.db.query(OidcIdentity)
            .filter(OidcIdentity.user_id == target.id)
            .count(),
            0,
        )

    def test_identity_constraints_are_enforced(self):
        first = self._admin("first")
        second = self._admin("second")
        self._link(first, subject="shared-subject")

        self.db.add(OidcIdentity(issuer=ISSUER, subject="shared-subject", user_id=second.id))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()

        self.db.add(OidcIdentity(issuer=ISSUER, subject="another-subject", user_id=first.id))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()

        # A different issuer is a different identity namespace.
        self.db.add(OidcIdentity(issuer=OTHER_ISSUER, subject="shared-subject", user_id=second.id))
        self.db.add(OidcIdentity(issuer=OTHER_ISSUER, subject="first-other", user_id=first.id))
        self.db.commit()


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class BootstrapAndStartupTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

        patcher = patch.object(database, "SessionLocal", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _admin(self, username="admin", hashed_password="hashed", is_active=True):
        if hashed_password == "hashed":
            hashed_password = hash_password(PASSWORD)
        user = User(
            username=username,
            hashed_password=hashed_password,
            role="admin",
            is_active=is_active,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def _link(self, user, issuer=ISSUER):
        self.db.add(
            OidcIdentity(
                issuer=issuer,
                subject=f"{user.username}-subject",
                user_id=user.id,
            )
        )
        self.db.commit()

    def _bootstrap_env(self):
        return env(
            ADMIN_USERNAME="admin",
            ADMIN_PASSWORD=PASSWORD,
            ADMIN_BOOTSTRAP_LOG="false",
            GEMINI_API_KEY="",
        )

    def test_local_and_mixed_still_bootstrap_a_password_administrator(self):
        for mode, extra in (("local", {}), ("mixed", VALID_OIDC)):
            with self.subTest(mode=mode):
                self.db.query(OidcIdentity).delete()
                self.db.query(User).delete()
                self.db.commit()
                with self._bootstrap_env(), env(AUTH_MODE=mode, **extra):
                    initialize_admin_accounts(self.db, policy_for(mode))
                admin = self.db.query(User).filter(User.role == "admin").one()
                self.assertTrue(has_valid_password_hash(admin.hashed_password))
                self.assertFalse(admin.must_change_password)
                self.assertIsNone(
                    self.db.query(OidcIdentity)
                    .filter(OidcIdentity.user_id == admin.id)
                    .first()
                )

    def test_oidc_only_never_bootstraps_a_password_administrator(self):
        with self._bootstrap_env(), env(AUTH_MODE="oidc-only", **VALID_OIDC):
            with self.assertRaises(RuntimeError) as exc:
                initialize_admin_accounts(self.db, policy_for("oidc-only"))

        self.assertEqual(self.db.query(User).count(), 0)
        message = str(exc.exception)
        self.assertIn("AUTH_MODE=mixed", message)
        self.assertNotIn(CLIENT_SECRET, message)

    def test_oidc_only_requires_an_active_linked_administrator(self):
        unlinked = self._admin("unlinked")
        with env(AUTH_MODE="oidc-only", **VALID_OIDC):
            with self.assertRaises(RuntimeError):
                initialize_admin_accounts(self.db, policy_for("oidc-only"))

        self._link(unlinked)
        with env(AUTH_MODE="oidc-only", **VALID_OIDC):
            initialize_admin_accounts(self.db, policy_for("oidc-only"))

        inactive = self._admin("inactive", is_active=False)
        self._link(inactive)
        # The active linked admin still satisfies startup.
        with env(AUTH_MODE="oidc-only", **VALID_OIDC):
            initialize_admin_accounts(self.db, policy_for("oidc-only"))

    def test_oidc_only_only_accepts_identity_for_the_configured_issuer(self):
        admin = self._admin("admin")
        self._link(admin, issuer=OTHER_ISSUER)
        with env(AUTH_MODE="oidc-only", **VALID_OIDC):
            with self.assertRaises(RuntimeError):
                validate_oidc_only_startup(self.db, policy_for("oidc-only"))

    def test_startup_validation_is_a_noop_outside_oidc_only(self):
        for mode in ("local", "mixed"):
            with self.subTest(mode=mode):
                validate_oidc_only_startup(self.db, policy_for(mode))


if __name__ == "__main__":
    unittest.main()
