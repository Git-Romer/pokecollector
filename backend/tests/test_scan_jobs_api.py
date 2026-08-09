import io
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.scan_jobs import router
    from api.auth import get_current_user
    from database import Base, get_db
    from models import ScanJob, ScanJobItem, User
    from services.scan_storage import resolve_scan_path

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _jpeg_bytes():
    image = Image.new("RGB", (80, 112), "#d92828")
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner API dependencies are not installed")
class ScanJobsApiTests(unittest.TestCase):
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
        self.user = User(username="scan-api-owner", hashed_password="x", is_active=True)
        self.other_user = User(username="scan-api-other", hashed_password="x", is_active=True)
        self.db.add_all([self.user, self.other_user])
        self.db.commit()

        app = FastAPI()
        app.include_router(router, prefix="/api/cards")

        def override_db():
            yield self.db

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def _enqueue(self):
        with patch("api.recognize.get_gemini_key", return_value="secret-key"), \
                patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)):
            response = self.client.post(
                "/api/cards/recognize/jobs",
                files={"files": ("private-name.jpg", _jpeg_bytes(), "image/jpeg")},
            )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_enqueue_list_detail_and_authenticated_image(self):
        created = self._enqueue()
        job_id = created["id"]

        listed = self.client.get("/api/cards/recognize/jobs")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([job["id"] for job in listed.json()["jobs"]], [job_id])
        self.assertEqual(listed.json()["jobs"][0]["active"], 1)
        self.assertEqual(listed.json()["jobs"][0]["attention"], 0)

        detail = self.client.get(f"/api/cards/recognize/jobs/{job_id}")
        self.assertEqual(detail.status_code, 200)
        item = detail.json()["items"][0]
        self.assertTrue(item["has_image"])
        self.assertNotIn("private-name", self.db.get(ScanJobItem, item["id"]).image_path)

        image = self.client.get(
            f"/api/cards/recognize/jobs/{job_id}/items/{item['id']}/image"
        )
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.content[:2], b"\xff\xd8")

    def test_other_user_cannot_access_job_or_photo(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self.app.dependency_overrides[get_current_user] = lambda: self.other_user

        self.assertEqual(
            self.client.get(f"/api/cards/recognize/jobs/{created['id']}").status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/image"
            ).status_code,
            404,
        )

    def test_resolve_deletes_photo_and_removes_fully_handled_job_from_inbox(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        stored = resolve_scan_path(item.image_path)
        item.status = "done"
        item.matches = [{"id": "card-1"}]
        self.db.commit()

        response = self.client.post(
            f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve"
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["resolved"])
        self.assertFalse(stored.exists())
        self.assertEqual(self.client.get("/api/cards/recognize/jobs").json()["jobs"], [])

    def test_failed_photo_is_retained_and_retry_resets_it(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        stored = resolve_scan_path(item.image_path)
        item.status = "failed"
        item.attempts = 3
        item.error = "unreadable"
        self.db.commit()

        with patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)):
            response = self.client.post(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/retry"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "pending")
        self.assertEqual(response.json()["attempts"], 0)
        self.assertTrue(stored.exists())

    def test_deleting_job_removes_database_rows_and_photo_directory(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        job_dir = resolve_scan_path(item.image_path).parent

        response = self.client.delete(f"/api/cards/recognize/jobs/{created['id']}")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.db.get(ScanJob, created["id"]))
        self.assertFalse(job_dir.exists())


if __name__ == "__main__":
    unittest.main()
