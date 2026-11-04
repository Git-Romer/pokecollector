"""Focused P4 tests for OIDC identity provisioning, linking and invalidation.

The suite is deliberately non-concurrent on SQLite: it proves the rollback /
unique-constraint recovery path and SQLite foreign-key cascades. Real
PostgreSQL multi-writer concurrency is exercised by the guarded destructive
suite where a scratch database is available; this file does not claim to
replace it.
"""
import os
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-provisioning-test-secret")

try:
    # Third-party dependencies only; internal import errors below must fail.
    from sqlalchemy import create_engine, event, text
    from sqlalchemy.orm import sessionmaker

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

if DEPS_AVAILABLE:
    import database
    from api.auth import delete_user
    from database import Base
    from models import OidcAuthTransaction, OidcIdentity, User
    from services.auth import hash_password
    from services.oidc_identity import (
        OidcIdentityConflictError,
        OidcProvisioningError,
        find_identity,
        link_identity,
        provision_user_for_identity,
        resolve_identity_user,
        sanitize_username_hint,
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

ISSUER = "https://idp.example.test"
OTHER_ISSUER = "https://other-idp.example.test"
SUBJECT = "provider-subject-1"
BEARER = "initiating-application-bearer"


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class ProvisioningTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")

        @event.listens_for(self.engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

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
        identity = OidcIdentity(issuer=issuer, subject=subject, user_id=user.id)
        self.db.add(identity)
        self.db.commit()
        self.db.refresh(identity)
        return identity


class ProvisionNewUserTests(ProvisioningTestCase):
    def test_provisions_active_trainer_without_password(self):
        user = provision_user_for_identity(
            self.db, issuer=ISSUER, subject=SUBJECT
        )

        self.assertEqual(user.role, "trainer")
        self.assertTrue(user.is_active)
        self.assertIsNone(user.hashed_password)
        self.assertFalse(user.must_change_password)
        identity = find_identity(self.db, ISSUER, SUBJECT)
        self.assertIsNotNone(identity)
        self.assertEqual(identity.user_id, user.id)

    def test_existing_identity_is_resolved_without_creating_another_user(self):
        winner = self.add_user("winner", role="admin")
        self.link(winner)

        resolved = provision_user_for_identity(
            self.db, issuer=ISSUER, subject=SUBJECT
        )

        self.assertEqual(resolved.id, winner.id)
        self.assertEqual(self.db.query(User).count(), 1)

    def test_race_winner_is_resolved_after_candidate_rollback(self):
        """The pre-check can miss a concurrent insert; recovery must not orphan."""
        winner = self.add_user("winner")
        self.link(winner)
        real_find = find_identity
        calls = {"count": 0}

        def miss_the_race_once(db, issuer, subject):
            calls["count"] += 1
            if calls["count"] == 1:
                return None
            return real_find(db, issuer, subject)

        with patch(
            "services.oidc_identity.find_identity", side_effect=miss_the_race_once
        ):
            resolved = provision_user_for_identity(
                self.db, issuer=ISSUER, subject=SUBJECT
            )

        self.assertEqual(resolved.id, winner.id)
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(OidcIdentity).count(), 1)

    def test_never_attaches_to_a_preexisting_username(self):
        existing = self.add_user("ash")

        user = provision_user_for_identity(
            self.db,
            issuer=ISSUER,
            subject=SUBJECT,
            preferred_username="ash",
        )

        self.assertNotEqual(user.id, existing.id)
        self.assertNotEqual(user.username, existing.username)
        self.assertTrue(user.username.startswith("ash-"))
        self.assertEqual(self.db.query(User).count(), 2)

    def test_username_hint_is_sanitized_and_bounded(self):
        self.assertEqual(sanitize_username_hint("  Ash   Ketchum  "), "Ash-Ketchum")
        self.assertEqual(sanitize_username_hint("<script>alert(1)</script>"), "script-alert-1-script")
        self.assertEqual(sanitize_username_hint("x"), "")
        self.assertLessEqual(
            len(sanitize_username_hint("a" * 200)), 24
        )

        user = provision_user_for_identity(
            self.db,
            issuer=ISSUER,
            subject=SUBJECT,
            preferred_username="a" * 200,
        )
        self.assertLessEqual(len(user.username), 32)

    def test_identity_lookup_is_exact_issuer_and_subject_only(self):
        user = provision_user_for_identity(
            self.db, issuer=ISSUER, subject="provider-subject"
        )
        self.assertEqual(
            resolve_identity_user(self.db, ISSUER, "provider-subject").id,
            user.id,
        )
        # Username, email-shaped values and case variants are not lookup keys.
        self.assertIsNone(resolve_identity_user(self.db, ISSUER, user.username))
        self.assertIsNone(
            resolve_identity_user(self.db, ISSUER, "user@example.test")
        )
        self.assertIsNone(
            resolve_identity_user(self.db, ISSUER, "Provider-Subject")
        )
        self.assertIsNone(
            resolve_identity_user(self.db, OTHER_ISSUER, "provider-subject")
        )

    def test_inactive_identity_user_is_returned_as_blocked(self):
        inactive = self.add_user("inactive", is_active=False)
        self.link(inactive)

        resolved = resolve_identity_user(self.db, ISSUER, SUBJECT)
        self.assertIsNotNone(resolved)
        self.assertFalse(resolved.is_active)

    def test_empty_issuer_or_subject_is_rejected(self):
        for issuer, subject in (("", SUBJECT), (ISSUER, "")):
            with self.subTest(issuer=issuer, subject=subject):
                with self.assertRaises(OidcProvisioningError):
                    provision_user_for_identity(
                        self.db, issuer=issuer, subject=subject
                    )


class LinkIdentityTests(ProvisioningTestCase):
    def test_link_preserves_role_and_password(self):
        admin = self.add_user("admin", role="admin", password="local-password")
        original_hash = admin.hashed_password

        identity = link_identity(
            self.db, user_id=admin.id, issuer=ISSUER, subject=SUBJECT
        )

        self.assertEqual(identity.user_id, admin.id)
        self.db.refresh(admin)
        self.assertEqual(admin.role, "admin")
        self.assertEqual(admin.hashed_password, original_hash)

    def test_subject_linked_elsewhere_is_rejected(self):
        first = self.add_user("first")
        second = self.add_user("second")
        self.link(first)

        with self.assertRaises(OidcIdentityConflictError):
            link_identity(
                self.db, user_id=second.id, issuer=ISSUER, subject=SUBJECT
            )
        self.assertIsNone(
            self.db.query(OidcIdentity)
            .filter(OidcIdentity.user_id == second.id)
            .first()
        )

    def test_user_already_linked_for_issuer_is_rejected(self):
        user = self.add_user("linked")
        self.link(user, subject="first-subject")

        with self.assertRaises(OidcIdentityConflictError):
            link_identity(
                self.db, user_id=user.id, issuer=ISSUER, subject="second-subject"
            )
        self.assertEqual(
            self.db.query(OidcIdentity)
            .filter(OidcIdentity.user_id == user.id)
            .count(),
            1,
        )

    def test_different_issuer_is_a_separate_identity_namespace(self):
        user = self.add_user("linked")
        self.link(user, issuer=ISSUER, subject=SUBJECT)

        identity = link_identity(
            self.db, user_id=user.id, issuer=OTHER_ISSUER, subject=SUBJECT
        )
        self.assertEqual(identity.issuer, OTHER_ISSUER)
        self.assertEqual(
            self.db.query(OidcIdentity)
            .filter(OidcIdentity.user_id == user.id)
            .count(),
            2,
        )


class PromotionDeadlineAndHintTests(ProvisioningTestCase):
    BASE = datetime(2026, 11, 4, 12, 0, 0)

    def _promote(self, *, promote_at, claim_at=None, **overrides):
        start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LOGIN,
            state="deadline-state",
            browser_secret="deadline-browser",
            nonce="nonce",
            code_verifier="verifier",
            now=self.BASE,
        )
        claimed = claim_authorization_transaction(
            self.db,
            state="deadline-state",
            browser_secret="deadline-browser",
            now=claim_at or promote_at,
        )
        self.assertIsNotNone(claimed)
        values = {
            "transaction_id": claimed.id,
            "state": "deadline-state",
            "browser_secret": "deadline-browser",
            "issuer": ISSUER,
            "handoff_secret": "deadline-handoff",
            "subject": SUBJECT,
            "auth_time": int(self.BASE.timestamp()),
            "now": promote_at,
        }
        values.update(overrides)
        return promote_authorization_to_handoff(self.db, **values)

    def test_promotion_preserves_issuance_time_and_caps_handoff_deadline(self):
        promoted = self._promote(
            promote_at=self.BASE + timedelta(seconds=30),
            username_hint="Ash Ketchum",
        )

        self.assertIsNotNone(promoted)
        self.assertEqual(promoted.created_at, self.BASE)
        self.assertEqual(
            promoted.expires_at,
            self.BASE + timedelta(seconds=30) + timedelta(seconds=60),
        )
        self.assertLess(promoted.expires_at, self.BASE + TRANSACTION_TTL)
        self.assertEqual(promoted.username_hint, "Ash-Ketchum")

    def test_promotion_near_original_deadline_never_extends_it(self):
        near_end = self.BASE + TRANSACTION_TTL - timedelta(seconds=1)
        promoted = self._promote(promote_at=near_end)

        self.assertIsNotNone(promoted)
        self.assertEqual(promoted.created_at, self.BASE)
        self.assertEqual(promoted.expires_at, self.BASE + TRANSACTION_TTL)

    def test_promotion_bounds_and_sanitizes_the_username_hint(self):
        unusable = self._promote(
            promote_at=self.BASE + timedelta(seconds=1),
            handoff_secret="unusable-handoff",
            username_hint="🔥🔥",
        )
        self.assertIsNone(unusable.username_hint)

        long_hint = self._promote(
            promote_at=self.BASE + timedelta(seconds=1),
            handoff_secret="long-handoff",
            username_hint="A" * 200,
        )
        self.assertIsNotNone(long_hint.username_hint)
        self.assertLessEqual(len(long_hint.username_hint), 24)


class TransactionMigrationTests(unittest.TestCase):
    def test_sqlite_migration_adds_username_hint_and_is_idempotent(self):
        engine = create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE oidc_auth_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation VARCHAR(16) NOT NULL,
                    phase VARCHAR(16) NOT NULL,
                    issuer VARCHAR(1024) NOT NULL,
                    state_digest VARCHAR(64),
                    browser_digest VARCHAR(64) NOT NULL,
                    nonce_ciphertext BLOB,
                    verifier_ciphertext BLOB,
                    subject VARCHAR(255),
                    auth_time INTEGER,
                    user_id INTEGER,
                    bearer_fingerprint VARCHAR(64),
                    handoff_digest VARCHAR(64),
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    consumed_at DATETIME,
                    CONSTRAINT uq_oidc_transaction_state_digest
                        UNIQUE (state_digest),
                    CONSTRAINT uq_oidc_transaction_handoff_digest
                        UNIQUE (handoff_digest),
                    CONSTRAINT ck_oidc_transaction_operation
                        CHECK (operation IN ('login', 'link')),
                    CONSTRAINT ck_oidc_transaction_phase
                        CHECK (phase IN ('authorization', 'handoff'))
                )
            """))

        database.migrate_oidc_transaction_schema(engine)
        database.migrate_oidc_transaction_schema(engine)

        with engine.connect() as conn:
            columns = {
                row[1]
                for row in conn.execute(
                    text("PRAGMA table_info(oidc_auth_transactions)")
                )
            }
        self.assertIn("username_hint", columns)


class DeletionInvalidationTests(ProvisioningTestCase):
    def _login_handoff(self, subject=SUBJECT, browser="login-browser"):
        state = f"login-state-{subject}"
        start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LOGIN,
            state=state,
            browser_secret=browser,
            nonce="nonce",
            code_verifier="verifier",
        )
        claimed = claim_authorization_transaction(
            self.db, state=state, browser_secret=browser
        )
        promoted = promote_authorization_to_handoff(
            self.db,
            transaction_id=claimed.id,
            state=state,
            browser_secret=browser,
            issuer=ISSUER,
            handoff_secret=f"handoff-{subject}",
            subject=subject,
            auth_time=None,
        )
        self.assertEqual(promoted.phase, PHASE_HANDOFF)

    def _link_transaction(self, user):
        start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LINK,
            state="link-state",
            browser_secret="link-browser",
            nonce="nonce",
            code_verifier="verifier",
            user_id=user.id,
            bearer_token=BEARER,
        )

    def test_user_deletion_invalidates_every_transaction_and_identity(self):
        caller = self.add_user("caller", role="admin", password="caller-password")
        target = self.add_user("target")
        self.link(target)
        self._link_transaction(target)
        self._login_handoff()

        with patch("services.scan_trace.revoke_user_traces"):
            result = delete_user(target.id, current_user=caller, db=self.db)

        self.assertEqual(result, {"message": "User deleted"})
        self.assertIsNone(
            self.db.query(User).filter(User.id == target.id).first()
        )
        self.assertEqual(
            self.db.query(OidcIdentity)
            .filter(OidcIdentity.user_id == target.id)
            .count(),
            0,
        )
        self.assertEqual(self.db.query(OidcAuthTransaction).count(), 0)

    def test_foreign_key_cascade_removes_identity_and_user_bound_transaction(self):
        user = self.add_user("cascade")
        self.link(user)
        self._link_transaction(user)

        self.db.delete(user)
        self.db.commit()

        self.assertEqual(
            self.db.query(OidcIdentity)
            .filter(OidcIdentity.user_id == user.id)
            .count(),
            0,
        )
        self.assertEqual(
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.user_id == user.id)
            .count(),
            0,
        )


if __name__ == "__main__":
    unittest.main()
