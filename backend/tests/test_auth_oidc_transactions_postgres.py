"""Real PostgreSQL concurrency evidence for OIDC transaction state.

This suite is destructive: each test drops and recreates the ``public`` schema.
It therefore ignores the application ``DATABASE_URL`` and requires a dedicated,
disposable scratch database:

    OIDC_AUTH_POSTGRES_TEST=1 \
    OIDC_AUTH_TEST_DATABASE_URL=postgresql://...@127.0.0.1:<port>/oidc_auth_test_<32 lowercase hex> \
    backend/.venv/bin/python -m unittest discover -s tests -p 'test_auth_oidc_transactions_postgres.py'

The URL must use PostgreSQL, a literal loopback host (127.0.0.1, ::1 or
localhost), an explicit port, and a database named exactly
``oidc_auth_test_<32 lowercase hex>``. Before the first DROP, the guard also
verifies ``SELECT current_database()`` matches that name. Setting the opt-in
with a missing or unsafe configuration is a hard failure, never a skip.

The guards are intentionally identical to ``test_auth_oidc_schema_postgres.py``
so both destructive suites can never be pointed at Dev/Prod. Optional skipping
is limited to a missing third-party package; a missing project module always
fails the import, opted in or not.
"""
import concurrent.futures
import os
import re
import threading
import unittest
from datetime import datetime

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-transaction-pg-test-secret")

TEST_DATABASE_URL_ENV = "OIDC_AUTH_TEST_DATABASE_URL"
DESTRUCTIVE_TEST_OPT_IN_ENV = "OIDC_AUTH_POSTGRES_TEST"

# Third-party packages required by this module and the project modules it
# exercises. Only these may be absent without failing collection (and then only
# when the destructive opt-in is unset). Project modules are deliberately absent:
# their absence must propagate so broken imports can never masquerade as skips.
EXTERNAL_DEPENDENCY_ROOTS = frozenset(
    {"bcrypt", "fastapi", "jose", "psycopg2", "pydantic", "sqlalchemy"}
)

_MISSING_EXTERNAL_DEPENDENCY = None
try:
    import bcrypt  # noqa: F401 - imported by services.auth
    import jose  # noqa: F401 - imported by services.auth
    import psycopg2  # noqa: F401 - SQLAlchemy's PostgreSQL driver
    import pydantic  # noqa: F401 - imported by project models
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import ArgumentError
    from sqlalchemy.orm import sessionmaker
except ModuleNotFoundError as exc:
    _missing_root = (exc.name or "").split(".", 1)[0]
    if _missing_root not in EXTERNAL_DEPENDENCY_ROOTS:
        raise
    _MISSING_EXTERNAL_DEPENDENCY = exc.name

DEPS_AVAILABLE = _MISSING_EXTERNAL_DEPENDENCY is None

if not DEPS_AVAILABLE and os.environ.get(DESTRUCTIVE_TEST_OPT_IN_ENV) == "1":
    raise RuntimeError(
        f"{DESTRUCTIVE_TEST_OPT_IN_ENV}=1 requires the PostgreSQL test dependencies, "
        f"but {_MISSING_EXTERNAL_DEPENDENCY!r} is not installed. Install "
        "backend/requirements.txt; an explicit destructive opt-in must never "
        "silently downgrade to a skipped suite."
    )

# Project imports sit outside the handler above on purpose: a missing internal
# module must surface as a collection error instead of being treated as a
# missing optional dependency.
if DEPS_AVAILABLE:
    from database import Base
    from models import OidcAuthTransaction
    from services.oidc_transactions import (
        OPERATION_LOGIN,
        PHASE_AUTHORIZATION,
        PHASE_HANDOFF,
        claim_authorization_transaction,
        claim_handoff_transaction,
        promote_authorization_to_handoff,
        start_transaction,
    )


APPROVED_TEST_DATABASE_RE = re.compile(r"^oidc_auth_test_[0-9a-f]{32}$")
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
CONNECTION_TARGET_QUERY_KEYS = frozenset(
    {"host", "hostaddr", "port", "dbname", "service", "dsn"}
)


class UnsafeTestDatabaseError(RuntimeError):
    """The destructive PostgreSQL suite is pointed at an unsafe target."""


# Reaching this point with the opt-in set and a missing external dependency is
# impossible: the import above raised. Keep the flag honest for the skip path.
DESTRUCTIVE_SUITE_OPT_IN = (
    DEPS_AVAILABLE and os.environ.get(DESTRUCTIVE_TEST_OPT_IN_ENV) == "1"
)
POSTGRES_TEST_ENABLED = DESTRUCTIVE_SUITE_OPT_IN


def require_safe_test_database_url(url_value):
    """Validate a scratch URL and return its approved database name.

    This runs before any engine is created and again against the engine's actual
    URL inside :func:`reset_public_schema`, so a caller cannot bypass it with a
    skip decorator or a differently configured application engine.
    """
    try:
        url = make_url(url_value)
    except (ArgumentError, TypeError, ValueError) as exc:
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} is not a valid SQLAlchemy URL: {exc}"
        ) from exc

    backend = url.get_backend_name()
    if backend != "postgresql":
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} must use PostgreSQL, not {backend!r}"
        )

    if url.host is None:
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} must name an explicit loopback host"
        )
    host = url.host.lower()
    if host not in LOOPBACK_HOSTS:
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} host {url.host!r} is not a literal loopback host "
            f"({', '.join(sorted(LOOPBACK_HOSTS))})"
        )

    if url.port is None:
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} must include an explicit port"
        )
    if not 1 <= url.port <= 65535:
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} port {url.port!r} is outside 1-65535"
        )

    database_name = url.database or ""
    if not APPROVED_TEST_DATABASE_RE.fullmatch(database_name):
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} database {database_name!r} must match "
            "oidc_auth_test_<32 lowercase hex>"
        )

    override_keys = sorted(
        {str(key).lower() for key in url.query} & CONNECTION_TARGET_QUERY_KEYS
    )
    if override_keys:
        raise UnsafeTestDatabaseError(
            f"{TEST_DATABASE_URL_ENV} must not override the connection target via "
            f"query parameters: {', '.join(override_keys)}"
        )

    return database_name


def configured_test_database_url():
    """Return the dedicated URL, never falling back to application ``DATABASE_URL``."""
    url_value = os.environ.get(TEST_DATABASE_URL_ENV, "")
    if not url_value.strip():
        raise UnsafeTestDatabaseError(
            f"{DESTRUCTIVE_TEST_OPT_IN_ENV}=1 requires {TEST_DATABASE_URL_ENV} to name "
            "a disposable PostgreSQL scratch database (oidc_auth_test_<32 lowercase hex>)"
        )
    return url_value


def build_test_engine():
    """Build the scratch engine only after the URL passes the safety guard."""
    url_value = configured_test_database_url()
    require_safe_test_database_url(url_value)
    return create_engine(url_value, pool_pre_ping=True)


def assert_connected_database(connection, approved_name):
    """Refuse to proceed unless the live connection targets the approved scratch DB."""
    connected_name = connection.execute(text("SELECT current_database()")).scalar()
    if connected_name != approved_name:
        raise UnsafeTestDatabaseError(
            "Refusing destructive reset: connected database "
            f"{connected_name!r} does not match approved scratch database {approved_name!r}"
        )


def reset_public_schema(target_engine):
    """Drop/recreate ``public`` only after the URL and connection guards pass."""
    approved_name = require_safe_test_database_url(str(target_engine.url))
    if getattr(target_engine.dialect, "name", None) != "postgresql":
        raise UnsafeTestDatabaseError(
            "Refusing destructive reset: target engine is not PostgreSQL"
        )
    with target_engine.begin() as conn:
        assert_connected_database(conn, approved_name)
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))


ISSUER = "https://idp.example.test"
BROWSER = "pg-concurrency-browser-secret"
OLD_STATE = "old-state"
NEW_STATE = "new-state"
OLD_HANDOFF = "old-handoff"
CLAIM_STATE = "claim-state"
CLAIM_HANDOFF = "claim-handoff"
NOW = datetime(2026, 11, 4, 12, 0, 0)


@unittest.skipUnless(
    POSTGRES_TEST_ENABLED,
    "requires OIDC_AUTH_POSTGRES_TEST=1 and a disposable PostgreSQL scratch database",
)
class OidcTransactionConcurrencyPostgresTests(unittest.TestCase):
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

    def _start_worker(self, barrier, state):
        db = self.SessionLocal()
        try:
            # Establish the connection before the barrier so the workers really
            # contend instead of serialising on connection setup.
            db.execute(text("SELECT 1"))
            barrier.wait(timeout=30)
            start_transaction(
                db,
                issuer=ISSUER,
                operation=OPERATION_LOGIN,
                state=state,
                browser_secret=BROWSER,
                nonce="nonce",
                code_verifier="verifier",
                now=NOW,
            )
            # No explicit commit: start_transaction must commit the
            # invalidation+insert atomically before returning.
        finally:
            db.close()

    def _promote_worker(self, barrier, transaction_id):
        db = self.SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            barrier.wait(timeout=30)
            promoted = promote_authorization_to_handoff(
                db,
                transaction_id=transaction_id,
                state=OLD_STATE,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret=OLD_HANDOFF,
                subject="old-subject",
                auth_time=int(NOW.timestamp()),
                now=NOW,
            )
            return promoted is not None
        finally:
            db.close()

    def _claim_authorization_worker(self, barrier, state):
        db = self.SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            barrier.wait(timeout=30)
            return claim_authorization_transaction(
                db,
                state=state,
                browser_secret=BROWSER,
                now=NOW,
            )
        finally:
            db.close()

    def _claim_handoff_worker(self, barrier, handoff_secret):
        db = self.SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            barrier.wait(timeout=30)
            return claim_handoff_transaction(
                db,
                handoff_secret=handoff_secret,
                browser_secret=BROWSER,
                now=NOW,
            )
        finally:
            db.close()

    def test_simultaneous_starts_leave_exactly_one_active_flow(self):
        worker_count = 4
        barrier = threading.Barrier(worker_count, timeout=30)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=worker_count
        ) as pool:
            futures = [
                pool.submit(self._start_worker, barrier, f"state-{index}")
                for index in range(worker_count)
            ]
            for future in futures:
                future.result(timeout=60)

        db = self.SessionLocal()
        try:
            rows = db.query(OidcAuthTransaction).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].phase, PHASE_AUTHORIZATION)
            self.assertIsNone(rows[0].consumed_at)

            # Exactly one of the competing state values is still claimable.
            claimed = [
                claim_authorization_transaction(
                    db,
                    state=f"state-{index}",
                    browser_secret=BROWSER,
                    now=NOW,
                )
                for index in range(worker_count)
            ]
            self.assertEqual(sum(1 for row in claimed if row is not None), 1)
        finally:
            db.close()

    def test_simultaneous_authorization_claims_have_exactly_one_winner(self):
        setup_db = self.SessionLocal()
        try:
            start_transaction(
                setup_db,
                issuer=ISSUER,
                operation=OPERATION_LOGIN,
                state=CLAIM_STATE,
                browser_secret=BROWSER,
                nonce="nonce",
                code_verifier="verifier",
                now=NOW,
            )
        finally:
            setup_db.close()

        worker_count = 2
        barrier = threading.Barrier(worker_count, timeout=30)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=worker_count
        ) as pool:
            futures = [
                pool.submit(
                    self._claim_authorization_worker, barrier, CLAIM_STATE
                )
                for _ in range(worker_count)
            ]
            results = [future.result(timeout=60) for future in futures]

        self.assertEqual(sum(1 for row in results if row is not None), 1)

        db = self.SessionLocal()
        try:
            rows = db.query(OidcAuthTransaction).all()
            count = len(rows)
            phases = [row.phase for row in rows]
            consumed = [row.consumed_at is not None for row in rows]
        finally:
            db.close()

        self.assertEqual(count, 1)
        self.assertEqual(phases, [PHASE_AUTHORIZATION])
        self.assertEqual(consumed, [True])

    def test_simultaneous_handoff_claims_have_exactly_one_winner(self):
        setup_db = self.SessionLocal()
        try:
            start_transaction(
                setup_db,
                issuer=ISSUER,
                operation=OPERATION_LOGIN,
                state=CLAIM_STATE,
                browser_secret=BROWSER,
                nonce="nonce",
                code_verifier="verifier",
                now=NOW,
            )
            claimed = claim_authorization_transaction(
                setup_db,
                state=CLAIM_STATE,
                browser_secret=BROWSER,
                now=NOW,
            )
            self.assertIsNotNone(claimed)
            promoted = promote_authorization_to_handoff(
                setup_db,
                transaction_id=claimed.id,
                state=CLAIM_STATE,
                browser_secret=BROWSER,
                issuer=ISSUER,
                handoff_secret=CLAIM_HANDOFF,
                subject="claim-subject",
                auth_time=int(NOW.timestamp()),
                now=NOW,
            )
            self.assertIsNotNone(promoted)
        finally:
            setup_db.close()

        worker_count = 2
        barrier = threading.Barrier(worker_count, timeout=30)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=worker_count
        ) as pool:
            futures = [
                pool.submit(self._claim_handoff_worker, barrier, CLAIM_HANDOFF)
                for _ in range(worker_count)
            ]
            results = [future.result(timeout=60) for future in futures]

        self.assertEqual(sum(1 for row in results if row is not None), 1)

        db = self.SessionLocal()
        try:
            rows = db.query(OidcAuthTransaction).all()
            count = len(rows)
            phases = [row.phase for row in rows]
            consumed = [row.consumed_at is not None for row in rows]
        finally:
            db.close()

        self.assertEqual(count, 1)
        self.assertEqual(phases, [PHASE_HANDOFF])
        self.assertEqual(consumed, [True])

    def test_start_racing_promotion_cannot_leave_redeemable_old_handoff(self):
        db = self.SessionLocal()
        try:
            start_transaction(
                db,
                issuer=ISSUER,
                operation=OPERATION_LOGIN,
                state=OLD_STATE,
                browser_secret=BROWSER,
                nonce="nonce",
                code_verifier="verifier",
                now=NOW,
            )
            claimed = claim_authorization_transaction(
                db, state=OLD_STATE, browser_secret=BROWSER, now=NOW
            )
            self.assertIsNotNone(claimed)
            transaction_id = claimed.id
        finally:
            db.close()

        barrier = threading.Barrier(2, timeout=30)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            start_future = pool.submit(
                self._start_worker, barrier, NEW_STATE
            )
            promote_future = pool.submit(
                self._promote_worker, barrier, transaction_id
            )
            for future in (start_future, promote_future):
                future.result(timeout=60)

        db = self.SessionLocal()
        try:
            rows = db.query(OidcAuthTransaction).all()
            count = len(rows)
            phases = [row.phase for row in rows]
            redeemed = claim_handoff_transaction(
                db,
                handoff_secret=OLD_HANDOFF,
                browser_secret=BROWSER,
                now=NOW,
            )
        finally:
            db.close()

        # Whatever the interleaving, the newer start owns the only row and the
        # old handoff (promoted or never created) is gone and unredeemable.
        self.assertEqual(count, 1)
        self.assertEqual(phases, [PHASE_AUTHORIZATION])
        self.assertIsNone(redeemed)
