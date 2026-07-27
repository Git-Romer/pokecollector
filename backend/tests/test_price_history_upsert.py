import datetime
import os
import queue
import threading
import time
import unittest
import uuid
from unittest.mock import patch

try:
    from sqlalchemy import create_engine, event, text
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, PriceHistory, SyncLog
    from services.sync_service import (
        PRICE_HISTORY_UPSERT_CHUNK_SIZE,
        perform_price_sync,
        record_price_history_batch,
    )

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


def _card(card_id: str, price: float) -> Card:
    tcg_card_id = card_id.removesuffix("_en")
    return Card(
        id=card_id,
        tcg_card_id=tcg_card_id,
        name=tcg_card_id,
        lang="en",
        price_market=price,
    )


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class RecordPriceHistoryBatchTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)

    def tearDown(self):
        self.engine.dispose()

    def test_empty_batch_is_a_noop(self):
        db = self.Session()
        self.assertEqual(record_price_history_batch(db, []), 0)
        self.assertEqual(db.query(PriceHistory).count(), 0)
        db.close()

    def test_batch_deduplicates_cards_and_existing_daily_rows(self):
        db = self.Session()
        first = _card("sv1-1_en", 1.0)
        second = _card("sv1-2_en", 2.0)
        db.add_all([first, second])

        attempted = record_price_history_batch(db, [second, first, first])
        db.commit()
        self.assertEqual(attempted, 2)

        first.price_market = 9.0
        record_price_history_batch(db, [first, second])
        db.commit()

        rows = db.query(PriceHistory).order_by(PriceHistory.card_id).all()
        self.assertEqual([row.card_id for row in rows], ["sv1-1_en", "sv1-2_en"])
        self.assertEqual(rows[0].price_market, 1.0)
        db.close()

    def test_price_sync_rolls_back_before_recording_database_error(self):
        db = self.Session()
        with patch.object(db, "rollback", wraps=db.rollback) as rollback, \
             patch("services.sync_service.logger.error"), \
             patch(
                 "services.sync_service._price_sync_plan",
                 side_effect=RuntimeError("database write failed"),
             ):
            with self.assertRaisesRegex(RuntimeError, "database write failed"):
                perform_price_sync(db)

        rollback.assert_called_once()
        log = db.query(SyncLog).one()
        self.assertEqual(log.sync_type, "price")
        self.assertEqual(log.status, "error")
        self.assertEqual(log.error_message, "database write failed")
        db.close()

    def test_large_batch_uses_bounded_bulk_statements(self):
        db = self.Session()
        card_count = PRICE_HISTORY_UPSERT_CHUNK_SIZE * 2 + 5
        cards = [
            _card(f"sv1-{index:04d}_en", float(index))
            for index in range(card_count)
        ]
        db.add_all(cards)
        history_inserts = []

        def capture_history_inserts(_conn, _cursor, statement, _parameters, _context, _many):
            if statement.startswith("INSERT INTO price_history"):
                history_inserts.append(statement)

        event.listen(self.engine, "before_cursor_execute", capture_history_inserts)
        try:
            record_price_history_batch(db, reversed(cards))
            db.commit()
        finally:
            event.remove(self.engine, "before_cursor_execute", capture_history_inserts)

        self.assertEqual(len(history_inserts), 3)
        self.assertEqual(db.query(PriceHistory).count(), card_count)
        db.close()


POSTGRES_TEST_URL = os.getenv("TEST_POSTGRES_URL", "")


@unittest.skipUnless(
    DEPS and POSTGRES_TEST_URL.startswith("postgresql"),
    "TEST_POSTGRES_URL is required for PostgreSQL concurrency coverage",
)
class RecordPriceHistoryPostgresConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.schema = f"price_history_test_{uuid.uuid4().hex}"
        self.admin_engine = create_engine(POSTGRES_TEST_URL, isolation_level="AUTOCOMMIT")
        with self.admin_engine.connect() as conn:
            conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))

        self.engine = create_engine(
            POSTGRES_TEST_URL,
            connect_args={"options": f"-csearch_path={self.schema}"},
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)

        db = self.Session()
        db.add_all([_card("sv1-1_en", 1.0), _card("sv1-2_en", 2.0)])
        db.commit()
        db.close()

    def tearDown(self):
        self.engine.dispose()
        with self.admin_engine.connect() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{self.schema}" CASCADE'))
        self.admin_engine.dispose()

    def test_uncommitted_overlapping_batches_wait_then_finish_without_deadlock(self):
        """The second writer must wait, then safely ignore the committed rows.

        Passing the cards in opposite orders also proves the batch helper imposes
        its own stable lock order instead of trusting caller order.
        """
        first_has_written = threading.Event()
        release_first = threading.Event()
        second_lock_attempted = threading.Event()
        second_finished = threading.Event()
        failures = queue.Queue()

        def observe_second_lock(_conn, _cursor, statement, _parameters, _context, _many):
            if (
                threading.current_thread().name == "price-history-second"
                and "pg_advisory_xact_lock" in statement
            ):
                second_lock_attempted.set()

        event.listen(self.engine, "before_cursor_execute", observe_second_lock)

        def write_first():
            db = self.Session()
            try:
                cards = {
                    card.id: card
                    for card in db.query(Card).filter(Card.id.in_(["sv1-1_en", "sv1-2_en"])).all()
                }
                record_price_history_batch(db, [cards["sv1-1_en"], cards["sv1-2_en"]])
                first_has_written.set()
                if not release_first.wait(timeout=5):
                    raise TimeoutError("timed out waiting to release the first transaction")
                db.commit()
            except Exception as exc:
                db.rollback()
                failures.put(exc)
            finally:
                db.close()

        def write_second():
            db = self.Session()
            try:
                if not first_has_written.wait(timeout=5):
                    raise TimeoutError("first transaction never reached its uncommitted insert")
                cards = {
                    card.id: card
                    for card in db.query(Card).filter(Card.id.in_(["sv1-1_en", "sv1-2_en"])).all()
                }
                record_price_history_batch(db, [cards["sv1-2_en"], cards["sv1-1_en"]])
                db.commit()
                second_finished.set()
            except Exception as exc:
                db.rollback()
                failures.put(exc)
            finally:
                db.close()

        first = threading.Thread(target=write_first, name="price-history-first", daemon=True)
        second = threading.Thread(target=write_second, name="price-history-second", daemon=True)
        first.start()
        second.start()

        try:
            self.assertTrue(second_lock_attempted.wait(timeout=5))
            time.sleep(0.2)
            self.assertFalse(
                second_finished.is_set(),
                "second writer did not wait for the uncommitted conflicting batch",
            )
        finally:
            release_first.set()
            first.join(timeout=5)
            second.join(timeout=5)
            event.remove(self.engine, "before_cursor_execute", observe_second_lock)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        if not failures.empty():
            raise failures.get()

        db = self.Session()
        rows = db.query(PriceHistory).filter(
            PriceHistory.date == datetime.date.today()
        ).order_by(PriceHistory.card_id).all()
        self.assertEqual([row.card_id for row in rows], ["sv1-1_en", "sv1-2_en"])
        db.close()


if __name__ == "__main__":
    unittest.main()
