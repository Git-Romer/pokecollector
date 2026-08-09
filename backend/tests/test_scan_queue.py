import datetime
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

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
        retry_scan_item,
        job_progress,
        complete_claim_group,
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

    def test_batch_claim_groups_four_photos_and_keeps_forced_single_out(self):
        job = self._job(self.users[0], positions=(0, 1, 2, 3, 4))
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        for item in items:
            item.batch_mode = True
        items[1].batch_mode = False
        self.db.commit()

        claim = claim_next_scan_item(self.db)

        self.assertTrue(claim.composite)
        self.assertEqual(claim.all_item_ids, (items[0].id, items[2].id, items[3].id, items[4].id))
        self.assertEqual(items[1].status, "pending")
        self.assertTrue(complete_claim_group(
            self.db,
            claim,
            [{"recognized": {"name": str(index)}, "matches": []} for index in range(4)],
        ))
        self.assertEqual(items[1].status, "pending")

    def test_unclear_composite_position_retries_without_confident_siblings(self):
        self._job(self.users[0], positions=(0, 1, 2, 3))
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        for item in items:
            item.batch_mode = True
        self.db.commit()

        composite_claim = claim_next_scan_item(self.db)
        def confident(name):
            return {
                "recognized": {"name": name, "number": "25"},
                "matches": [{"id": f"card-{name}"}],
            }
        self.assertTrue(complete_claim_group(
            self.db,
            composite_claim,
            [confident("A"), None, confident("C"), confident("D")],
        ))
        self.db.expire_all()
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        self.assertEqual([item.status for item in items], ["done", "pending", "done", "done"])
        self.assertFalse(items[1].batch_mode)

        fallback_claim = claim_next_scan_item(self.db)
        self.assertEqual(fallback_claim.all_item_ids, (items[1].id,))
        fail_claim(self.db, fallback_claim, "429", transient=True)
        self.db.expire_all()
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        self.assertEqual([item.status for item in items], ["done", "retrying", "done", "done"])
        self.assertEqual([item.transient_failures for item in items], [0, 1, 0, 0])

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

    def test_provider_retry_delay_and_reason_are_persisted(self):
        self._job(self.users[0])
        claim = claim_next_scan_item(self.db)
        before = datetime.datetime.utcnow()

        fail_claim(
            self.db,
            claim,
            "daily quota",
            transient=True,
            retry_after_seconds=3600,
            retry_reason="daily_quota",
        )

        item = self.db.get(ScanJobItem, claim.item_id)
        self.assertEqual(item.retry_reason, "daily_quota")
        self.assertGreaterEqual(
            item.next_attempt_at,
            before + datetime.timedelta(seconds=3599),
        )

    def test_provider_retry_delay_overrides_generic_backoff_exactly(self):
        self._job(self.users[0])
        item = self.db.query(ScanJobItem).one()
        item.transient_failures = 4
        self.db.commit()
        claim = claim_next_scan_item(self.db)
        before = datetime.datetime.utcnow()

        fail_claim(
            self.db,
            claim,
            "daily quota",
            transient=True,
            retry_after_seconds=21,
            retry_reason="daily_quota",
        )

        self.db.refresh(item)
        scheduled_delay = (item.next_attempt_at - before).total_seconds()
        self.assertGreaterEqual(scheduled_delay, 20.9)
        self.assertLess(scheduled_delay, 22)

    def test_recognition_failure_stops_after_three_attempts(self):
        job = self._job(self.users[0])
        item = self.db.query(ScanJobItem).one()
        job_dir = scan_storage.scan_upload_root() / str(job.id)
        job_dir.mkdir()
        image = job_dir / "0.jpg"
        image.write_bytes(b"jpeg")
        for expected in (1, 2, 3):
            item.status = "pending"
            item.next_attempt_at = datetime.datetime.utcnow()
            self.db.commit()
            claim = claim_next_scan_item(self.db)
            fail_claim(self.db, claim, "unreadable", transient=False)
            item = self.db.get(ScanJobItem, item.id)
            self.assertEqual(item.attempts, expected)
        self.assertEqual(item.status, "failed")
        self.assertTrue(image.exists())
        self.assertEqual(item.image_path, f"{job.id}/0.jpg")

    def test_failed_item_can_be_retried_as_a_fresh_recognition_cycle(self):
        job = self._job(self.users[0])
        item = self.db.query(ScanJobItem).one()
        job_dir = scan_storage.scan_upload_root() / str(job.id)
        job_dir.mkdir()
        (job_dir / "0.jpg").write_bytes(b"jpeg")
        item.status = "failed"
        item.attempts = 3
        item.transient_failures = 2
        item.error = "unreadable"
        item.recognized = {"name": "Wrong"}
        item.matches = []
        job.status = "failed"
        job.finished_at = datetime.datetime.utcnow()
        self.db.commit()

        retry_scan_item(self.db, item)

        self.assertEqual(item.status, "pending")
        self.assertEqual(item.attempts, 0)
        self.assertEqual(item.transient_failures, 0)
        self.assertIsNone(item.error)
        self.assertIsNone(item.recognized)
        self.assertIsNone(item.matches)
        self.assertFalse(item.batch_mode)
        self.assertEqual(job.status, "pending")
        self.assertIsNone(job.finished_at)

    def test_progress_counts_only_reviewable_items_as_attention(self):
        job = self._job(self.users[0], positions=(0, 1, 2, 3))
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        items[0].status = "done"
        items[1].status = "failed"
        items[2].status = "retrying"
        retry_at = datetime.datetime.utcnow() + datetime.timedelta(minutes=30)
        items[2].next_attempt_at = retry_at
        items[2].retry_reason = "daily_quota"
        items[3].status = "done"
        items[3].resolved = True
        self.db.commit()

        progress = job_progress(self.db, job)

        self.assertEqual(progress["processed"], 3)
        self.assertEqual(progress["active"], 1)
        self.assertEqual(progress["attention"], 2)
        self.assertEqual(progress["failed_attention"], 1)
        self.assertEqual(progress["unresolved"], 2)
        self.assertEqual(progress["next_retry_at"], retry_at.isoformat())
        self.assertEqual(progress["retry_reason"], "daily_quota")

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


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class CompositeProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_confident_metadata_matches_are_accepted_from_composite(self):
        from PIL import Image
        import io

        def image_bytes(color):
            output = io.BytesIO()
            Image.new("RGB", (100, 140), color).save(output, format="JPEG")
            return output.getvalue()

        db = MagicMock()
        db.get.return_value = User(id=1, username="composite-owner", hashed_password="x", is_active=True)
        composite_info = {
            0: {"name": "Pikachu", "number_local": "25", "language": "en"},
            1: {"name": None, "number_local": "4", "language": "en"},
            2: {"name": "Eevee", "number_local": "133", "language": "en"},
            3: {"name": "Jigglypuff", "artist": "Kagemaru Himeno", "hp": "60", "language": "ja"},
        }
        matched = [
            {
                "recognized": composite_info[0],
                "matches": [{"id": "card-25"}],
                "_number_match_count": 1,
                "_identity_confident": True,
            },
            {
                "recognized": composite_info[2],
                "matches": [{"id": "wrong-number"}],
                "_number_match_count": 0,
                "_identity_confident": False,
            },
            {
                "recognized": composite_info[3],
                "matches": [{"id": "card-jigglypuff"}],
                "_number_match_count": 0,
                "_identity_confident": True,
            },
        ]

        matcher = AsyncMock(side_effect=matched)
        with patch("api.recognize.get_gemini_key", return_value="secret-key"), \
                patch("api.recognize.recognize_composite_card_info", new=AsyncMock(return_value=composite_info)), \
                patch("api.recognize.match_composite_card_info", new=matcher):
            results = await scan_queue.default_composite_processor(
                db,
                1,
                [image_bytes("red"), image_bytes("blue"), image_bytes("green"), image_bytes("yellow")],
                ["image/jpeg"] * 4,
            )

        self.assertEqual(results[0]["matches"][0]["id"], "card-25")
        self.assertEqual(results[1:3], [None, None])
        self.assertEqual(results[3]["matches"][0]["id"], "card-jigglypuff")
        self.assertEqual(matcher.await_count, 3)


if __name__ == "__main__":
    unittest.main()
