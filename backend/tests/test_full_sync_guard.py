import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import SyncLog
    from services.sync_service import (
        FULL_SYNC_ADVISORY_LOCK_ID,
        FULL_SYNC_STALE_AFTER,
        _full_sync_lock,
        _full_sync_in_progress,
        perform_full_sync,
    )
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class FullSyncGuardTests(unittest.TestCase):
    """A full sync must skip if another full sync is already running, so two
    overlapping runs cannot race and collide on card primary keys. Stale
    'running' rows (left by a crash/restart) must NOT block forever.
    """

    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False)()

    def _running_full(self, minutes_ago):
        return SyncLog(
            sync_type="full",
            status="running",
            started_at=datetime.datetime.utcnow() - datetime.timedelta(minutes=minutes_ago),
        )

    def test_no_rows_not_in_progress(self):
        self.assertFalse(_full_sync_in_progress(self._db()))

    def test_recent_running_full_blocks(self):
        db = self._db()
        db.add(self._running_full(minutes_ago=1))
        db.commit()
        self.assertTrue(_full_sync_in_progress(db))

    def test_stale_running_full_does_not_block(self):
        db = self._db()
        stale_minutes = int(FULL_SYNC_STALE_AFTER.total_seconds() // 60) + 5
        db.add(self._running_full(minutes_ago=stale_minutes))
        db.commit()
        self.assertFalse(_full_sync_in_progress(db))

    def test_running_price_sync_does_not_block_full(self):
        db = self._db()
        db.add(SyncLog(sync_type="price", status="running", started_at=datetime.datetime.utcnow()))
        db.commit()
        self.assertFalse(_full_sync_in_progress(db))

    def test_finished_full_does_not_block(self):
        db = self._db()
        now = datetime.datetime.utcnow()
        db.add(SyncLog(sync_type="full", status="success", started_at=now, finished_at=now))
        db.commit()
        self.assertFalse(_full_sync_in_progress(db))

    def test_perform_full_sync_skips_without_new_row_or_network(self):
        # A recent running full sync exists -> perform_full_sync must short-circuit
        # BEFORE creating its own log row or doing any network work.
        db = self._db()
        db.add(self._running_full(minutes_ago=1))
        db.commit()
        before = db.query(SyncLog).count()
        result = perform_full_sync(db)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(db.query(SyncLog).count(), before)

    def test_postgres_advisory_lock_is_released(self):
        conn = FakeLockConnection(acquire_result=True)
        db = FakePostgresDb(conn)

        with _full_sync_lock(db) as acquired:
            self.assertTrue(acquired)

        self.assertEqual(
            conn.statements,
            [
                ("SELECT pg_try_advisory_lock(:lock_id)", {"lock_id": FULL_SYNC_ADVISORY_LOCK_ID}),
                ("SELECT pg_advisory_unlock(:lock_id)", {"lock_id": FULL_SYNC_ADVISORY_LOCK_ID}),
            ],
        )
        self.assertTrue(conn.closed)

    def test_postgres_advisory_lock_busy_skips_without_unlock(self):
        conn = FakeLockConnection(acquire_result=False)
        db = FakePostgresDb(conn)

        with _full_sync_lock(db) as acquired:
            self.assertFalse(acquired)

        self.assertEqual(
            conn.statements,
            [("SELECT pg_try_advisory_lock(:lock_id)", {"lock_id": FULL_SYNC_ADVISORY_LOCK_ID})],
        )
        self.assertTrue(conn.closed)
        self.assertFalse(conn.invalidated)

    def test_postgres_advisory_lock_invalidates_connection_when_unlock_fails(self):
        conn = FakeLockConnection(acquire_result=True, unlock_raises=True)
        db = FakePostgresDb(conn)

        with patch("services.sync_service.logger.exception") as log_exception:
            with _full_sync_lock(db) as acquired:
                self.assertTrue(acquired)

        log_exception.assert_called_once()
        self.assertTrue(conn.invalidated)
        self.assertTrue(conn.closed)

    def test_postgres_advisory_lock_invalidates_connection_when_unlock_returns_false(self):
        conn = FakeLockConnection(acquire_result=True, unlock_result=False)
        db = FakePostgresDb(conn)

        with patch("services.sync_service.logger.warning") as log_warning:
            with _full_sync_lock(db) as acquired:
                self.assertTrue(acquired)

        log_warning.assert_called_once()
        self.assertTrue(conn.invalidated)
        self.assertTrue(conn.closed)

    def test_perform_full_sync_rolls_back_before_marking_log_error(self):
        db = self._db()
        with patch.object(db, "rollback", wraps=db.rollback) as rollback, \
             patch("services.sync_service.logger.error"), \
             patch("services.sync_service._get_tcgdex_sync_languages", return_value=["en"]), \
             patch("services.sync_service.digital_sets_enabled", return_value=False), \
             patch("services.sync_service.refresh_digital_catalogue_flags", return_value={"sets_marked": 0, "cards_marked": 0}), \
             patch("services.sync_service.get_pinned_set_language_pairs", return_value=set()), \
             patch("services.sync_service.pokemon_api.get_all_sets", side_effect=RuntimeError("catalogue failed")):
            with self.assertRaises(RuntimeError):
                perform_full_sync(db)

        rollback.assert_called_once()
        log = db.query(SyncLog).one()
        self.assertEqual(log.sync_type, "full")
        self.assertEqual(log.status, "error")
        self.assertEqual(log.error_message, "catalogue failed")


class FakeResult:
    def __init__(self, value):
        self.value = value

    def scalar(self):
        return self.value


class FakeLockConnection:
    def __init__(self, acquire_result, unlock_result=True, unlock_raises=False):
        self.acquire_result = acquire_result
        self.unlock_result = unlock_result
        self.unlock_raises = unlock_raises
        self.statements = []
        self.closed = False
        self.invalidated = False

    def execute(self, statement, params):
        sql = str(statement)
        self.statements.append((sql, params))
        if "pg_try_advisory_lock" in sql:
            return FakeResult(self.acquire_result)
        if "pg_advisory_unlock" in sql:
            if self.unlock_raises:
                raise RuntimeError("unlock failed")
            return FakeResult(self.unlock_result)
        raise AssertionError(f"Unexpected SQL: {sql}")

    def invalidate(self):
        self.invalidated = True

    def close(self):
        self.closed = True


class FakePostgresDialect:
    name = "postgresql"


class FakePostgresBind:
    dialect = FakePostgresDialect()

    def __init__(self, conn):
        self.conn = conn

    def connect(self):
        return self.conn


class FakePostgresDb:
    def __init__(self, conn):
        self.bind = FakePostgresBind(conn)

    def get_bind(self):
        return self.bind


if __name__ == "__main__":
    unittest.main()
