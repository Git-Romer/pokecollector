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
import os
import threading
import unittest

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-provisioning-pg-test-secret")

try:
    import psycopg2  # noqa: F401 - SQLAlchemy's PostgreSQL driver
    from sqlalchemy import text
    from sqlalchemy.orm import sessionmaker

    EXTERNAL_DEPENDENCY_MISSING = False
except ModuleNotFoundError:
    EXTERNAL_DEPENDENCY_MISSING = True

if not EXTERNAL_DEPENDENCY_MISSING:
    from database import Base, migrate_oidc_transaction_schema
    from models import OidcIdentity, User
    from services.oidc_identity import provision_user_for_identity

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


if __name__ == "__main__":
    unittest.main()
