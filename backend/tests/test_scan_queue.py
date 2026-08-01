import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import ScanJob, ScanJobItem, User
    from services import scan_queue
    from services.scan_queue import (
        MAX_ATTEMPTS,
        _apply_result,
        enqueue_scan_job,
        job_progress,
        purge_old_scan_jobs,
        resolve_item,
    )
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _uploads(n, *, batch_mode=True):
    return [
        {
            "filename": f"card{i}.jpg",
            "bytes": f"image-bytes-{i}".encode(),
            "content_type": "image/jpeg",
            "batch_mode": batch_mode,
        }
        for i in range(n)
    ]


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class ScanQueueTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="tester", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_enqueue_stores_every_photo_and_preserves_order(self):
        job = enqueue_scan_job(self.db, self.user.id, _uploads(3))

        items = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).order_by(ScanJobItem.position).all()
        self.assertEqual(job.status, "pending")
        self.assertEqual([i.position for i in items], [0, 1, 2])
        self.assertEqual([i.filename for i in items], ["card0.jpg", "card1.jpg", "card2.jpg"])
        # Photos must be persisted, not held in memory — that's what lets the
        # queue survive a restart and the user close the tab.
        self.assertEqual(items[0].image_data, b"image-bytes-0")

    def test_enqueue_records_the_disable_batching_override(self):
        job = enqueue_scan_job(
            self.db, self.user.id, _uploads(1, batch_mode=True) + _uploads(1, batch_mode=False)
        )
        items = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).order_by(ScanJobItem.position).all()
        self.assertTrue(items[0].batch_mode)
        self.assertFalse(items[1].batch_mode)

    def test_progress_counts_reflect_item_states(self):
        job = enqueue_scan_job(self.db, self.user.id, _uploads(3))
        items = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).order_by(ScanJobItem.position).all()
        items[0].status = "done"
        items[1].status = "failed"
        self.db.commit()

        progress = job_progress(self.db, job)
        self.assertEqual(progress["total"], 3)
        self.assertEqual(progress["done"], 1)
        self.assertEqual(progress["failed"], 1)
        self.assertEqual(progress["pending"], 1)

    def test_unresolved_count_drives_the_nav_badge(self):
        # The badge must mean "there is something here for you", so reviewing an
        # item has to decrement it and a failed item must not keep it lit.
        job = enqueue_scan_job(self.db, self.user.id, _uploads(3))
        items = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).order_by(ScanJobItem.position).all()
        self.assertEqual(job_progress(self.db, job)["unresolved"], 3)

        items[0].status = "done"
        items[0].resolved = True
        items[1].status = "failed"
        self.db.commit()

        self.assertEqual(job_progress(self.db, job)["unresolved"], 1)

    def test_resolving_an_item_drops_its_stored_photo(self):
        # scan_job_items must not accumulate image bytes the way image_cache does.
        job = enqueue_scan_job(self.db, self.user.id, _uploads(1))
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).first()
        self.assertIsNotNone(item.image_data)

        resolve_item(self.db, item)

        self.assertTrue(item.resolved)
        self.assertIsNone(item.image_data)

    def test_purge_removes_old_finished_jobs_and_their_items(self):
        import datetime

        job = enqueue_scan_job(self.db, self.user.id, _uploads(2))
        job.status = "done"
        job.created_at = datetime.datetime.utcnow() - datetime.timedelta(days=30)
        self.db.commit()

        removed = purge_old_scan_jobs(self.db, older_than_days=7)

        self.assertEqual(removed, 1)
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        self.assertEqual(self.db.query(ScanJobItem).count(), 0)

    def test_purge_keeps_recent_and_unfinished_jobs(self):
        import datetime

        recent = enqueue_scan_job(self.db, self.user.id, _uploads(1))
        recent.status = "done"
        old_but_running = enqueue_scan_job(self.db, self.user.id, _uploads(1))
        old_but_running.status = "running"
        old_but_running.created_at = datetime.datetime.utcnow() - datetime.timedelta(days=30)
        self.db.commit()

        removed = purge_old_scan_jobs(self.db, older_than_days=7)

        self.assertEqual(removed, 0)
        self.assertEqual(self.db.query(ScanJob).count(), 2)


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class ApplyResultTests(unittest.TestCase):
    def _item(self, attempts=1):
        return ScanJobItem(job_id=1, position=0, status="pending", attempts=attempts)

    def test_success_stores_recognition_and_marks_done(self):
        item = self._item()
        _apply_result(item, {"recognized": {"name": "Gengar"}, "matches": [{"id": "me03-050_en"}]})

        self.assertEqual(item.status, "done")
        self.assertEqual(item.recognized["name"], "Gengar")
        self.assertIsNone(item.error)

    def test_error_stays_pending_while_attempts_remain(self):
        # Most failures here are rate limiting, so the item must be retryable
        # rather than permanently failed on the first error.
        item = self._item(attempts=1)
        _apply_result(item, {"error": "Gemini Rate Limit erreicht"})

        self.assertEqual(item.status, "pending")
        self.assertIn("Rate Limit", item.error)

    def test_error_fails_permanently_once_attempts_are_exhausted(self):
        item = self._item(attempts=MAX_ATTEMPTS)
        _apply_result(item, {"error": "Gemini Rate Limit erreicht"})

        self.assertEqual(item.status, "failed")


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class DrainQueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="tester", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    async def test_drain_marks_a_job_done_when_every_item_succeeds(self):
        job = enqueue_scan_job(self.db, self.user.id, _uploads(2))

        async def fake_group(db, api_key, gemini_url, items, *, batched):
            for item in items:
                item.attempts = (item.attempts or 0) + 1
                _apply_result(item, {"recognized": {"name": "Gengar"}, "matches": []})

        with patch("database.SessionLocal", self.Session), \
                patch.object(scan_queue, "_process_item_group", side_effect=fake_group), \
                patch("api.recognize.get_gemini_key", return_value="key"), \
                patch("api.recognize.build_gemini_generate_url", return_value="https://example.test"):
            await scan_queue.drain_scan_queue()

        self.db.expire_all()
        refreshed = self.db.query(ScanJob).filter(ScanJob.id == job.id).first()
        self.assertEqual(refreshed.status, "done")
        self.assertIsNotNone(refreshed.finished_at)

    async def test_job_fails_when_the_user_has_no_api_key(self):
        job = enqueue_scan_job(self.db, self.user.id, _uploads(1))

        with patch("database.SessionLocal", self.Session), \
                patch("api.recognize.get_gemini_key", return_value=""), \
                patch("api.recognize.build_gemini_generate_url", return_value="https://example.test"):
            await scan_queue.drain_scan_queue()

        self.db.expire_all()
        refreshed = self.db.query(ScanJob).filter(ScanJob.id == job.id).first()
        self.assertEqual(refreshed.status, "failed")
        self.assertIn("Gemini API Key", refreshed.error_message)

    async def test_a_permanently_stuck_job_is_failed_instead_of_looping_forever(self):
        job = enqueue_scan_job(self.db, self.user.id, _uploads(1))

        async def always_failing(db, api_key, gemini_url, items, *, batched):
            # Never increments attempts, so the item can never exhaust them —
            # the drain loop must still notice the lack of progress and stop.
            return

        with patch("database.SessionLocal", self.Session), \
                patch.object(scan_queue, "_process_item_group", side_effect=always_failing), \
                patch("api.recognize.get_gemini_key", return_value="key"), \
                patch("api.recognize.build_gemini_generate_url", return_value="https://example.test"):
            await scan_queue.drain_scan_queue()

        self.db.expire_all()
        refreshed = self.db.query(ScanJob).filter(ScanJob.id == job.id).first()
        self.assertEqual(refreshed.status, "failed")


if __name__ == "__main__":
    unittest.main()
