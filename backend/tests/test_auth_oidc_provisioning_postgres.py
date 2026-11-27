"""Real PostgreSQL concurrency evidence for OIDC account provisioning.

This suite is destructive and shares the guard used by the OIDC transaction
concurrency suite: it requires a dedicated disposable scratch database.

    OIDC_AUTH_POSTGRES_TEST=1 \
    OIDC_AUTH_TEST_DATABASE_URL=postgresql://...@127.0.0.1:<port>/oidc_auth_test_<32 lowercase hex> \
    backend/.venv/bin/python -m unittest discover -s tests -p 'test_auth_oidc_provisioning_postgres.py'

When the opt-in is unset the suite is skipped and this file does not claim to
have run. When it is set, the imported guard raises on a missing/unsafe URL;
the suite never falls back to the application database and is never silently
downgraded.
"""
import concurrent.futures
import json
import os
import threading
import unittest
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-provisioning-pg-test-secret")

try:
    import psycopg2  # noqa: F401 - SQLAlchemy's PostgreSQL driver
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import event, text
    from sqlalchemy.orm import sessionmaker

    EXTERNAL_DEPENDENCY_MISSING = False
except ModuleNotFoundError:
    EXTERNAL_DEPENDENCY_MISSING = True

if not EXTERNAL_DEPENDENCY_MISSING:
    import api.auth as auth_api
    from database import Base, get_db, migrate_oidc_transaction_schema
    from models import OidcAuthTransaction, OidcIdentity, User
    from services.oidc_identity import provision_user_for_identity
    from services.oidc_transactions import (
        OPERATION_LOGIN,
        claim_authorization_transaction,
        promote_authorization_to_handoff,
        start_transaction,
    )

    # Reuse the approved safety guard instead of duplicating a destructive
    # database check. Importing this module with the opt-in unset is safe; it
    # only defines helpers and skipped classes.
    from test_auth_oidc_transactions_postgres import (
        POSTGRES_TEST_ENABLED,
        build_test_engine,
        reset_public_schema,
    )
else:
    POSTGRES_TEST_ENABLED = False
    if os.environ.get("OIDC_AUTH_POSTGRES_TEST") == "1":
        raise RuntimeError(
            "OIDC_AUTH_POSTGRES_TEST=1 requires the PostgreSQL test dependencies; "
            "an explicit destructive opt-in must never silently skip."
        )

ISSUER = "https://idp.example.test"
SUBJECT = "pg-concurrent-provisioning-subject"


@unittest.skipUnless(
    POSTGRES_TEST_ENABLED,
    "requires OIDC_AUTH_POSTGRES_TEST=1 and a disposable PostgreSQL scratch database",
)
class ProvisioningRacePostgresTests(unittest.TestCase):
    engine = None
    SessionLocal = None

    @classmethod
    def setUpClass(cls):
        cls.engine = build_test_engine()
        cls.SessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=cls.engine
        )

    @classmethod
    def tearDownClass(cls):
        if cls.engine is not None:
            cls.engine.dispose()

    def setUp(self):
        reset_public_schema(self.engine)
        Base.metadata.create_all(self.engine)

    def test_concurrent_provisioning_creates_one_user_and_one_identity(self):
        barrier = threading.Barrier(2)
        results = []
        errors = []

        def worker():
            db = self.SessionLocal()
            try:
                # Establish the connection before the barrier so the workers
                # really contend on the unique identity insert.
                db.execute(text("SELECT 1"))
                barrier.wait(timeout=30)
                user = provision_user_for_identity(
                    db, issuer=ISSUER, subject=SUBJECT
                )
                results.append(user.id)
            except BaseException as exc:  # noqa: BLE001 - surfaced by the test
                errors.append(exc)
            finally:
                db.close()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 1)

        db = self.SessionLocal()
        try:
            self.assertEqual(db.query(User).count(), 1)
            self.assertEqual(db.query(OidcIdentity).count(), 1)
            identity = db.query(OidcIdentity).one()
            self.assertEqual(identity.issuer, ISSUER)
            self.assertEqual(identity.subject, SUBJECT)
            self.assertEqual(identity.user_id, results[0])
        finally:
            db.close()

    def test_fail_fast_migration_adds_username_hint_to_legacy_table(self):
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE oidc_auth_transactions "
                    "DROP COLUMN username_hint"
                )
            )

        migrate_oidc_transaction_schema(self.engine)
        migrate_oidc_transaction_schema(self.engine)

        with self.engine.connect() as conn:
            columns = {
                row[0]
                for row in conn.execute(text("""
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'oidc_auth_transactions'
                """))
            }
        self.assertIn("username_hint", columns)

    # The following tests drive real /complete requests with independent DB
    # sessions. Only the guarded disposable PostgreSQL database is ever used.
    def _seed_handoff(self, suffix, subject):
        browser, handoff, state = (f"{kind}-{suffix}" for kind in ("browser", "handoff", "state"))
        with self.SessionLocal() as db:
            row = start_transaction(
                db, issuer=ISSUER, operation=OPERATION_LOGIN, state=state,
                browser_secret=browser, nonce="nonce", code_verifier="verifier",
            )
            claim_authorization_transaction(db, state=state, browser_secret=browser)
            promoted = promote_authorization_to_handoff(
                db, transaction_id=row.id, state=state, browser_secret=browser,
                issuer=ISSUER, handoff_secret=handoff, subject=subject,
            )
            return browser, handoff, promoted.id

    def _completion_app(self):
        app = FastAPI()
        app.include_router(auth_api.router, prefix="/api/auth")

        def override_db():
            with self.SessionLocal() as db:
                yield db

        app.dependency_overrides[get_db] = override_db
        auth_api._oidc_rate_state.clear()
        return app

    def _complete_chosen(self, app, binding, username):
        browser, handoff, _ = binding
        with TestClient(app, base_url="https://testserver", follow_redirects=False) as client:
            return client.post(
                "/api/auth/oidc/complete",
                content=json.dumps({"username": username}).encode(),
                headers={
                    "Origin": "https://app.example.test",
                    "Content-Type": "application/json",
                    "Cookie": (
                        f"{auth_api.OIDC_BROWSER_COOKIE}={browser}; "
                        f"{auth_api.OIDC_HANDOFF_COOKIE}={handoff}"
                    ),
                },
            )

    def _naming_env(self):
        return patch.dict(os.environ, {
            "AUTH_MODE": "mixed", "USER_MODE": "",
            "OIDC_ISSUER_URL": ISSUER, "OIDC_CLIENT_ID": "synthetic-client",
            "OIDC_CLIENT_SECRET": "synthetic-secret",
            "OIDC_REDIRECT_URI": "https://app.example.test/api/auth/oidc/callback",
        })

    def test_same_handoff_chosen_name_completes_only_once(self):
        binding = self._seed_handoff("same-handoff", SUBJECT)
        app = self._completion_app()
        entered = threading.Event()
        release = threading.Event()
        second_claim = threading.Event()
        real_provision = auth_api.provision_user_for_identity_with_username
        real_claim = auth_api.claim_handoff_transaction
        counter = {"count": 0}
        lock = threading.Lock()

        def paused_provision(db, **kwargs):
            entered.set()
            if not release.wait(timeout=15):
                raise AssertionError("first completion was not released")
            return real_provision(db, **kwargs)

        def observed_claim(db, **kwargs):
            with lock:
                counter["count"] += 1
                if counter["count"] == 2:
                    second_claim.set()
            return real_claim(db, **kwargs)

        with self._naming_env(), patch.object(
            auth_api, "provision_user_for_identity_with_username", paused_provision
        ), patch.object(auth_api, "claim_handoff_transaction", observed_claim):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self._complete_chosen, app, binding, "first-name")
                try:
                    self.assertTrue(entered.wait(timeout=15))
                    second = pool.submit(self._complete_chosen, app, binding, "other-name")
                    self.assertTrue(second_claim.wait(timeout=15))
                finally:
                    release.set()
                responses = [first.result(timeout=30), second.result(timeout=30)]
        self.assertEqual(sorted(response.status_code for response in responses), [200, 400])
        with self.SessionLocal() as db:
            self.assertEqual(db.query(User).count(), 1)
            self.assertEqual(db.query(OidcIdentity).count(), 1)
            self.assertIsNotNone(db.get(OidcAuthTransaction, binding[2]).consumed_at)

    def _race_chosen_insertions(self, *, same_identity):
        subjects = (SUBJECT, SUBJECT if same_identity else "other-subject")
        names = ("first-name", "other-name") if same_identity else ("contended-name",) * 2
        bindings = [self._seed_handoff(str(index), subject) for index, subject in enumerate(subjects)]
        app = self._completion_app()
        barrier = threading.Barrier(2)

        def synchronize_candidates(_mapper, _connection, target):
            # Both helpers have already found no identity and entered their
            # savepoints. Force genuine competing INSERTs, not sequential calls.
            if target.username in names:
                barrier.wait(timeout=15)

        event.listen(User, "before_insert", synchronize_candidates)
        try:
            with self._naming_env():
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [
                        pool.submit(self._complete_chosen, app, binding, name)
                        for binding, name in zip(bindings, names)
                    ]
                    responses = [future.result(timeout=30) for future in futures]
        finally:
            event.remove(User, "before_insert", synchronize_candidates)
        return app, bindings, responses

    def test_distinct_identities_competing_for_name_leave_loser_retryable_no_orphan(self):
        app, bindings, responses = self._race_chosen_insertions(same_identity=False)
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        loser = next(index for index, response in enumerate(responses) if response.status_code == 409)
        self.assertEqual(responses[loser].json(), {
            "code": "username_taken", "detail": "Username already taken",
        })
        with self.SessionLocal() as db:
            self.assertEqual(db.query(User).count(), 1)
            self.assertEqual(db.query(OidcIdentity).count(), 1)
            row = db.get(OidcAuthTransaction, bindings[loser][2])
            self.assertIsNone(row.consumed_at)
            deadline = row.expires_at
        with self._naming_env():
            retry = self._complete_chosen(app, bindings[loser], "retry-name")
        self.assertEqual(retry.status_code, 200)
        with self.SessionLocal() as db:
            self.assertEqual(db.query(User).count(), 2)
            self.assertEqual(db.query(OidcIdentity).count(), 2)
            self.assertEqual(db.get(OidcAuthTransaction, bindings[loser][2]).expires_at, deadline)

    def test_same_identity_with_different_chosen_names_resolves_one_unchanged_account(self):
        _, _, responses = self._race_chosen_insertions(same_identity=True)
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(responses[0].json()["user"], responses[1].json()["user"])
        with self.SessionLocal() as db:
            self.assertEqual(db.query(User).count(), 1)
            self.assertEqual(db.query(OidcIdentity).count(), 1)
            self.assertEqual(db.query(User).one().username, responses[0].json()["user"]["username"])


if __name__ == "__main__":
    unittest.main()
