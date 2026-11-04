"""Focused P3 tests for database-backed OIDC transactions (SQLite).

These prove digest-only storage, AEAD encryption/tamper/rotation fail-closed
behaviour, expiry, browser/operation/user/bearer binding, atomic one-use claims
and bounded cleanup. They are deliberately non-concurrent: SQLite cannot prove
PostgreSQL ``FOR UPDATE``/row-lock semantics, so concurrency remains a P4/S4
PostgreSQL test responsibility.
"""
import os
import secrets
import unittest
from datetime import datetime, timedelta

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-transaction-test-secret")

try:
    # Third-party dependencies only; internal import errors below must fail loudly.
    from cryptography.exceptions import InvalidTag  # noqa: F401
    from sqlalchemy import create_engine, event, text
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import sessionmaker

    TRANSACTION_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    TRANSACTION_DEPS_AVAILABLE = False

if TRANSACTION_DEPS_AVAILABLE:
    import database
    from database import Base
    from models import OidcAuthTransaction, User
    from services.oidc_crypto import (
        TRANSACTION_CONTEXT_INFO,
        TransactionCryptoError,
        decrypt_transaction_secret,
        encrypt_transaction_secret,
    )
    from services.oidc_transactions import (
        HANDOFF_TTL,
        OPERATION_LINK,
        OPERATION_LOGIN,
        PHASE_AUTHORIZATION,
        PHASE_HANDOFF,
        TRANSACTION_TTL,
        OidcTransactionError,
        bearer_token_fingerprint,
        claim_authorization_transaction,
        claim_handoff_transaction,
        decrypted_code_verifier,
        decrypted_nonce,
        generate_transaction_secret,
        invalidate_identity_transactions,
        invalidate_user_transactions,
        promote_authorization_to_handoff,
        purge_expired_transactions,
        start_transaction,
    )

ISSUER = "https://idp.example.test"
STATE = "state-secret-value"
BROWSER = "browser-binding-secret"
NONCE = "provider-nonce-value"
VERIFIER = "pkce-code-verifier-secret"
BEARER = "initiating-app-bearer-token"
SUBJECT = "provider-subject-1"
HANDOFF = "handoff-secret-value"
BASE = datetime(2026, 11, 4, 12, 0, 0)


@unittest.skipUnless(TRANSACTION_DEPS_AVAILABLE, "OIDC transaction dependencies are not installed")
class TransactionTestCase(unittest.TestCase):
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

    def add_user(self, username="trainer"):
        user = User(
            username=username,
            hashed_password=None,
            role="trainer",
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def start(self, **overrides):
        values = {
            "issuer": ISSUER,
            "operation": OPERATION_LOGIN,
            "state": STATE,
            "browser_secret": BROWSER,
            "nonce": NONCE,
            "code_verifier": VERIFIER,
            "now": BASE,
        }
        values.update(overrides)
        transaction = start_transaction(self.db, **values)
        self.db.commit()
        return transaction

    def handoff(
        self,
        *,
        issuer=ISSUER,
        operation=OPERATION_LOGIN,
        browser_secret=BROWSER,
        handoff_secret=HANDOFF,
        subject=SUBJECT,
        auth_time=None,
        user_id=None,
        bearer_token=None,
        now=BASE,
    ):
        """Start and claim an authorization, then promote it to a handoff."""
        state = f"state-{secrets.token_hex(8)}"
        self.start(
            issuer=issuer,
            operation=operation,
            state=state,
            browser_secret=browser_secret,
            nonce=NONCE,
            code_verifier=VERIFIER,
            user_id=user_id,
            bearer_token=bearer_token,
            now=now,
        )
        claimed = claim_authorization_transaction(
            self.db, state=state, browser_secret=browser_secret, now=now
        )
        self.assertIsNotNone(claimed)
        promoted = promote_authorization_to_handoff(
            self.db,
            transaction_id=claimed.id,
            state=state,
            browser_secret=browser_secret,
            issuer=issuer,
            handoff_secret=handoff_secret,
            subject=subject,
            auth_time=(
                int(BASE.timestamp()) if auth_time is None else auth_time
            ),
            now=now,
        )
        self.assertIsNotNone(promoted)
        return promoted


@unittest.skipUnless(TRANSACTION_DEPS_AVAILABLE, "OIDC transaction dependencies are not installed")
class StorageEncryptionTests(TransactionTestCase):
    def test_transaction_stores_only_digests_and_ciphertext(self):
        transaction = self.start()

        self.assertNotEqual(transaction.state_digest, STATE)
        self.assertNotIn(STATE, transaction.state_digest)
        self.assertNotEqual(transaction.browser_digest, BROWSER)
        self.assertNotIn(BROWSER, transaction.browser_digest)
        self.assertNotIn(NONCE.encode(), transaction.nonce_ciphertext)
        self.assertNotIn(VERIFIER.encode(), transaction.verifier_ciphertext)
        self.assertNotIn(NONCE, repr(transaction.nonce_ciphertext))
        self.assertNotIn(VERIFIER, repr(transaction.verifier_ciphertext))

        self.assertEqual(decrypted_nonce(transaction), NONCE)
        self.assertEqual(decrypted_code_verifier(transaction), VERIFIER)

    def test_raw_row_contains_no_secret_plaintext(self):
        self.start()
        row = self.db.execute(text(
            "SELECT operation, phase, issuer, state_digest, browser_digest, "
            "nonce_ciphertext, verifier_ciphertext, subject, bearer_fingerprint, "
            "handoff_digest FROM oidc_auth_transactions"
        )).one()
        secrets = (STATE, BROWSER, NONCE, VERIFIER, HANDOFF)
        for value in row:
            if isinstance(value, bytes):
                for secret in secrets:
                    self.assertNotIn(secret.encode(), value)
            elif isinstance(value, str):
                for secret in secrets:
                    self.assertNotIn(secret, value)

    def test_tampered_ciphertext_fails_closed(self):
        transaction = self.start()
        tampered = bytearray(transaction.nonce_ciphertext)
        tampered[-1] ^= 0xFF
        transaction.nonce_ciphertext = bytes(tampered)
        self.db.commit()

        with self.assertRaises(OidcTransactionError):
            decrypted_nonce(transaction)

    def test_wrong_key_or_rotation_fails_closed(self):
        ciphertext = encrypt_transaction_secret(NONCE, secret_key="key-a")
        self.assertEqual(
            decrypt_transaction_secret(ciphertext, secret_key="key-a"), NONCE
        )
        with self.assertRaises(TransactionCryptoError):
            decrypt_transaction_secret(ciphertext, secret_key="key-b")

    def test_hkdf_context_matches_the_frozen_contract(self):
        self.assertEqual(
            TRANSACTION_CONTEXT_INFO, b"pokecollector-oidc-transaction-v1"
        )

    def test_digests_are_deterministic_but_not_reversible(self):
        first = bearer_token_fingerprint(BEARER)
        second = bearer_token_fingerprint(BEARER)
        self.assertEqual(first, second)
        self.assertNotEqual(first, BEARER)
        self.assertEqual(len(first), 64)

    def test_expiry_windows_are_five_minutes_and_one_minute(self):
        authorization = self.start()
        self.assertEqual(
            authorization.expires_at - authorization.created_at,
            TRANSACTION_TTL,
        )
        handoff = self.handoff()
        self.assertEqual(handoff.expires_at - handoff.created_at, HANDOFF_TTL)

    def test_operation_and_phase_checks_are_enforced(self):
        for field, value in (("operation", "other"), ("phase", "other")):
            with self.subTest(field=field):
                transaction = OidcAuthTransaction(
                    operation="login",
                    phase="authorization",
                    issuer=ISSUER,
                    browser_digest="a" * 64,
                    expires_at=BASE + timedelta(minutes=5),
                )
                setattr(transaction, field, value)
                self.db.add(transaction)
                with self.assertRaises(IntegrityError):
                    self.db.commit()
                self.db.rollback()


@unittest.skipUnless(TRANSACTION_DEPS_AVAILABLE, "OIDC transaction dependencies are not installed")
class FlowLifecycleTests(TransactionTestCase):
    def test_one_active_flow_per_browser(self):
        self.start(state="first-state")
        second = self.start(state="second-state")
        other = self.start(state="third-state", browser_secret="other-browser")

        same_browser = (
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.browser_digest == second.browser_digest)
            .all()
        )
        self.assertEqual(len(same_browser), 1)
        self.assertEqual(same_browser[0].state_digest, second.state_digest)

        other_browser = (
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.browser_digest == other.browser_digest)
            .all()
        )
        self.assertEqual(len(other_browser), 1)
        self.assertEqual(other_browser[0].state_digest, other.state_digest)

    def test_new_start_invalidates_claimed_authorization(self):
        self.start()
        claimed = claim_authorization_transaction(
            self.db, state=STATE, browser_secret=BROWSER, now=BASE
        )
        self.assertIsNotNone(claimed)

        replacement = self.start(state="replacement-state")

        # The stale callback can no longer promote the claimed row.
        self.assertIsNone(
            promote_authorization_to_handoff(
                self.db,
                transaction_id=claimed.id,
                state=STATE,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret=HANDOFF,
                subject=SUBJECT,
                auth_time=int(BASE.timestamp()),
                now=BASE,
            )
        )
        rows = self.db.query(OidcAuthTransaction).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].id, replacement.id)
        self.assertEqual(rows[0].phase, PHASE_AUTHORIZATION)

    def test_new_start_invalidates_previous_pending_handoff(self):
        self.start()
        self.handoff()
        self.start(state="fresh-state")
        pending = (
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.consumed_at.is_(None))
            .all()
        )
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].phase, PHASE_AUTHORIZATION)

    def test_authorization_claim_is_one_use(self):
        self.start()
        first = claim_authorization_transaction(
            self.db, state=STATE, browser_secret=BROWSER, now=BASE
        )
        self.assertIsNotNone(first)
        self.assertIsNotNone(first.consumed_at)
        second = claim_authorization_transaction(
            self.db, state=STATE, browser_secret=BROWSER, now=BASE
        )
        self.assertIsNone(second)

    def test_wrong_browser_cannot_claim_authorization(self):
        self.start()
        self.assertIsNone(
            claim_authorization_transaction(
                self.db, state=STATE, browser_secret="other-browser", now=BASE
            )
        )
        # The attempt was not consumed and the legitimate browser can finish.
        self.assertIsNotNone(
            claim_authorization_transaction(
                self.db, state=STATE, browser_secret=BROWSER, now=BASE
            )
        )

    def test_expired_authorization_cannot_be_claimed(self):
        self.start()
        self.assertIsNone(
            claim_authorization_transaction(
                self.db,
                state=STATE,
                browser_secret=BROWSER,
                now=BASE + TRANSACTION_TTL + timedelta(seconds=1),
            )
        )

    def test_handoff_is_browser_bound_and_one_use(self):
        self.handoff()
        self.assertIsNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret="other-browser",
                now=BASE,
            )
        )
        first = claim_handoff_transaction(
            self.db,
            handoff_secret=HANDOFF,
            browser_secret=BROWSER,
            now=BASE,
        )
        self.assertIsNotNone(first)
        self.assertEqual(first.subject, SUBJECT)
        second = claim_handoff_transaction(
            self.db,
            handoff_secret=HANDOFF,
            browser_secret=BROWSER,
            now=BASE,
        )
        self.assertIsNone(second)

    def test_expired_handoff_cannot_be_claimed(self):
        self.handoff()
        self.assertIsNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                now=BASE + HANDOFF_TTL + timedelta(seconds=1),
            )
        )

    def test_completion_operation_is_inferred_from_stored_row(self):
        user = self.add_user()
        self.handoff(
            operation=OPERATION_LINK,
            user_id=user.id,
            bearer_token=BEARER,
            handoff_secret="link-handoff",
            browser_secret="link-browser",
        )
        # An unauthenticated completion can never redeem a link handoff.
        self.assertIsNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret="link-handoff",
                browser_secret="link-browser",
                now=BASE,
            )
        )
        self.handoff(
            operation=OPERATION_LOGIN,
            handoff_secret="login-handoff",
        )
        claimed = claim_handoff_transaction(
            self.db,
            handoff_secret="login-handoff",
            browser_secret=BROWSER,
            expected_user_id=user.id,
            bearer_token=BEARER,
            now=BASE,
        )
        self.assertIsNotNone(claimed)
        # Supplying an authenticated context cannot turn a login handoff into a
        # link; the stored operation is authoritative for route dispatch.
        self.assertEqual(claimed.operation, OPERATION_LOGIN)


@unittest.skipUnless(TRANSACTION_DEPS_AVAILABLE, "OIDC transaction dependencies are not installed")
class HandoffPromotionTests(TransactionTestCase):
    def _claimed_link_authorization(self, user):
        self.start(
            operation=OPERATION_LINK,
            user_id=user.id,
            bearer_token=BEARER,
        )
        claimed = claim_authorization_transaction(
            self.db, state=STATE, browser_secret=BROWSER, now=BASE
        )
        self.assertIsNotNone(claimed)
        return claimed

    def test_promotion_preserves_binding_and_clears_secrets(self):
        user = self.add_user()
        claimed = self._claimed_link_authorization(user)

        promoted = promote_authorization_to_handoff(
            self.db,
            transaction_id=claimed.id,
            state=STATE,
            browser_secret=BROWSER,
            issuer=ISSUER,
            handoff_secret=HANDOFF,
            subject=SUBJECT,
            auth_time=int(BASE.timestamp()),
            now=BASE,
        )
        self.assertIsNotNone(promoted)
        self.assertEqual(promoted.operation, OPERATION_LINK)
        self.assertEqual(promoted.user_id, user.id)
        self.assertEqual(
            promoted.bearer_fingerprint, bearer_token_fingerprint(BEARER)
        )
        self.assertEqual(promoted.phase, PHASE_HANDOFF)
        self.assertEqual(promoted.subject, SUBJECT)
        self.assertEqual(promoted.auth_time, int(BASE.timestamp()))
        self.assertIsNotNone(promoted.handoff_digest)
        self.assertIsNone(promoted.state_digest)
        self.assertIsNone(promoted.nonce_ciphertext)
        self.assertIsNone(promoted.verifier_ciphertext)
        self.assertIsNone(promoted.consumed_at)
        self.assertEqual(decrypted_nonce(promoted), None)
        self.assertEqual(decrypted_code_verifier(promoted), None)
        self.assertEqual(promoted.expires_at - promoted.created_at, HANDOFF_TTL)

    def test_promotion_requires_exactly_one_updated_row(self):
        user = self.add_user()
        claimed = self._claimed_link_authorization(user)
        base_kwargs = {
            "transaction_id": claimed.id,
            "state": STATE,
            "browser_secret": BROWSER,
            "issuer": ISSUER,
            "handoff_secret": HANDOFF,
            "subject": SUBJECT,
            "auth_time": int(BASE.timestamp()),
            "now": BASE,
        }
        cases = {
            "unknown-id": {"transaction_id": claimed.id + 1000},
            "wrong-state": {"state": "wrong-state"},
            "wrong-browser": {"browser_secret": "other-browser"},
            "wrong-issuer": {"issuer": "https://other-idp.example.test"},
            "expired": {
                "now": BASE + TRANSACTION_TTL + timedelta(seconds=1)
            },
        }
        for name, overrides in cases.items():
            with self.subTest(case=name):
                values = dict(base_kwargs)
                values.update(overrides)
                self.assertIsNone(
                    promote_authorization_to_handoff(self.db, **values)
                )
                self.assertEqual(
                    self.db.query(OidcAuthTransaction).count(), 1
                )
                self.assertEqual(
                    self.db.query(OidcAuthTransaction).one().phase,
                    PHASE_AUTHORIZATION,
                )

    def test_unclaimed_authorization_cannot_be_promoted(self):
        user = self.add_user()
        authorization = self.start(
            operation=OPERATION_LINK,
            user_id=user.id,
            bearer_token=BEARER,
        )
        self.assertIsNone(
            promote_authorization_to_handoff(
                self.db,
                transaction_id=authorization.id,
                state=STATE,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret=HANDOFF,
                subject=SUBJECT,
                auth_time=int(BASE.timestamp()),
                now=BASE,
            )
        )
        self.assertEqual(self.db.query(OidcAuthTransaction).count(), 1)

    def test_promotion_is_one_use(self):
        user = self.add_user()
        claimed = self._claimed_link_authorization(user)
        first = promote_authorization_to_handoff(
            self.db,
            transaction_id=claimed.id,
            state=STATE,
            browser_secret=BROWSER,
            issuer=ISSUER,
            handoff_secret=HANDOFF,
            subject=SUBJECT,
            auth_time=int(BASE.timestamp()),
            now=BASE,
        )
        self.assertIsNotNone(first)
        self.assertIsNone(
            promote_authorization_to_handoff(
                self.db,
                transaction_id=claimed.id,
                state=STATE,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret="second-handoff",
                subject=SUBJECT,
                auth_time=int(BASE.timestamp()),
                now=BASE,
            )
        )
        rows = self.db.query(OidcAuthTransaction).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].phase, PHASE_HANDOFF)

    def test_missing_source_never_creates_a_handoff(self):
        self.assertIsNone(
            promote_authorization_to_handoff(
                self.db,
                transaction_id=999999,
                state=STATE,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret=HANDOFF,
                subject=SUBJECT,
                auth_time=int(BASE.timestamp()),
                now=BASE,
            )
        )
        self.assertEqual(self.db.query(OidcAuthTransaction).count(), 0)

    def test_promotion_requires_a_positive_row_id(self):
        for invalid in (None, 0, -1, True, "1"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(OidcTransactionError):
                    promote_authorization_to_handoff(
                        self.db,
                        transaction_id=invalid,
                        state=STATE,
                        browser_secret=BROWSER,
                        issuer=ISSUER,
                        handoff_secret=HANDOFF,
                        subject=SUBJECT,
                        now=BASE,
                    )


@unittest.skipUnless(TRANSACTION_DEPS_AVAILABLE, "OIDC transaction dependencies are not installed")
class LinkBindingTests(TransactionTestCase):
    def test_link_start_requires_user_and_bearer(self):
        with self.assertRaises(OidcTransactionError):
            self.start(operation=OPERATION_LINK)
        with self.assertRaises(OidcTransactionError):
            self.start(operation=OPERATION_LINK, user_id=self.add_user().id)

    def test_login_start_rejects_link_binding(self):
        user = self.add_user()
        with self.assertRaises(OidcTransactionError):
            self.start(user_id=user.id)
        with self.assertRaises(OidcTransactionError):
            self.start(bearer_token=BEARER)

    def test_link_handoff_requires_same_user_and_bearer(self):
        initiator = self.add_user("initiator")
        other = self.add_user("other")
        self.handoff(
            operation=OPERATION_LINK,
            user_id=initiator.id,
            bearer_token=BEARER,
        )

        self.assertIsNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                expected_user_id=other.id,
                bearer_token=BEARER,
                now=BASE,
            )
        )
        self.assertIsNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                expected_user_id=initiator.id,
                bearer_token="different-bearer-token",
                now=BASE,
            )
        )
        claimed = claim_handoff_transaction(
            self.db,
            handoff_secret=HANDOFF,
            browser_secret=BROWSER,
            expected_user_id=initiator.id,
            bearer_token=BEARER,
            now=BASE,
        )
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed.user_id, initiator.id)
        self.assertEqual(
            claimed.bearer_fingerprint, bearer_token_fingerprint(BEARER)
        )

    def test_callback_promotes_claimed_link_authorization(self):
        user = self.add_user()
        self.start(
            operation=OPERATION_LINK, user_id=user.id, bearer_token=BEARER
        )
        claimed = claim_authorization_transaction(
            self.db, state=STATE, browser_secret=BROWSER, now=BASE
        )
        self.assertIsNotNone(claimed)
        promoted = promote_authorization_to_handoff(
            self.db,
            transaction_id=claimed.id,
            state=STATE,
            browser_secret=BROWSER,
            issuer=ISSUER,
            handoff_secret=HANDOFF,
            subject=SUBJECT,
            auth_time=int(BASE.timestamp()),
            now=BASE,
        )
        self.assertIsNotNone(promoted)
        self.assertEqual(promoted.operation, OPERATION_LINK)
        self.assertEqual(promoted.user_id, user.id)
        completion = claim_handoff_transaction(
            self.db,
            handoff_secret=HANDOFF,
            browser_secret=BROWSER,
            expected_user_id=user.id,
            bearer_token=BEARER,
            now=BASE,
        )
        self.assertIsNotNone(completion)

    def test_link_claim_requires_binding_arguments(self):
        user = self.add_user()
        self.handoff(
            operation=OPERATION_LINK, user_id=user.id, bearer_token=BEARER
        )
        # No authenticated context: a link handoff is not redeemable.
        self.assertIsNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                now=BASE,
            )
        )
        # Partial link binding is a programming error, not a claim attempt.
        with self.assertRaises(OidcTransactionError):
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                expected_user_id=user.id,
                now=BASE,
            )
        with self.assertRaises(OidcTransactionError):
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                bearer_token=BEARER,
                now=BASE,
            )
        self.assertIsNotNone(
            claim_handoff_transaction(
                self.db,
                handoff_secret=HANDOFF,
                browser_secret=BROWSER,
                expected_user_id=user.id,
                bearer_token=BEARER,
                now=BASE,
            )
        )

    def test_invalidating_user_removes_consumed_and_pending_rows(self):
        user = self.add_user()
        other = self.add_user("other")
        # One claimed (consumed) in-flight authorization and one pending handoff.
        self.start(
            operation=OPERATION_LINK,
            user_id=user.id,
            bearer_token=BEARER,
            state="consumed-state",
            browser_secret="consumed-browser",
        )
        self.assertIsNotNone(
            claim_authorization_transaction(
                self.db,
                state="consumed-state",
                browser_secret="consumed-browser",
                now=BASE,
            )
        )
        self.handoff(
            operation=OPERATION_LINK,
            user_id=user.id,
            bearer_token=BEARER,
            handoff_secret="user-handoff",
        )
        self.handoff(
            operation=OPERATION_LINK,
            user_id=other.id,
            bearer_token="other-bearer",
            browser_secret="other-browser",
            handoff_secret="other-handoff",
        )
        self.assertEqual(
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.user_id == user.id)
            .count(),
            2,
        )
        self.assertEqual(
            invalidate_user_transactions(self.db, user_id=user.id), 2
        )
        self.db.commit()
        self.assertEqual(
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.user_id == user.id)
            .count(),
            0,
        )
        self.assertEqual(
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.user_id == other.id)
            .count(),
            1,
        )

    def test_invalidating_identity_matches_exact_issuer_and_subject(self):
        self.handoff(
            subject="subject-a",
            handoff_secret="handoff-a",
            browser_secret="browser-a",
        )
        self.handoff(
            subject="subject-b",
            handoff_secret="handoff-b",
            browser_secret="browser-b",
        )
        self.handoff(
            issuer="https://other-idp.example.test",
            subject="subject-a",
            handoff_secret="handoff-c",
            browser_secret="browser-c",
        )
        # Near misses must survive: trailing slash and different subject case.
        self.handoff(
            issuer=ISSUER + "/",
            subject="subject-a",
            handoff_secret="handoff-d",
            browser_secret="browser-d",
        )
        self.handoff(
            subject="Subject-A",
            handoff_secret="handoff-e",
            browser_secret="browser-e",
        )

        self.assertEqual(
            invalidate_identity_transactions(
                self.db, issuer=ISSUER, subject="subject-a"
            ),
            1,
        )
        self.db.commit()
        remaining = self.db.query(OidcAuthTransaction).all()
        self.assertEqual(len(remaining), 4)
        self.assertFalse(
            any(
                row.issuer == ISSUER and row.subject == "subject-a"
                for row in remaining
            )
        )
        # The other subject and exact-match near misses survive.
        self.assertTrue(
            any(
                row.issuer == ISSUER and row.subject == "subject-b"
                for row in remaining
            )
        )
        self.assertTrue(
            any(
                row.issuer == "https://other-idp.example.test"
                and row.subject == "subject-a"
                for row in remaining
            )
        )
        self.assertTrue(
            any(
                row.issuer == ISSUER + "/" and row.subject == "subject-a"
                for row in remaining
            )
        )
        self.assertTrue(
            any(
                row.issuer == ISSUER and row.subject == "Subject-A"
                for row in remaining
            )
        )

    def test_invalidating_identity_requires_exact_nonempty_values(self):
        for issuer, subject in (("", "subject"), (ISSUER, "")):
            with self.subTest(issuer=issuer, subject=subject):
                with self.assertRaises(OidcTransactionError):
                    invalidate_identity_transactions(
                        self.db, issuer=issuer, subject=subject
                    )

    def test_deleting_user_cascades_transaction_rows(self):
        user = self.add_user()
        self.handoff(
            operation=OPERATION_LINK, user_id=user.id, bearer_token=BEARER
        )
        self.db.delete(user)
        self.db.commit()
        self.assertEqual(
            self.db.query(OidcAuthTransaction)
            .filter(OidcAuthTransaction.user_id == user.id)
            .count(),
            0,
        )


@unittest.skipUnless(TRANSACTION_DEPS_AVAILABLE, "OIDC transaction dependencies are not installed")
class MaintenanceAndMigrationTests(TransactionTestCase):
    def test_purge_expired_is_bounded(self):
        for index in range(3):
            self.start(
                state=f"old-state-{index}",
                browser_secret=f"old-browser-{index}",
                now=BASE - TRANSACTION_TTL - timedelta(minutes=1),
            )
        self.assertEqual(
            purge_expired_transactions(self.db, now=BASE, limit=2), 2
        )
        self.db.commit()
        self.assertEqual(self.db.query(OidcAuthTransaction).count(), 1)

    def test_purge_does_not_remove_live_rows(self):
        self.start()
        self.assertEqual(purge_expired_transactions(self.db, now=BASE, limit=10), 0)
        self.assertEqual(self.db.query(OidcAuthTransaction).count(), 1)

    def test_sqlite_migration_is_idempotent(self):
        database.migrate_oidc_transaction_schema(self.engine)
        database.migrate_oidc_transaction_schema(self.engine)

    def test_migration_fails_when_transaction_table_is_missing(self):
        engine = create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        with self.assertRaises(RuntimeError):
            database.migrate_oidc_transaction_schema(engine)

    def test_random_transaction_secret_has_256_bits(self):
        first = generate_transaction_secret()
        second = generate_transaction_secret()
        self.assertNotEqual(first, second)
        self.assertGreaterEqual(len(first), 43)
        self.assertEqual(len(first.encode()), len(first))
