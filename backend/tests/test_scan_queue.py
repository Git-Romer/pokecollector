import datetime
import os
import tempfile
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import ScanJob, ScanJobItem, ScanQueueUserState, User
    from services import scan_queue, scan_storage
    from services.scan_queue import (
        ClaimedScanItem,
        claim_next_scan_item,
        complete_claim,
        fail_claim,
        purge_expired_scan_jobs,
        recover_expired_leases,
        resolve_scan_item,
    )

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class ScanQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": self.temp_dir.name})
        self.env.start()
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.users = [
            User(username="queue-a", hashed_password="x"),
            User(username="queue-b", hashed_password="x"),
        ]
        self.db.add_all(self.users)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def _job(self, user, *, positions=(0,), created_at=None, expires_at=None):
        now = created_at or datetime.datetime.utcnow()
        job = ScanJob(
            user_id=user.id,
            status="pending",
            created_at=now,
            updated_at=now,
            expires_at=expires_at or now + datetime.timedelta(days=14),
        )
        self.db.add(job)
        self.db.flush()
        if self.db.get(ScanQueueUserState, user.id) is None:
            self.db.add(ScanQueueUserState(user_id=user.id))
        for position in positions:
            self.db.add(
                ScanJobItem(
                    job_id=job.id,
                    user_id=user.id,
                    position=position,
                    image_path=f"{job.id}/{position}.jpg",
                    content_type="image/jpeg",
                    byte_size=4,
                    status="pending",
                    resolved=False,
                    attempts=0,
                    transient_failures=0,
                    next_attempt_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )
        self.db.commit()
        return job

    def test_dispatch_rotates_between_users(self):
        self._job(self.users[0], positions=(0, 1))
        self._job(self.users[1], positions=(0,))

        first = claim_next_scan_item(self.db)
        first_item = self.db.get(ScanJobItem, first.item_id)
        self.assertEqual(first_item.user_id, self.users[0].id)
        complete_claim(self.db, first, {"recognized": {"name": "A"}, "matches": []})

        second = claim_next_scan_item(self.db)
        second_item = self.db.get(ScanJobItem, second.item_id)
        self.assertEqual(second_item.user_id, self.users[1].id)

    def test_stale_lease_cannot_complete_an_item(self):
        self._job(self.users[0])
        claim = claim_next_scan_item(self.db)

        self.assertFalse(
            complete_claim(
                self.db,
                ClaimedScanItem(item_id=claim.item_id, lease_token="wrong"),
                {"recognized": {}, "matches": []},
            )
        )
        self.assertTrue(complete_claim(self.db, claim, {"recognized": {}, "matches": []}))

    def test_expired_processing_lease_is_recovered(self):
        self._job(self.users[0])
        claim = claim_next_scan_item(self.db)
        item = self.db.get(ScanJobItem, claim.item_id)
        item.lease_expires_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
        self.db.commit()

        self.assertEqual(recover_expired_leases(self.db), 1)
        self.db.refresh(item)
        self.assertEqual(item.status, "retrying")
        self.assertIsNone(item.lease_token)

    def test_transient_failure_does_not_consume_recognition_attempts(self):
        self._job(self.users[0])
        claim = claim_next_scan_item(self.db)

        fail_claim(self.db, claim, "429", transient=True)
        item = self.db.get(ScanJobItem, claim.item_id)
        self.assertEqual(item.status, "retrying")
        self.assertEqual(item.attempts, 0)
        self.assertEqual(item.transient_failures, 1)

    def test_recognition_failure_stops_after_three_attempts(self):
        self._job(self.users[0])
        item = self.db.query(ScanJobItem).one()
        for expected in (1, 2, 3):
            item.status = "pending"
            item.next_attempt_at = datetime.datetime.utcnow()
            self.db.commit()
            claim = claim_next_scan_item(self.db)
            fail_claim(self.db, claim, "unreadable", transient=False)
            item = self.db.get(ScanJobItem, item.id)
            self.assertEqual(item.attempts, expected)
        self.assertEqual(item.status, "failed")

    def test_resolve_removes_the_review_photo_immediately(self):
        job = self._job(self.users[0])
        item = self.db.query(ScanJobItem).one()
        job_dir = scan_storage.scan_upload_root() / str(job.id)
        job_dir.mkdir()
        image = job_dir / "0.jpg"
        image.write_bytes(b"jpeg")
        item.image_path = f"{job.id}/0.jpg"
        item.status = "done"
        self.db.commit()

        resolve_scan_item(self.db, item)

        self.assertFalse(image.exists())
        self.assertTrue(item.resolved)
        self.assertIsNone(item.image_path)

    def test_expiry_removes_active_jobs_and_every_photo_after_fourteen_days(self):
        old = datetime.datetime.utcnow() - datetime.timedelta(days=15)
        job = self._job(self.users[0], created_at=old, expires_at=old + datetime.timedelta(days=14))
        job_dir = scan_storage.scan_upload_root() / str(job.id)
        job_dir.mkdir()
        (job_dir / "0.jpg").write_bytes(b"jpeg")

        self.assertEqual(purge_expired_scan_jobs(self.db), 1)
        self.assertIsNone(self.db.get(ScanJob, job.id))
        self.assertFalse(job_dir.exists())


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class ScanQueueDrainTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": self.temp_dir.name})
        self.env.start()
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        db = self.Session()
        user = User(username="drain-user", hashed_password="x")
        db.add(user)
        db.commit()
        job = ScanJob(
            user_id=user.id,
            status="pending",
            created_at=datetime.datetime.utcnow(),
            updated_at=datetime.datetime.utcnow(),
            expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=14),
        )
        db.add(job)
        db.flush()
        db.add(ScanQueueUserState(user_id=user.id))
        job_dir = scan_storage.scan_upload_root() / str(job.id)
        job_dir.mkdir()
        (job_dir / "scan.jpg").write_bytes(b"safe-jpeg")
        db.add(
            ScanJobItem(
                job_id=job.id,
                user_id=user.id,
                position=0,
                image_path=f"{job.id}/scan.jpg",
                content_type="image/jpeg",
                byte_size=9,
                status="pending",
                resolved=False,
                attempts=0,
                transient_failures=0,
                next_attempt_at=datetime.datetime.utcnow(),
                created_at=datetime.datetime.utcnow(),
                updated_at=datetime.datetime.utcnow(),
            )
        )
        db.commit()
        self.item_id = db.query(ScanJobItem.id).scalar()
        db.close()

    def tearDown(self):
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    async def test_drain_uses_processor_and_persists_result(self):
        async def processor(db, user_id, image_bytes, content_type):
            self.assertEqual(image_bytes, b"safe-jpeg")
            return {"recognized": {"name": "Snorlax"}, "matches": [{"id": "card-63"}]}

        with patch("database.SessionLocal", self.Session):
            processed = await scan_queue.drain_scan_queue(max_items=1, processor=processor)

        db = self.Session()
        try:
            item = db.get(ScanJobItem, self.item_id)
            self.assertEqual(processed, 1)
            self.assertEqual(item.status, "done")
            self.assertEqual(item.recognized["name"], "Snorlax")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
