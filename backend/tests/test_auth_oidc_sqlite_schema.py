"""Local-mode startup must not require the OIDC schema.

OIDC identity support needs ``users.hashed_password`` to be nullable so an
SSO-only account can exist. SQLite cannot drop a NOT NULL constraint in place,
so a database kept from an earlier release must still start in local mode;
enabling OIDC against it fails with the actionable migration message instead of
aborting an otherwise valid local deployment.
"""
import os
import re
import unittest
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET_KEY", "focused-oidc-sqlite-gate-test-secret")

try:
    # Third-party dependencies only; internal import errors below must fail.
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

if DEPS_AVAILABLE:
    import database
    from models import Base


@unittest.skipUnless(
    DEPS_AVAILABLE,
    "backend dependencies (sqlalchemy) are not installed",
)
class LegacySqliteStartupTests(unittest.TestCase):
    """A pre-OIDC SQLite database starts locally and refuses OIDC explicitly."""

    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self._restore_legacy_password_constraint()
        self.SessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=self.engine
        )
        for patcher in (
            patch.object(database, "engine", self.engine),
            patch.object(database, "SessionLocal", self.SessionLocal),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.engine.dispose)

    def _restore_legacy_password_constraint(self):
        """Rebuild ``users`` with the NOT NULL password an older release had."""
        with self.engine.begin() as conn:
            ddl = conn.execute(
                text(
                    "SELECT sql FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'users'"
                )
            ).scalar()
            self.assertIn("hashed_password", ddl)
            legacy_ddl = ddl.replace(
                "CREATE TABLE users (", "CREATE TABLE users_legacy (", 1
            )
            # SQLite reports the column type without its length suffix.
            legacy_ddl, replacements = re.subn(
                r"hashed_password VARCHAR",
                "hashed_password VARCHAR NOT NULL",
                legacy_ddl,
                count=1,
            )
            self.assertEqual(replacements, 1)
            conn.exec_driver_sql(legacy_ddl)
            conn.exec_driver_sql("DROP TABLE users")
            conn.exec_driver_sql("ALTER TABLE users_legacy RENAME TO users")

    def _hashed_password_is_not_null(self):
        with self.engine.connect() as conn:
            columns = {
                row[1]: row
                for row in conn.execute(text("PRAGMA table_info(users)"))
            }
        return bool(columns["hashed_password"][3])

    def test_local_mode_startup_accepts_a_legacy_sqlite_database(self):
        self.assertTrue(
            self._hashed_password_is_not_null(),
            "fixture must start from the legacy NOT NULL shape",
        )

        # No OIDC policy: the schema below is irrelevant and must not be changed.
        database.init_db()

        self.assertTrue(
            self._hashed_password_is_not_null(),
            "local-mode startup must not rewrite the password constraint",
        )

    def test_enabling_oidc_on_a_legacy_sqlite_database_fails_explicitly(self):
        with self.assertRaises(RuntimeError) as raised:
            database.init_db(enable_oidc_schema=True)

        message = str(raised.exception)
        self.assertIn("users.hashed_password is NOT NULL", message)
        self.assertIn("PostgreSQL", message)
        # The local database was not left half-migrated.
        self.assertTrue(self._hashed_password_is_not_null())

    def test_oidc_migrations_only_run_when_requested(self):
        with patch.object(database, "migrate_oidc_auth_schema") as auth_schema, \
                patch.object(database, "migrate_oidc_transaction_schema") as tx_schema:
            database.init_db()
            auth_schema.assert_not_called()
            tx_schema.assert_not_called()

            database.init_db(enable_oidc_schema=True)
            auth_schema.assert_called_once_with()
            tx_schema.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
