"""Focused P5 tests for the host-only OIDC identity repair command.

The command is exercised against a disposable synthetic SQLite database with
foreign keys enabled. No Dev/Prod database or real provider is touched.
"""
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-repair-test-secret")

try:
    # Third-party dependencies only; internal import errors below must fail.
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

if DEPS_AVAILABLE:
    import scripts.oidc_identity_repair as repair
    from database import Base
    from models import CollectionItem, OidcAuthTransaction, OidcIdentity, User
    from services.auth import hash_password
    from services.oidc_identity import find_identity
    from services.oidc_transactions import (
        OPERATION_LINK,
        OPERATION_LOGIN,
        PHASE_HANDOFF,
        start_transaction,
    )

ISSUER = "https://idp.example.test"
OTHER_ISSUER = "https://other-idp.example.test"
SUBJECT = "repair-subject-1"
PASSWORD = "synthetic-local-password"
SECRET = "synthetic-client-secret-do-not-print"


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class OidcIdentityRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "repair.sqlite3"
        self.engine = create_engine(
            f"sqlite:///{self.db_path}",
            connect_args={"check_same_thread": False},
        )

        @event.listens_for(self.engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.addCleanup(self.db.close)

    # -- helpers ---------------------------------------------------------
    def add_user(self, username, *, role="trainer", password=PASSWORD):
        user = User(
            username=username,
            hashed_password=hash_password(password) if password else None,
            role=role,
            is_active=True,
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

    def run_cli(self, *args, issuer=ISSUER):
        out = io.StringIO()
        err = io.StringIO()
        env = {"OIDC_ISSUER_URL": issuer} if issuer is not None else {}
        with patch.object(repair, "SessionLocal", self.Session), patch.dict(
            os.environ, env, clear=False
        ), redirect_stdout(out), redirect_stderr(err):
            if issuer is None:
                os.environ.pop("OIDC_ISSUER_URL", None)
            code = repair.main(list(args))
        self.db.expire_all()
        return code, out.getvalue(), err.getvalue()

    def identities(self):
        return self.db.query(OidcIdentity).all()

    # -- tests -----------------------------------------------------------
    def test_preview_is_default_and_writes_nothing(self):
        user = self.add_user("admin", role="admin")

        code, out, err = self.run_cli(
            "--user-id", str(user.id), "--issuer", ISSUER, "--subject", SUBJECT
        )

        self.assertEqual(code, 0)
        self.assertIn("Dry run", out)
        self.assertIn("No changes made", out)
        self.assertIn("does not change or override", out)
        self.assertEqual(err, "")
        self.assertEqual(self.identities(), [])
        self.db.refresh(user)
        self.assertEqual(user.role, "admin")

    def test_missing_confirm_never_writes(self):
        user = self.add_user("admin", role="admin")

        code, _, _ = self.run_cli(
            "--user-id", str(user.id), "--issuer", ISSUER, "--subject", SUBJECT
        )

        self.assertEqual(code, 0)
        self.assertEqual(self.identities(), [])

    def test_confirm_links_exact_identity_without_changing_account(self):
        user = self.add_user("admin", role="admin")
        original_hash = user.hashed_password
        collection = CollectionItem(user_id=user.id, quantity=1, variant="Normal")
        self.db.add(collection)
        self.db.commit()

        code, out, err = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )

        self.assertEqual(code, 0, err)
        self.assertEqual(err, "")
        identity = find_identity(self.db, ISSUER, SUBJECT)
        self.assertIsNotNone(identity)
        self.assertEqual(identity.user_id, user.id)
        self.db.refresh(user)
        self.assertEqual(user.role, "admin")
        self.assertEqual(user.hashed_password, original_hash)
        self.assertIsNotNone(
            self.db.query(CollectionItem)
            .filter(CollectionItem.id == collection.id)
            .first()
        )
        self.assertIn("Roles, passwords and collection data were not changed", out)

    def test_duplicate_elsewhere_is_refused_without_move(self):
        owner = self.add_user("owner")
        target = self.add_user("target")
        original = self.link(owner, subject=SUBJECT)

        code, _, err = self.run_cli(
            "--user-id",
            str(target.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )

        self.assertEqual(code, 1)
        self.assertIn("already linked", err)
        identities = self.identities()
        self.assertEqual(len(identities), 1)
        self.assertEqual(identities[0].id, original.id)
        self.assertEqual(identities[0].user_id, owner.id)

    def test_unknown_user_exits_nonzero(self):
        code, _, err = self.run_cli(
            "--user-id", "9999", "--issuer", ISSUER, "--subject", SUBJECT, "--confirm"
        )

        self.assertEqual(code, 1)
        self.assertIn("No user", err)
        self.assertEqual(self.identities(), [])

    def test_issuer_must_match_exactly(self):
        user = self.add_user("target")

        mismatch, _, err = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            OTHER_ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )
        self.assertEqual(mismatch, 1)
        self.assertIn("exactly match", err)

        missing, _, err = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
            issuer=None,
        )
        self.assertEqual(missing, 1)
        self.assertIn("OIDC_ISSUER_URL is not set", err)
        self.assertEqual(self.identities(), [])

    def test_user_with_different_identity_for_issuer_is_refused(self):
        user = self.add_user("target")
        original = self.link(user, subject="existing-subject")

        code, _, err = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )

        self.assertEqual(code, 1)
        self.assertIn("already has a different identity", err)
        self.assertEqual([row.id for row in self.identities()], [original.id])

    def test_already_linked_to_target_is_a_safe_noop(self):
        user = self.add_user("target")
        original = self.link(user)

        code, out, _ = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )

        self.assertEqual(code, 0)
        self.assertIn("already linked", out)
        self.assertEqual([row.id for row in self.identities()], [original.id])

    def test_mutation_invalidates_related_transactions(self):
        user = self.add_user("target")
        token = "synthetic-bearer-token"
        link_tx = start_transaction(
            self.db,
            issuer=ISSUER,
            operation=OPERATION_LINK,
            state="repair-state",
            browser_secret="repair-browser",
            nonce="repair-nonce",
            code_verifier="repair-verifier",
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
        unrelated = OidcAuthTransaction(
            operation=OPERATION_LOGIN,
            phase=PHASE_HANDOFF,
            issuer=ISSUER,
            browser_digest="c" * 64,
            subject="unrelated-subject",
            handoff_digest="u" * 64,
            expires_at=now + timedelta(minutes=5),
            created_at=now,
        )
        self.db.add_all([handoff, unrelated])
        self.db.commit()
        link_tx_id = link_tx.id
        handoff_id = handoff.id
        unrelated_id = unrelated.id

        code, out, err = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )

        self.assertEqual(code, 0, err)
        remaining = {row.id for row in self.db.query(OidcAuthTransaction).all()}
        self.assertNotIn(link_tx_id, remaining)
        self.assertNotIn(handoff_id, remaining)
        self.assertIn(unrelated_id, remaining)
        self.assertIn("Invalidated", out)

    def test_output_contains_no_sensitive_material(self):
        user = self.add_user("target")

        code, out, err = self.run_cli(
            "--user-id",
            str(user.id),
            "--issuer",
            ISSUER,
            "--subject",
            SUBJECT,
            "--confirm",
        )

        self.assertEqual(code, 0, err)
        combined = out + err
        self.assertNotIn(PASSWORD, combined)
        self.assertNotIn(SECRET, combined)
        self.assertNotIn("hashed_password", combined)
        self.assertNotIn("eyJ", combined)


if __name__ == "__main__":
    unittest.main()
