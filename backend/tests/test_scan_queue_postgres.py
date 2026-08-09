"""Opt-in checks for queue behavior that SQLite cannot exercise."""

import concurrent.futures
import datetime
import os
import unittest
import uuid

try:
    from sqlalchemy import inspect, text

    from database import SessionLocal, init_db
    from models import ScanJob, ScanJobItem, ScanQueueUserState, User
    from services.scan_queue import claim_next_scan_item

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


POSTGRES_TEST_ENABLED = (
    DEPS_AVAILABLE
    and os.environ.get("SCAN_QUEUE_POSTGRES_TEST") == "1"
    and os.environ.get("DATABASE_URL", "").startswith("postgresql")
)


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires the isolated PostgreSQL queue test database")
class ScanQueuePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.prefix = f"queue-pg-{uuid.uuid4().hex}"
        db = SessionLocal()
        try:
            self.users = [
                User(username=f"{self.prefix}-a", hashed_password="x"),
                User(username=f"{self.prefix}-b", hashed_password="x"),
            ]
            db.add_all(self.users)
            db.flush()
            now = datetime.datetime.utcnow()
            for user in self.users:
                job = ScanJob(
                    user_id=user.id,
                    status="pending",
                    created_at=now,
                    updated_at=now,
                    expires_at=now + datetime.timedelta(days=14),
                )
                db.add(job)
                db.flush()
                db.execute(
                    text(
                        "INSERT INTO scan_queue_user_state (user_id, last_dispatched_at) "
                        "VALUES (:user_id, NULL) ON CONFLICT (user_id) DO NOTHING"
                    ),
                    {"user_id": user.id},
                )
                for position in range(4):
                    db.add(ScanJobItem(
                        job_id=job.id,
                        user_id=user.id,
                        position=position,
                        image_path=f"{job.id}/{position}.jpg",
                        content_type="image/jpeg",
                        byte_size=4,
                        status="pending",
                        batch_mode=True,
                        resolved=False,
                        attempts=0,
                        transient_failures=0,
                        next_attempt_at=now,
                        created_at=now,
                        updated_at=now,
                    ))
            db.commit()
            self.user_ids = [user.id for user in self.users]
        finally:
            db.close()

    def tearDown(self):
        db = SessionLocal()
        try:
            db.query(User).filter(User.username.like(f"{self.prefix}%")).delete(
                synchronize_session=False
            )
            db.commit()
        finally:
            db.close()

    def test_migration_created_queue_tables(self):
        table_names = set(inspect(SessionLocal.kw["bind"]).get_table_names())
        self.assertTrue(
            {
                "scan_jobs",
                "scan_job_items",
                "scan_queue_user_state",
                "gemini_quota_state",
            }.issubset(table_names)
        )

    def test_two_workers_claim_distinct_composite_groups_atomically(self):
        def claim():
            db = SessionLocal()
            try:
                return claim_next_scan_item(db)
            finally:
                db.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(executor.map(lambda _index: claim(), range(2)))

        self.assertTrue(all(claims))
        self.assertEqual(len({claim.item_id for claim in claims}), 2)
        self.assertTrue(all(claim.composite for claim in claims))
        self.assertTrue(all(len(claim.all_item_ids) == 4 for claim in claims))
        self.assertTrue(set(claims[0].all_item_ids).isdisjoint(claims[1].all_item_ids))


if __name__ == "__main__":
    unittest.main()
