import datetime
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.recognize import SCAN_HISTORY_RETENTION_DAYS, purge_expired_scan_history, record_scan_history, serialize_scan_history
from database import Base
from models import ScanHistory, User


class ScanHistoryTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="john", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_record_scan_history_expires_after_14_days_without_owning_card(self):
        now = datetime.datetime(2026, 7, 30, 12, 0, 0)
        entry = record_scan_history(
            self.db,
            user_id=self.user.id,
            source_reference="phone-scan.jpg",
            recognized={"name": "Latias ex", "number": "239/191", "language": "en"},
            matches=[{"id": "sv8-239_en", "name": "Latias ex"}],
            now=now,
        )
        self.db.commit()

        payload = serialize_scan_history(entry)
        self.assertEqual(payload["retention_days"], 14)
        self.assertEqual(payload["recognized_name"], "Latias ex")
        self.assertEqual(payload["top_match_card_id"], "sv8-239_en")
        self.assertEqual(entry.expires_at, now + datetime.timedelta(days=SCAN_HISTORY_RETENTION_DAYS))

    def test_purge_expired_scan_history_only_removes_expired_rows(self):
        now = datetime.datetime(2026, 7, 30, 12, 0, 0)
        expired = ScanHistory(user_id=self.user.id, source="external_scanner", expires_at=now - datetime.timedelta(seconds=1))
        active = ScanHistory(user_id=self.user.id, source="external_scanner", expires_at=now + datetime.timedelta(days=1))
        self.db.add_all([expired, active])
        self.db.commit()

        removed = purge_expired_scan_history(self.db, user_id=self.user.id, now=now)
        self.db.commit()

        self.assertEqual(removed, 1)
        remaining = self.db.query(ScanHistory).all()
        self.assertEqual([row.id for row in remaining], [active.id])


if __name__ == "__main__":
    unittest.main()
