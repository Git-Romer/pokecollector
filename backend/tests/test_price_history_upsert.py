import datetime
import os
import tempfile
import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    from models import Card, PriceHistory
    from services.sync_service import record_price_history
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class RecordPriceHistoryConcurrencyTests(unittest.TestCase):
    def setUp(self):
        # A real file (not sqlite:///:memory:) so two independent sessions see
        # each other's commits, like two DB connections from two processes.
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.engine = create_engine(f"sqlite:///{self.db_path}")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)

        session = self.Session()
        session.add(Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Bulbasaur",
                          set_id="sv1", lang="en", price_market=1.0))
        session.commit()
        session.close()

    def tearDown(self):
        os.remove(self.db_path)

    def test_second_session_recording_already_committed_day_does_not_crash(self):
        # perform_price_sync has no lock guarding it against perform_full_sync
        # (only full-vs-full syncs are guarded), and both accumulate their
        # whole batch in one session that commits once at the end of a run
        # that can take 15+ minutes. A session that started before another
        # session committed today's row for this card must still be able to
        # record its own (now-redundant) price without crashing the rest of
        # its batch -- this is what the old SELECT-then-INSERT could not do
        # when the other session's commit landed in between.
        session_a = self.Session()
        card_a = session_a.query(Card).filter(Card.id == "sv1-1_en").first()
        record_price_history(session_a, card_a)
        session_a.commit()

        session_b = self.Session()
        card_b = session_b.query(Card).filter(Card.id == "sv1-1_en").first()
        record_price_history(session_b, card_b)
        session_b.commit()  # must not raise UniqueViolation on (card_id, date)

        session_c = self.Session()
        rows = session_c.query(PriceHistory).filter(
            PriceHistory.card_id == "sv1-1_en",
            PriceHistory.date == datetime.date.today(),
        ).all()
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
