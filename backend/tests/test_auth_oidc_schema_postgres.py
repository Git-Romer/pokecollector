"""Real PostgreSQL evidence for the P2 authentication schema.

This suite is destructive: each test drops and recreates the ``public`` schema.
It therefore ignores the application ``DATABASE_URL`` and requires a dedicated,
disposable scratch database:

    OIDC_AUTH_POSTGRES_TEST=1 \
    OIDC_AUTH_TEST_DATABASE_URL=postgresql://...@127.0.0.1:<port>/oidc_auth_test_<32 lowercase hex> \
    backend/.venv/bin/python -m unittest discover -s tests -p 'test_auth_oidc_schema_postgres.py'

The URL must use PostgreSQL, a literal loopback host (127.0.0.1, ::1 or
localhost), an explicit port, and a database named exactly
``oidc_auth_test_<32 lowercase hex>``. Before the first DROP, the guard also
verifies ``SELECT current_database()`` matches that name. Setting the opt-in
with a missing or unsafe configuration is a hard failure, never a skip.

Optional skipping is limited to a missing third-party package (see
:data:`EXTERNAL_DEPENDENCY_ROOTS`). With ``OIDC_AUTH_POSTGRES_TEST=1`` such a
missing package is a hard ``RuntimeError`` at collection. A missing project
module (``database``, ``models``, ``services.*``, ``api.*``) always fails the
import, opted in or not, so a broken checkout cannot look like a clean skip.
"""
import concurrent.futures
import os
import re
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
    from fastapi import HTTPException
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import ArgumentError, IntegrityError
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
    import database
    from api.auth import UpdateUserRequest, delete_user, update_user
    from database import Base, init_db, migrate_oidc_auth_schema
    from models import Card, CollectionItem, OidcIdentity, User
    from services.auth import hash_password, verify_password
    from services.auth_admin import count_usable_admins
    from services.auth_policy import AuthPolicy


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


@unittest.skipUnless(
    POSTGRES_TEST_ENABLED,
    "requires OIDC_AUTH_POSTGRES_TEST=1 and a disposable PostgreSQL scratch database",
)
class OidcAuthSchemaPostgresTests(unittest.TestCase):
    engine = None
    SessionLocal = None

    @classmethod
    def setUpClass(cls):
        cls.engine = build_test_engine()
        approved_name = require_safe_test_database_url(str(cls.engine.url))
        cls._started_patchers = []
        try:
            with cls.engine.connect() as connection:
                assert_connected_database(connection, approved_name)
            cls.SessionLocal = sessionmaker(
                autocommit=False, autoflush=False, bind=cls.engine
            )
            # Route production helpers such as init_db() through the scratch
            # engine only after the URL and live connection have been approved.
            for patcher in (
                patch.object(database, "engine", cls.engine),
                patch.object(database, "SessionLocal", cls.SessionLocal),
            ):
                patcher.start()
                cls._started_patchers.append(patcher)
        except BaseException:
            for patcher in reversed(cls._started_patchers):
                patcher.stop()
            cls.engine.dispose()
            raise

    @classmethod
    def tearDownClass(cls):
        for patcher in reversed(getattr(cls, "_started_patchers", [])):
            patcher.stop()
        if cls.engine is not None:
            cls.engine.dispose()

    def setUp(self):
        reset_public_schema(self.engine)

    def _user(self, db, username, password="password", role="trainer", active=True):
        user = User(
            username=username,
            hashed_password=hash_password(password) if password else None,
            role=role,
            is_active=active,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def _identity(self, db, user, subject=None, issuer="https://idp.example.test"):
        identity = OidcIdentity(
            issuer=issuer,
            subject=subject or f"{user.username}-subject",
            user_id=user.id,
        )
        db.add(identity)
        db.commit()
        return identity

    def test_legacy_upgrade_preserves_ids_hashes_and_ownership_and_is_idempotent(self):
        # Start from the pre-P2 shape: users require a password and no identity
        # table exists yet. Metadata.create_all models a fresh install otherwise.
        Base.metadata.create_all(self.engine)
        with self.engine.begin() as conn:
            conn.execute(
                text("ALTER TABLE users ALTER COLUMN hashed_password SET NOT NULL")
            )
            conn.execute(text("DROP TABLE oidc_identities"))

        db = self.SessionLocal()
        try:
            owner = self._user(db, "legacy-owner", password="legacy-password", role="admin")
            card = Card(id="p2-legacy-card_en", name="Legacy card", lang="en")
            db.add(card)
            db.flush()
            item = CollectionItem(
                user_id=owner.id,
                card_id=card.id,
                quantity=3,
                condition="NM",
                variant="Normal",
                lang="en",
            )
            db.add(item)
            db.commit()
            owner_id = owner.id
            owner_hash = owner.hashed_password
            item_id = item.id
        finally:
            db.close()

        # The focused migration, not the legacy swallowing loop, must repair the
        # schema. It is then run again through init_db() to prove idempotency.
        migrate_oidc_auth_schema(self.engine)
        init_db()
        init_db()

        with self.engine.connect() as conn:
            nullable = conn.execute(text("""
                SELECT is_nullable FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'hashed_password'
            """)).scalar()
            constraints = {
                row[0]
                for row in conn.execute(text("""
                    SELECT conname FROM pg_constraint
                    WHERE conrelid = 'oidc_identities'::regclass
                      AND contype = 'u'
                """))
            }
            cascade = conn.execute(text("""
                SELECT confdeltype FROM pg_constraint
                WHERE conrelid = 'oidc_identities'::regclass
                  AND contype = 'f'
                  AND confrelid = 'users'::regclass
            """)).scalar()

        self.assertEqual(nullable, "YES")
        self.assertEqual(
            constraints,
            {"uq_oidc_identity_issuer_subject", "uq_oidc_identity_issuer_user"},
        )
        self.assertEqual(cascade, "c")

        db = self.SessionLocal()
        try:
            owner = db.query(User).filter(User.id == owner_id).one()
            self.assertEqual(owner.hashed_password, owner_hash)
            self.assertTrue(verify_password("legacy-password", owner.hashed_password))
            self.assertEqual(db.query(User).count(), 1)
            item = db.query(CollectionItem).filter(CollectionItem.id == item_id).one()
            self.assertEqual(item.user_id, owner_id)
        finally:
            db.close()

    def test_init_db_propagates_auth_schema_failure_instead_of_swallowing_it(self):
        # The legacy _run_migrations loop catches every error. The auth schema
        # boundary must not: a broken/partial schema has to abort startup.
        with patch(
            "database.migrate_oidc_auth_schema",
            side_effect=RuntimeError("synthetic auth schema failure"),
        ):
            with self.assertRaises(RuntimeError) as exc:
                init_db()
        self.assertIn("synthetic auth schema failure", str(exc.exception))

    def test_identity_uniqueness_and_fk_cascade(self):
        init_db()
        db = self.SessionLocal()
        try:
            first = self._user(db, "first")
            second = self._user(db, "second")
            self._identity(db, first, subject="shared-subject")

            db.add(
                OidcIdentity(
                    issuer="https://idp.example.test",
                    subject="shared-subject",
                    user_id=second.id,
                )
            )
            with self.assertRaises(IntegrityError):
                db.commit()
            db.rollback()

            db.add(
                OidcIdentity(
                    issuer="https://idp.example.test",
                    subject="second-subject",
                    user_id=first.id,
                )
            )
            with self.assertRaises(IntegrityError):
                db.commit()
            db.rollback()

            # Same issuer+subject under a different issuer is a distinct identity.
            self._identity(db, second, subject="shared-subject", issuer="https://other.example.test")

            with self.engine.begin() as conn:
                conn.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": first.id})
            self.assertEqual(
                db.query(OidcIdentity).filter(OidcIdentity.user_id == first.id).count(),
                0,
            )
        finally:
            db.close()

    def test_user_deletion_removes_identity_and_preserves_other_ownership(self):
        init_db()
        db = self.SessionLocal()
        try:
            caller = self._user(db, "caller", password="caller-password", role="admin")
            target = self._user(db, "target", password="target-password")
            other = self._user(db, "other", password="other-password")
            self._identity(db, target)

            card = Card(id="p2-delete-card_en", name="Delete card", lang="en")
            db.add(card)
            db.flush()
            target_item = CollectionItem(
                user_id=target.id,
                card_id=card.id,
                quantity=1,
                condition="NM",
                variant="Normal",
                lang="en",
            )
            other_item = CollectionItem(
                user_id=other.id,
                card_id=card.id,
                quantity=2,
                condition="NM",
                variant="Normal",
                lang="en",
            )
            db.add_all([target_item, other_item])
            db.commit()
            target_id = target.id
            other_id = other.id
            other_item_id = other_item.id
        finally:
            db.close()

        db = self.SessionLocal()
        try:
            caller = db.query(User).filter(User.username == "caller").one()
            with patch("services.scan_trace.revoke_user_traces"):
                result = delete_user(target_id, current_user=caller, db=db)
            self.assertEqual(result, {"message": "User deleted"})
            self.assertIsNone(db.query(User).filter(User.id == target_id).first())
            self.assertEqual(
                db.query(OidcIdentity).filter(OidcIdentity.user_id == target_id).count(),
                0,
            )
            remaining = db.query(CollectionItem).filter(CollectionItem.id == other_item_id).one()
            self.assertEqual(remaining.user_id, other_id)
        finally:
            db.close()

    def test_concurrent_admin_demotions_cannot_remove_the_last_usable_admin(self):
        init_db()
        db = self.SessionLocal()
        try:
            first = self._user(db, "first-admin", password="first-password", role="admin")
            second = self._user(db, "second-admin", password="second-password", role="admin")
            first_id, second_id = first.id, second.id
        finally:
            db.close()

        barrier = threading.Barrier(2)
        SessionLocal = self.SessionLocal

        def demote(user_id):
            session = SessionLocal()
            try:
                user = session.query(User).filter(User.id == user_id).one()
                barrier.wait(timeout=10)
                try:
                    update_user(
                        user_id,
                        UpdateUserRequest(role="trainer"),
                        current_user=user,
                        db=session,
                    )
                    return "ok"
                except HTTPException as exc:
                    return exc.status_code
            finally:
                session.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(demote, [first_id, second_id]))

        self.assertEqual(sorted(results, key=str), [400, "ok"])

        db = self.SessionLocal()
        try:
            admins = db.query(User).filter(User.role == "admin").all()
            self.assertEqual(len(admins), 1)
            self.assertTrue(admins[0].is_active)
            policy = AuthPolicy(auth_mode="local", oidc=None)
            self.assertEqual(count_usable_admins(db, policy), 1)
        finally:
            db.close()


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _RecordingConnection:
    def __init__(self, engine):
        self._engine = engine

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def execute(self, statement, *args, **kwargs):
        self._engine.statements.append(str(statement))
        return _ScalarResult(self._engine.current_database)


class _RecordingEngine:
    """Mock engine that records whether a connection or DROP was attempted."""

    def __init__(self, url_value, current_database="ignored"):
        self.url = make_url(url_value)
        self.dialect = SimpleNamespace(name=self.url.get_backend_name())
        self.current_database = current_database
        self.statements = []
        self.connect_calls = 0
        self.begin_calls = 0

    def connect(self):
        self.connect_calls += 1
        return _RecordingConnection(self)

    def begin(self):
        self.begin_calls += 1
        return _RecordingConnection(self)


@unittest.skipUnless(DEPS_AVAILABLE, "requires third-party test dependencies")
class OidcAuthTestDatabaseGuardTests(unittest.TestCase):
    approved_name = "oidc_auth_test_" + "0123456789abcdef" * 2

    def _url(self, host="127.0.0.1", port=55432, database=None):
        database = self.approved_name if database is None else database
        host_part = f"[{host}]" if ":" in host else host
        return f"postgresql+psycopg2://scratch:scratch@{host_part}:{port}/{database}"

    def test_accepts_only_approved_loopback_scratch_database(self):
        for host in ("127.0.0.1", "localhost", "::1"):
            with self.subTest(host=host):
                self.assertEqual(
                    require_safe_test_database_url(self._url(host=host)),
                    self.approved_name,
                )

    def test_rejects_unsafe_database_names(self):
        unsafe_names = (
            "pokemon_tcg",
            "oidc_auth_test",
            "oidc_auth_test_" + "A" * 32,
            "oidc_auth_test_" + "a" * 31,
            "oidc_auth_test_" + "a" * 33,
            "oidc_auth_test_" + "g" * 32,
            "oidc_auth_test_" + "a" * 32 + "_extra",
        )
        for name in unsafe_names:
            with self.subTest(name=name):
                with self.assertRaises(UnsafeTestDatabaseError):
                    require_safe_test_database_url(self._url(database=name))

    def test_rejects_non_literal_or_remote_hosts(self):
        remote_hosts = (
            "db.example.test",
            "10.0.0.5",
            "0.0.0.0",
            "127.0.0.2",
            "localhost.example.test",
            "::2",
        )
        for host in remote_hosts:
            with self.subTest(host=host):
                with self.assertRaises(UnsafeTestDatabaseError):
                    require_safe_test_database_url(self._url(host=host))

    def test_rejects_missing_host_database_or_port(self):
        missing_target = (
            "postgresql+psycopg2://scratch:scratch@127.0.0.1:55432",
            "postgresql+psycopg2://scratch:scratch@127.0.0.1:55432/",
            "postgresql+psycopg2://scratch:scratch@:55432/" + self.approved_name,
            "postgresql+psycopg2:///" + self.approved_name,
            f"postgresql+psycopg2://scratch:scratch@127.0.0.1/{self.approved_name}",
        )
        for url_value in missing_target:
            with self.subTest(url=url_value):
                with self.assertRaises(UnsafeTestDatabaseError):
                    require_safe_test_database_url(url_value)

    def test_rejects_non_postgresql_urls(self):
        for url_value in (
            f"sqlite:///tmp/{self.approved_name}.db",
            f"mysql+pymysql://scratch:scratch@127.0.0.1:3306/{self.approved_name}",
        ):
            with self.subTest(url=url_value):
                with self.assertRaises(UnsafeTestDatabaseError):
                    require_safe_test_database_url(url_value)

    def test_rejects_query_parameter_connection_overrides(self):
        for query in (
            "host=evil.example.test",
            "hostaddr=10.0.0.5",
            "port=5432",
            "dbname=postgres",
            "service=prod",
            "dsn=prod",
        ):
            with self.subTest(query=query):
                with self.assertRaises(UnsafeTestDatabaseError):
                    require_safe_test_database_url(f"{self._url()}?{query}")

    def test_missing_dedicated_url_fails_before_engine_creation(self):
        # The application DATABASE_URL is not a fallback, even when it is set.
        env = {
            TEST_DATABASE_URL_ENV: "",
            "DATABASE_URL": "postgresql://pokemon:changeme@127.0.0.1:5432/pokemon_tcg",
        }
        with patch.dict(os.environ, env):
            with patch.object(sys.modules[__name__], "create_engine") as engine_factory:
                with self.assertRaises(UnsafeTestDatabaseError) as ctx:
                    build_test_engine()
        engine_factory.assert_not_called()
        self.assertIn(TEST_DATABASE_URL_ENV, str(ctx.exception))

    def test_unsafe_url_fails_before_engine_creation(self):
        unsafe = f"postgresql://scratch:scratch@db.example.test:5432/{self.approved_name}"
        with patch.dict(os.environ, {TEST_DATABASE_URL_ENV: unsafe}):
            with patch.object(sys.modules[__name__], "create_engine") as engine_factory:
                with self.assertRaises(UnsafeTestDatabaseError):
                    build_test_engine()
        engine_factory.assert_not_called()

    def test_unsafe_engine_is_rejected_before_connection_or_drop(self):
        engine = _RecordingEngine(
            f"postgresql://scratch:scratch@db.example.test:5432/{self.approved_name}"
        )
        with self.assertRaises(UnsafeTestDatabaseError):
            reset_public_schema(engine)
        self.assertEqual(engine.connect_calls, 0)
        self.assertEqual(engine.begin_calls, 0)
        self.assertEqual(engine.statements, [])

    def test_non_postgresql_engine_is_rejected_before_connection(self):
        engine = _RecordingEngine(f"sqlite:///tmp/{self.approved_name}.db")
        with self.assertRaises(UnsafeTestDatabaseError):
            reset_public_schema(engine)
        self.assertEqual(engine.connect_calls, 0)
        self.assertEqual(engine.begin_calls, 0)
        self.assertEqual(engine.statements, [])

    def test_connected_database_mismatch_aborts_before_drop(self):
        engine = _RecordingEngine(self._url(), current_database="pokemon_tcg")
        with self.assertRaises(UnsafeTestDatabaseError) as ctx:
            reset_public_schema(engine)
        self.assertIn("pokemon_tcg", str(ctx.exception))
        self.assertEqual(engine.begin_calls, 1)
        self.assertTrue(
            any("current_database()" in statement for statement in engine.statements)
        )
        self.assertFalse(
            any("DROP SCHEMA" in statement.upper() for statement in engine.statements)
        )
        self.assertFalse(
            any("CREATE SCHEMA" in statement.upper() for statement in engine.statements)
        )

    def test_every_rejected_target_never_connects_or_drops(self):
        targets = (
            self._url(database="pokemon_tcg"),
            self._url(host="10.0.0.5"),
            "postgresql+psycopg2://scratch:scratch@127.0.0.1:55432",
            f"postgresql+psycopg2://scratch:scratch@127.0.0.1/{self.approved_name}",
            f"sqlite:///tmp/{self.approved_name}.db",
        )
        for url_value in targets:
            with self.subTest(url=url_value):
                engine = _RecordingEngine(url_value)
                with self.assertRaises(UnsafeTestDatabaseError):
                    reset_public_schema(engine)
                self.assertEqual(engine.connect_calls, 0)
                self.assertEqual(engine.begin_calls, 0)
                self.assertEqual(engine.statements, [])

    def test_approved_engine_resets_public_schema(self):
        engine = _RecordingEngine(self._url(), current_database=self.approved_name)
        reset_public_schema(engine)
        self.assertTrue(
            any(
                "DROP SCHEMA IF EXISTS public CASCADE" in statement
                for statement in engine.statements
            )
        )


_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REGRESSION_CHILD_ENV = "OIDC_AUTH_IMPORT_REGRESSION_CHILD"

# Runs the real test module through unittest discovery in a child interpreter
# with one import root blocked. Any escape means collection failed; exit status
# therefore distinguishes a hard collection failure from an all-skipped "OK".
_DISCOVERY_PROBE = '''
import sys
import unittest

blocked_root = sys.argv[1]


class _BlockedModuleFinder:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == blocked_root or fullname.startswith(blocked_root + "."):
            raise ModuleNotFoundError(f"No module named {fullname!r}", name=fullname)
        return None


sys.meta_path.insert(0, _BlockedModuleFinder())
suite = unittest.TestLoader().discover(
    "tests", pattern="test_auth_oidc_schema_postgres.py"
)
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
'''


@unittest.skipIf(
    os.environ.get(_REGRESSION_CHILD_ENV) == "1",
    "the discovery subprocess must not recurse into these regressions",
)
class OidcAuthImportCollectionRegressionTests(unittest.TestCase):
    """Prove collection-time import behaviour in a real child interpreter."""

    maxDiff = None

    def _run_discovery(self, blocked_root, opt_in):
        env = {
            key: value
            for key, value in os.environ.items()
            if key
            not in (
                TEST_DATABASE_URL_ENV,
                DESTRUCTIVE_TEST_OPT_IN_ENV,
                "DATABASE_URL",
                _REGRESSION_CHILD_ENV,
            )
        }
        # No database target is ever passed to the child, so no engine can be
        # built and no schema can be reset even if a class were mis-collected.
        env[_REGRESSION_CHILD_ENV] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if opt_in:
            env[DESTRUCTIVE_TEST_OPT_IN_ENV] = "1"
        return subprocess.run(
            [sys.executable, "-c", _DISCOVERY_PROBE, blocked_root],
            cwd=str(_BACKEND_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

    @staticmethod
    def _output(completed):
        return completed.stdout + completed.stderr

    def test_missing_project_module_fails_collection_instead_of_skipping(self):
        completed = self._run_discovery("database", opt_in=False)
        output = self._output(completed)
        self.assertNotEqual(completed.returncode, 0, output)
        self.assertIn("ModuleNotFoundError", output)
        self.assertIn("'database'", output)
        # An all-skipped suite exits 0 with an "OK (skipped=...)" line.
        self.assertNotIn("OK (skipped", output)

    def test_opted_in_missing_external_dependency_fails_loudly(self):
        completed = self._run_discovery("sqlalchemy", opt_in=True)
        output = self._output(completed)
        self.assertNotEqual(completed.returncode, 0, output)
        self.assertIn("RuntimeError", output)
        self.assertIn("requires the PostgreSQL test dependencies", output)
        self.assertIn("'sqlalchemy'", output)
        self.assertNotIn("OK (skipped", output)

    def test_unopted_missing_external_dependency_still_skips_cleanly(self):
        completed = self._run_discovery("sqlalchemy", opt_in=False)
        output = self._output(completed)
        self.assertEqual(completed.returncode, 0, output)
        self.assertIn("skipped", output)


if __name__ == "__main__":
    unittest.main()
