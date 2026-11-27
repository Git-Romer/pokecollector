"""Real PostgreSQL concurrency evidence for OIDC unlink transitions.

This suite is destructive: each test drops and recreates the ``public`` schema.
It reuses the exact scratch-database guard from
``test_auth_oidc_transactions_postgres.py`` and therefore ignores the
application ``DATABASE_URL`` and requires a dedicated, disposable scratch
database:

    OIDC_AUTH_POSTGRES_TEST=1 \
    OIDC_AUTH_TEST_DATABASE_URL=postgresql://...@127.0.0.1:<port>/oidc_auth_test_<32 lowercase hex> \
    backend/.venv/bin/python -m unittest discover -s tests -p 'test_auth_oidc_identity_postgres.py'

The URL must use PostgreSQL, a literal loopback host (127.0.0.1, ::1 or
localhost), an explicit port, and a database named exactly
``oidc_auth_test_<32 lowercase hex>``. Before the first DROP, the guard also
verifies ``SELECT current_database()`` matches that name. Setting the opt-in
with a missing or unsafe configuration is a hard failure, never a skip.

The tests exercise the real unlink route and the real
:func:`services.oidc_link.finalize_link_handoff` seam with independent database
sessions. Lock ordering is proved from PostgreSQL itself: both workers' real
``pg_backend_pid()`` values are captured, and an independent observer
connection uses ``pg_blocking_pids`` plus ``pg_stat_activity``/``pg_locks`` to
show the exact lock wait before anything is released. Observation is bounded by
a monotonic deadline and dumps the PostgreSQL state on timeout. SQLite is not
used as evidence for these lock semantics.
"""
import concurrent.futures
import json
import os
import secrets
import threading
import time
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-identity-pg-test-secret")

# Reuse the exact, already-audited scratch-DB guard. Importing this module is
# intentional: a second copy could drift and point at a real database.
from test_auth_oidc_transactions_postgres import (
    DEPS_AVAILABLE,
    POSTGRES_TEST_ENABLED,
    assert_connected_database,
    build_test_engine,
    require_safe_test_database_url,
    reset_public_schema,
    ISSUER,
)

if DEPS_AVAILABLE:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import text, update
    from sqlalchemy.orm import sessionmaker

    import api.auth as auth_api
    from database import Base, get_db
    from models import OidcAuthTransaction, OidcIdentity, User
    from services.auth import create_access_token, hash_password, verify_password
    from services.oidc_link import (
        LINK_REASON_INVALID,
        OidcLinkCompletionError,
        finalize_link_handoff,
    )
    from services.oidc_transactions import (
        OPERATION_LINK,
        OPERATION_LOGIN,
        PHASE_HANDOFF,
        claim_authorization_transaction,
        claim_handoff_transaction,
        promote_authorization_to_handoff,
        start_transaction,
    )


APP_ORIGIN = "https://app.example.test"
REDIRECT_URI = APP_ORIGIN + "/api/auth/oidc/callback"
CLIENT_SECRET = "synthetic-client-secret-do-not-print"
PASSWORD = "local-password"
NEW_PASSWORD = "new-local-password"
SUBJECT = "provider-subject-1"
OTHER_SUBJECT = "provider-subject-2"
BROWSER = "pg-identity-browser-secret"
NOW = datetime(2026, 11, 4, 12, 0, 0)

VALID_OIDC = {
    "AUTH_MODE": "mixed",
    "USER_MODE": "",
    "OIDC_ISSUER_URL": ISSUER,
    "OIDC_CLIENT_ID": "pokecollector",
    "OIDC_CLIENT_SECRET": CLIENT_SECRET,
    "OIDC_REDIRECT_URI": REDIRECT_URI,
    "OIDC_DISPLAY_NAME": "Single sign-on",
}


def oidc_env():
    return patch.dict(os.environ, VALID_OIDC, clear=False)


@unittest.skipUnless(
    POSTGRES_TEST_ENABLED,
    "requires OIDC_AUTH_POSTGRES_TEST=1 and a disposable PostgreSQL scratch database",
)
class OidcIdentityTransitionPostgresTests(unittest.TestCase):
    engine = None
    SessionLocal = None

    @classmethod
    def setUpClass(cls):
        cls.engine = build_test_engine()
        approved_name = require_safe_test_database_url(str(cls.engine.url))
        try:
            with cls.engine.connect() as connection:
                assert_connected_database(connection, approved_name)
            cls.SessionLocal = sessionmaker(
                autocommit=False, autoflush=False, bind=cls.engine
            )
        except BaseException:
            cls.engine.dispose()
            raise

    @classmethod
    def tearDownClass(cls):
        if cls.engine is not None:
            cls.engine.dispose()

    def setUp(self):
        reset_public_schema(self.engine)
        Base.metadata.create_all(self.engine)
        self.env = oidc_env()
        self.env.start()
        self.addCleanup(self.env.stop)

        auth_api._oidc_rate_state.clear()
        self._request_pids = []
        self._request_pids_lock = threading.Lock()
        app = FastAPI()
        app.include_router(auth_api.router, prefix="/api/auth")

        def override_db():
            db = self.SessionLocal()
            try:
                # Record the real backend pid of every request session. Tests
                # that pause a request use this to observe pg_blocking_pids.
                pid = db.execute(text("SELECT pg_backend_pid()")).scalar()
                with self._request_pids_lock:
                    self._request_pids.append(pid)
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(
            app, base_url="https://testserver", follow_redirects=False
        )
        self.addCleanup(self.client.close)

    # -- helpers ---------------------------------------------------------
    def _create_user(self, *, password=PASSWORD, role="trainer"):
        db = self.SessionLocal()
        try:
            user = User(
                username=f"user-{secrets.token_hex(6)}",
                hashed_password=hash_password(password),
                role=role,
                is_active=True,
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            return user.id
        finally:
            db.close()

    def _bearer(self, user_id):
        return create_access_token({"sub": str(user_id), "role": "trainer"})

    def _add_identity(self, user_id, *, subject=SUBJECT):
        db = self.SessionLocal()
        try:
            db.add(
                OidcIdentity(
                    issuer=ISSUER, subject=subject, user_id=user_id
                )
            )
            db.commit()
        finally:
            db.close()

    def _seed_link_transaction_and_handoff(self, user_id, token):
        """Create one user-bound link row and one login handoff row."""
        db = self.SessionLocal()
        try:
            state = f"state-{secrets.token_hex(8)}"
            start_transaction(
                db,
                issuer=ISSUER,
                operation=OPERATION_LINK,
                state=state,
                browser_secret=BROWSER,
                nonce="nonce",
                code_verifier="verifier",
                user_id=user_id,
                bearer_token=token,
                now=NOW,
            )
            link_row = (
                db.query(OidcAuthTransaction)
                .filter(OidcAuthTransaction.operation == OPERATION_LINK)
                .one()
            )
            handoff = OidcAuthTransaction(
                operation=OPERATION_LOGIN,
                phase=PHASE_HANDOFF,
                issuer=ISSUER,
                browser_digest="b" * 64,
                subject=SUBJECT,
                handoff_digest="h" * 64,
                expires_at=NOW + timedelta(minutes=5),
                created_at=NOW,
            )
            db.add(handoff)
            db.commit()
            db.refresh(handoff)
            return link_row.id, handoff.id
        finally:
            db.close()

    def _claimed_link_handoff(self, user_id, token, *, subject=OTHER_SUBJECT):
        """Run the real start/claim/promote/claim services in one session."""
        db = self.SessionLocal()
        try:
            state = f"state-{secrets.token_hex(8)}"
            handoff_secret = f"handoff-{secrets.token_hex(8)}"
            start_transaction(
                db,
                issuer=ISSUER,
                operation=OPERATION_LINK,
                state=state,
                browser_secret=BROWSER,
                nonce="nonce",
                code_verifier="verifier",
                user_id=user_id,
                bearer_token=token,
                now=NOW,
            )
            claimed_authorization = claim_authorization_transaction(
                db, state=state, browser_secret=BROWSER, now=NOW
            )
            self.assertIsNotNone(claimed_authorization)
            promoted = promote_authorization_to_handoff(
                db,
                transaction_id=claimed_authorization.id,
                state=state,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret=handoff_secret,
                subject=subject,
                auth_time=int(NOW.timestamp()),
                now=NOW,
            )
            self.assertIsNotNone(promoted)
            claimed = claim_handoff_transaction(
                db,
                handoff_secret=handoff_secret,
                browser_secret=BROWSER,
                expected_user_id=user_id,
                bearer_token=token,
                now=NOW,
            )
            self.assertIsNotNone(claimed)
            db.expunge(claimed)
            return claimed
        finally:
            db.close()

    def _unlink_body(self):
        return json.dumps(
            {"current_password": PASSWORD, "confirmation": True}
        ).encode("utf-8")

    def _unlink_headers(self, token):
        return {
            "Origin": APP_ORIGIN,
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }

    def _post_unlink(self, token):
        return self.client.post(
            "/api/auth/oidc/unlink",
            content=self._unlink_body(),
            headers=self._unlink_headers(token),
        )

    def _identity_count(self, user_id):
        db = self.SessionLocal()
        try:
            return (
                db.query(OidcIdentity)
                .filter(OidcIdentity.user_id == user_id)
                .count()
            )
        finally:
            db.close()

    def _stored_password_hash(self, user_id):
        db = self.SessionLocal()
        try:
            return (
                db.query(User.hashed_password)
                .filter(User.id == user_id)
                .scalar()
            )
        finally:
            db.close()

    def _transaction_ids(self):
        db = self.SessionLocal()
        try:
            return {row.id for row in db.query(OidcAuthTransaction).all()}
        finally:
            db.close()

    def _last_request_pid(self):
        with self._request_pids_lock:
            if not self._request_pids:
                raise AssertionError("no request session pg_backend_pid was recorded")
            return self._request_pids[-1]

    def _snapshot(self, pids):
        """Read live PostgreSQL lock/activity state from an independent connection."""
        pids = [int(pid) for pid in pids]
        with self.engine.connect() as conn:
            activity = {
                row["pid"]: dict(row)
                for row in conn.execute(
                    text(
                        "SELECT pid, state, wait_event_type, wait_event, "
                        "left(query, 300) AS query "
                        "FROM pg_stat_activity WHERE pid = ANY(:pids)"
                    ),
                    {"pids": pids},
                ).mappings()
            }
            locks = [
                dict(row)
                for row in conn.execute(
                    text(
                        "SELECT pid, locktype, mode, granted, classid, objid, "
                        "objsubid FROM pg_locks WHERE pid = ANY(:pids) "
                        "ORDER BY pid, locktype, granted"
                    ),
                    {"pids": pids},
                ).mappings()
            ]
            blocking = {
                pid: list(
                    conn.execute(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": pid}
                    ).scalar()
                    or []
                )
                for pid in pids
            }
        return {
            "pids": pids,
            "activity": activity,
            "locks": locks,
            "blocking": blocking,
        }

    def _observe(self, predicate, *, pids, description, timeout=15.0):
        """Poll live DB state until ``predicate`` holds, bounded by a monotonic deadline."""
        deadline = time.monotonic() + timeout
        snapshot = None
        while time.monotonic() < deadline:
            snapshot = self._snapshot(pids)
            if predicate(snapshot):
                return snapshot
            # Short observation interval; the deadline, not a fixed sleep,
            # bounds the wait.
            time.sleep(0.02)
        raise AssertionError(
            f"{description} was not observed within {timeout:.1f}s. "
            f"Live pg_stat_activity/pg_locks/pg_blocking_pids state: {snapshot!r}"
        )

    @staticmethod
    def _advisory_lock_keys(locks, *, pid, granted):
        return {
            (lock["classid"], lock["objid"], lock["objsubid"])
            for lock in locks
            if lock["pid"] == pid
            and lock["locktype"] == "advisory"
            and bool(lock["granted"]) is granted
        }

    # -- password update vs unlink --------------------------------------
    def test_password_update_commits_first_then_unlink_rejects_old_password(self):
        user_id = self._create_user()
        token = self._bearer(user_id)
        self._add_identity(user_id)
        link_id, handoff_id = self._seed_link_transaction_and_handoff(
            user_id, token
        )

        # The real /me/password route uses its own request session and commits
        # the password update first.
        update_response = self.client.put(
            "/api/auth/me/password",
            json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(update_response.status_code, 200)

        response = self._post_unlink(token)

        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json(), {"detail": "Current password is incorrect"}
        )
        self.assertEqual(self._identity_count(user_id), 1)
        remaining = self._transaction_ids()
        self.assertIn(link_id, remaining)
        self.assertIn(handoff_id, remaining)
        self.assertTrue(
            verify_password(NEW_PASSWORD, self._stored_password_hash(user_id))
        )

    def test_unlink_row_lock_blocks_password_commit_until_unlink_commits(self):
        user_id = self._create_user()
        token = self._bearer(user_id)
        self._add_identity(user_id)
        self._seed_link_transaction_and_handoff(user_id, token)

        unlink_paused_after_lock = threading.Event()
        release_unlink = threading.Event()
        password_commit_started = threading.Event()
        password_committed = threading.Event()
        unlink_pid_holder = {}
        password_pid_holder = {}
        real_verify = auth_api.verify_password

        def paused_verify(plain_password, hashed_password):
            # The unlink route calls this after taking both the advisory lock
            # and the user-row FOR UPDATE lock.
            unlink_pid_holder["pid"] = self._last_request_pid()
            unlink_paused_after_lock.set()
            if not release_unlink.wait(timeout=30):
                raise AssertionError("unlink row lock was never released")
            return real_verify(plain_password, hashed_password)

        def unlink_worker():
            return self._post_unlink(token)

        def password_worker():
            db = self.SessionLocal()
            try:
                password_pid_holder["pid"] = db.execute(
                    text("SELECT pg_backend_pid()")
                ).scalar()
                user = db.query(User).filter(User.id == user_id).one()
                self.assertTrue(verify_password(PASSWORD, user.hashed_password))
                user.hashed_password = hash_password(NEW_PASSWORD)
                password_commit_started.set()
                db.commit()
                password_committed.set()
            finally:
                db.close()

        def updater_is_lock_waiting(snapshot):
            updater_pid = password_pid_holder["pid"]
            unlink_pid = unlink_pid_holder["pid"]
            activity = snapshot["activity"].get(updater_pid, {})
            return (
                activity.get("state") == "active"
                and activity.get("wait_event_type") == "Lock"
                and unlink_pid
                in snapshot["blocking"].get(updater_pid, [])
            )

        password_future = None
        with patch.object(auth_api, "verify_password", paused_verify):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                unlink_future = pool.submit(unlink_worker)
                try:
                    self.assertTrue(
                        unlink_paused_after_lock.wait(timeout=30),
                        "unlink never reached the locked password check",
                    )
                    self.assertIn("pid", unlink_pid_holder)
                    password_future = pool.submit(password_worker)
                    self.assertTrue(
                        password_commit_started.wait(timeout=30),
                        "password update never reached commit",
                    )
                    self.assertIn("pid", password_pid_holder)

                    # Authoritative evidence: the updater is not merely
                    # scheduled before commit; PostgreSQL reports it active and
                    # waiting on the unlink backend's row lock. Without the
                    # unlink FOR UPDATE this observation times out and fails.
                    snapshot = self._observe(
                        updater_is_lock_waiting,
                        pids=[
                            unlink_pid_holder["pid"],
                            password_pid_holder["pid"],
                        ],
                        description=(
                            "password updater blocked on unlink's user-row lock"
                        ),
                    )
                    updater_pid = password_pid_holder["pid"]
                    unlink_pid = unlink_pid_holder["pid"]
                    self.assertNotEqual(
                        unlink_pid,
                        updater_pid,
                        "unlink and password update must use independent backends",
                    )
                    self.assertIn(
                        unlink_pid,
                        snapshot["blocking"][updater_pid],
                        f"expected unlink pid {unlink_pid} to block updater "
                        f"pid {updater_pid}; snapshot={snapshot!r}",
                    )
                    # A different session can still read the old value because
                    # the update is blocked on the unlink row lock.
                    self.assertFalse(password_committed.is_set())
                    self.assertTrue(
                        verify_password(
                            PASSWORD, self._stored_password_hash(user_id)
                        )
                    )
                    self.assertFalse(password_committed.is_set())
                finally:
                    release_unlink.set()

                unlink_response = unlink_future.result(timeout=30)
                if password_future is not None:
                    password_future.result(timeout=30)

        self.assertEqual(unlink_response.status_code, 200)
        self.assertEqual(unlink_response.json(), {"linked": False})
        self.assertTrue(password_committed.is_set())
        self.assertEqual(self._identity_count(user_id), 0)
        stored = self._stored_password_hash(user_id)
        self.assertTrue(verify_password(NEW_PASSWORD, stored))
        self.assertFalse(verify_password(PASSWORD, stored))

    # -- claimed LINK completion vs unlink ------------------------------
    def test_unlink_wins_then_paused_link_completion_fails(self):
        user_id = self._create_user()
        token = self._bearer(user_id)
        claimed = self._claimed_link_handoff(user_id, token)
        self._add_identity(user_id)

        unlink_response = self._post_unlink(token)
        self.assertEqual(unlink_response.status_code, 200)
        self.assertEqual(unlink_response.json(), {"linked": False})
        self.assertEqual(self._identity_count(user_id), 0)
        self.assertEqual(self._transaction_ids(), set())

        # The paused completion resumes with a detached claim whose row unlink
        # has already deleted. It must fail without inserting an identity.
        db = self.SessionLocal()
        try:
            with self.assertRaises(OidcLinkCompletionError) as raised:
                finalize_link_handoff(
                    db,
                    transaction=claimed,
                    current_user_id=user_id,
                    bearer_token=token,
                    now=NOW,
                )
            self.assertEqual(raised.exception.reason, LINK_REASON_INVALID)
        finally:
            db.close()

        self.assertEqual(self._identity_count(user_id), 0)
        self.assertEqual(self._transaction_ids(), set())

    def test_completion_wins_then_unlink_runs_after_and_leaves_unlinked(self):
        user_id = self._create_user()
        token = self._bearer(user_id)
        claimed = self._claimed_link_handoff(user_id, token)

        import services.oidc_link as oidc_link

        real_link_identity = oidc_link.link_identity
        real_unlink_lock = auth_api.lock_admin_transitions
        completion_holds_lock = threading.Event()
        completion_pid_ready = threading.Event()
        release_completion = threading.Event()
        unlink_lock_attempted = threading.Event()
        unlink_done = threading.Event()
        completion_pid_holder = {}
        unlink_pid_holder = {}

        def paused_link_identity(db, **kwargs):
            # finalize_link_handoff has already revalidated the claimed row and
            # locked the active user while holding the shared admin lock.
            completion_holds_lock.set()
            if not release_completion.wait(timeout=30):
                raise AssertionError("completion lock was never released")
            return real_link_identity(db, **kwargs)

        def completion_worker():
            db = self.SessionLocal()
            try:
                completion_pid_holder["pid"] = db.execute(
                    text("SELECT pg_backend_pid()")
                ).scalar()
                completion_pid_ready.set()
                return finalize_link_handoff(
                    db,
                    transaction=claimed,
                    current_user_id=user_id,
                    bearer_token=token,
                    now=NOW,
                )
            finally:
                db.close()

        def signaling_unlink_lock(db):
            # Capture the real unlink backend pid before it attempts the lock.
            # The assertion below is about observed pg_locks state, not this
            # event firing early.
            unlink_pid_holder["pid"] = db.execute(
                text("SELECT pg_backend_pid()")
            ).scalar()
            unlink_lock_attempted.set()
            return real_unlink_lock(db)

        def unlink_worker():
            try:
                return self._post_unlink(token)
            finally:
                unlink_done.set()

        def unlink_blocked_on_advisory(snapshot):
            unlink_pid = unlink_pid_holder["pid"]
            completion_pid = completion_pid_holder["pid"]
            activity = snapshot["activity"].get(unlink_pid, {})
            waiting_keys = self._advisory_lock_keys(
                snapshot["locks"], pid=unlink_pid, granted=False
            )
            held_keys = self._advisory_lock_keys(
                snapshot["locks"], pid=completion_pid, granted=True
            )
            return (
                bool(waiting_keys & held_keys)
                and completion_pid
                in snapshot["blocking"].get(unlink_pid, [])
                and activity.get("wait_event_type") == "Lock"
            )

        with patch.object(
            oidc_link, "link_identity", paused_link_identity
        ), patch.object(
            auth_api, "lock_admin_transitions", signaling_unlink_lock
        ):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                completion_future = pool.submit(completion_worker)
                try:
                    self.assertTrue(
                        completion_pid_ready.wait(timeout=30),
                        "completion never reported its backend pid",
                    )
                    self.assertTrue(
                        completion_holds_lock.wait(timeout=30),
                        "completion never reached the final mutation",
                    )
                    unlink_future = pool.submit(unlink_worker)
                    self.assertTrue(
                        unlink_lock_attempted.wait(timeout=30),
                        "unlink never attempted the shared lock",
                    )
                    self.assertIn("pid", unlink_pid_holder)

                    # Authoritative evidence: unlink has a real ungranted
                    # advisory lock row whose key is held granted by the
                    # completion backend, and pg_blocking_pids names completion.
                    # A mere earlier event is not accepted. If the advisory lock
                    # were removed, this observation would time out even if the
                    # completion's user-row lock still blocked unlink.
                    snapshot = self._observe(
                        unlink_blocked_on_advisory,
                        pids=[
                            completion_pid_holder["pid"],
                            unlink_pid_holder["pid"],
                        ],
                        description=(
                            "unlink blocked on completion's ungranted advisory lock"
                        ),
                    )
                    completion_pid = completion_pid_holder["pid"]
                    unlink_pid = unlink_pid_holder["pid"]
                    self.assertNotEqual(
                        completion_pid,
                        unlink_pid,
                        "completion and unlink must use independent backends",
                    )
                    waiting_keys = self._advisory_lock_keys(
                        snapshot["locks"], pid=unlink_pid, granted=False
                    )
                    held_keys = self._advisory_lock_keys(
                        snapshot["locks"], pid=completion_pid, granted=True
                    )
                    self.assertTrue(
                        waiting_keys & held_keys,
                        f"expected unlink pid {unlink_pid} to wait on the same "
                        f"advisory key that completion pid {completion_pid} "
                        f"holds; snapshot={snapshot!r}",
                    )
                    self.assertIn(
                        completion_pid,
                        snapshot["blocking"][unlink_pid],
                        f"expected completion pid {completion_pid} to block "
                        f"unlink pid {unlink_pid}; snapshot={snapshot!r}",
                    )
                    self.assertFalse(unlink_done.is_set())
                finally:
                    release_completion.set()

                completion_future.result(timeout=30)
                unlink_response = unlink_future.result(timeout=30)

        self.assertEqual(unlink_response.status_code, 200)
        self.assertEqual(unlink_response.json(), {"linked": False})
        self.assertEqual(self._identity_count(user_id), 0)
        self.assertEqual(self._transaction_ids(), set())

    def test_completion_rejects_a_claimed_row_whose_binding_changed(self):
        user_id = self._create_user()
        token = self._bearer(user_id)
        claimed = self._claimed_link_handoff(user_id, token)

        db = self.SessionLocal()
        try:
            db.execute(
                update(OidcAuthTransaction)
                .where(OidcAuthTransaction.id == claimed.id)
                .values(subject="tampered-subject")
            )
            db.commit()
            with self.assertRaises(OidcLinkCompletionError) as raised:
                finalize_link_handoff(
                    db,
                    transaction=claimed,
                    current_user_id=user_id,
                    bearer_token=token,
                    now=NOW,
                )
            self.assertEqual(raised.exception.reason, LINK_REASON_INVALID)
        finally:
            db.close()

        self.assertEqual(self._identity_count(user_id), 0)


if __name__ == "__main__":
    unittest.main()
