import asyncio
import datetime
import io
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import get_current_user
    from api.collection import router as collection_router
    from api.scan_jobs import router as scan_router
    from api.wishlist import router as wishlist_router
    from database import Base, get_db
    from models import Card, CollectionItem, IdempotencyKey, ScanJob, User, WishlistItem
    from services import idempotency
    from services.idempotency import (
        begin_idempotent,
        digest_uploads,
        fingerprint_json,
        fingerprint_scan,
        purge_expired_idempotency_keys,
    )

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

KEY_A = "11111111-1111-4111-8111-111111111111"
KEY_B = "22222222-2222-4222-8222-222222222222"


def _jpeg_bytes(color="#d92828"):
    image = Image.new("RGB", (80, 112), color)
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class IdempotencyApiTests(unittest.TestCase):
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
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username="idem-owner", hashed_password="x", is_active=True)
        self.other = User(username="idem-other", hashed_password="x", is_active=True)
        self.card = Card(
            id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1",
            number="1", lang="en", variants_normal=True,
        )
        self.db.add_all([self.user, self.other, self.card])
        self.db.commit()

        app = FastAPI()
        app.include_router(collection_router, prefix="/api/collection")
        app.include_router(wishlist_router, prefix="/api/wishlist")
        app.include_router(scan_router, prefix="/api/cards")

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

    # --- helpers -----------------------------------------------------------

    def _add(self, key=KEY_A, body=None, headers=None):
        sent = {} if key is None else {"Idempotency-Key": key}
        sent.update(headers or {})
        return self.client.post(
            "/api/collection/",
            json=body or {"card_id": self.card.id, "quantity": 2},
            headers=sent,
        )

    def _quantity(self):
        return sum(row.quantity for row in self.db.query(CollectionItem).all())

    def _scan(self, key=KEY_A, photos=None, headers=None, data=None):
        sent = {} if key is None else {"Idempotency-Key": key}
        sent.update(headers or {})
        photos = photos or [_jpeg_bytes()]
        with patch("api.recognize.get_gemini_key", return_value="secret-key"), \
                patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)):
            return self.client.post(
                "/api/cards/recognize/jobs",
                files=[("files", (f"p{i}.jpg", raw, "image/jpeg")) for i, raw in enumerate(photos)],
                data=data or {},
                headers=sent,
            )

    # --- collection --------------------------------------------------------

    def test_first_call_stores_one_row_and_replay_is_applied_once(self):
        first = self._add()
        second = self._add()

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json(), second.json())
        self.assertNotIn("idempotent-replayed", first.headers)
        self.assertEqual(second.headers["Idempotent-Replayed"], "true")
        self.assertEqual(self._quantity(), 2)
        rows = self.db.query(IdempotencyKey).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].scope, "collection.add")
        self.assertEqual(rows[0].response_status, 200)
        self.assertGreater(rows[0].expires_at, rows[0].created_at)

    def test_different_payload_with_same_key_is_rejected_and_writes_nothing(self):
        self._add()
        response = self._add(body={"card_id": self.card.id, "quantity": 5})

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "idempotency_key_reused")
        self.assertEqual(self._quantity(), 2)

    def test_same_key_on_a_different_scope_is_rejected(self):
        self._add()
        response = self.client.post(
            "/api/wishlist/",
            json={"card_id": self.card.id, "quantity": 2},
            headers={"Idempotency-Key": KEY_A},
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "idempotency_key_reused")
        self.assertEqual(self.db.query(WishlistItem).count(), 0)

    def test_same_key_for_a_different_user_is_independent(self):
        self._add()
        self.app.dependency_overrides[get_current_user] = lambda: self.other
        response = self._add()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("idempotent-replayed", response.headers)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 2)
        self.assertEqual(self._quantity(), 4)

    def test_expired_key_is_treated_as_new(self):
        self._add()
        row = self.db.query(IdempotencyKey).one()
        row.expires_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
        self.db.commit()

        response = self._add()

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("idempotent-replayed", response.headers)
        self.assertEqual(self._quantity(), 4)
        fresh = self.db.query(IdempotencyKey).one()
        self.assertGreater(fresh.expires_at, datetime.datetime.utcnow())

    def test_invalid_key_is_rejected_before_any_write(self):
        for bad in ("short", "has space in it 1234567", "x" * 65, "bad/chars/in/key/12345"):
            response = self._add(key=bad)
            self.assertEqual(response.status_code, 400, bad)
            self.assertEqual(response.json()["detail"]["code"], "idempotency_key_invalid")
        self.assertEqual(self._quantity(), 0)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)

    def test_quoted_key_is_accepted_and_equals_the_unquoted_key(self):
        self._add(key=f'"{KEY_A}"')
        replay = self._add(key=KEY_A)

        self.assertEqual(replay.headers["Idempotent-Replayed"], "true")
        self.assertEqual(self._quantity(), 2)
        self.assertEqual(self.db.query(IdempotencyKey).one().key, KEY_A)

    def test_absent_key_keeps_legacy_behaviour_and_touches_no_table(self):
        first = self._add(key=None)
        second = self._add(key=None)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(self._quantity(), 4)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)
        self.assertNotIn("idempotent-replayed", second.headers)

    def test_failed_business_call_stores_no_key_so_a_retry_runs_again(self):
        missing = {"card_id": "custom-does-not-exist", "quantity": 1}
        failed = self._add(body=missing)
        self.assertEqual(failed.status_code, 404)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)

        retried = self._add(body={"card_id": self.card.id, "quantity": 1})
        self.assertEqual(retried.status_code, 200)
        self.assertNotIn("idempotent-replayed", retried.headers)

    def test_expected_user_mismatch_is_409_even_without_a_key(self):
        keyed = self._add(headers={"X-Expected-User-Id": str(self.other.id)})
        keyless = self._add(key=None, headers={"X-Expected-User-Id": str(self.other.id)})

        for response in (keyed, keyless):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["detail"]["code"], "wrong_account")
        self.assertEqual(self._quantity(), 0)

    def test_expected_user_match_is_accepted_and_garbage_is_400(self):
        ok = self._add(headers={"X-Expected-User-Id": str(self.user.id)})
        bad = self._add(key=None, headers={"X-Expected-User-Id": "abc"})

        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json()["detail"]["code"], "idempotency_key_invalid")

    def test_record_integrity_error_rolls_back_business_write_and_returns_409(self):
        # Simulates the loser of a race after an intermediate commit released the
        # advisory lock: the winner's key row commits between begin and record.
        ctx = begin_idempotent(
            self.db, self.user, {"Idempotency-Key": KEY_B},
            scope="collection.add", fingerprint="f",
        )
        self.assertTrue(ctx.active)
        self.assertIsNone(ctx.replay)
        self.db.add(IdempotencyKey(
            user_id=self.user.id, key=KEY_B, scope="collection.add", request_hash="f",
            response_status=200, response_body={},
            expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=1),
        ))
        self.db.commit()
        self.db.add(CollectionItem(card_id=self.card.id, quantity=7, user_id=self.user.id))

        with self.assertRaises(HTTPException) as caught:
            ctx.record(self.db, 200, {"ok": True})

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail["code"], "idempotency_in_progress")
        self.assertEqual(caught.exception.headers["Retry-After"], "2")
        self.assertEqual(self._quantity(), 0)

    def test_record_refuses_a_non_2xx_result(self):
        ctx = begin_idempotent(
            self.db, self.user, {"Idempotency-Key": KEY_A},
            scope="collection.add", fingerprint="f",
        )
        with self.assertRaises(ValueError):
            ctx.record(self.db, 404, {"detail": "nope"})

    # --- wishlist ----------------------------------------------------------

    def test_wishlist_replay_does_not_increment_twice(self):
        body = {"card_id": self.card.id, "quantity": 3}
        first = self.client.post("/api/wishlist/", json=body, headers={"Idempotency-Key": KEY_A})
        second = self.client.post("/api/wishlist/", json=body, headers={"Idempotency-Key": KEY_A})
        third = self.client.post("/api/wishlist/", json=body)

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(second.headers["Idempotent-Replayed"], "true")
        self.assertEqual(third.json()["quantity"], 6)
        self.assertEqual(self.db.query(WishlistItem).one().quantity, 6)

    def test_wishlist_cap_failure_stores_no_key(self):
        body = {"card_id": self.card.id, "quantity": 99}
        self.client.post("/api/wishlist/", json=body)
        over = self.client.post("/api/wishlist/", json=body, headers={"Idempotency-Key": KEY_A})

        self.assertEqual(over.status_code, 400)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)

    # --- scan jobs ---------------------------------------------------------

    def test_scan_replay_creates_no_second_job_and_skips_provider_checks(self):
        first = self._scan()
        self.assertEqual(first.status_code, 200, first.text)

        # The replay must not depend on the provider still being configured.
        with patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)) as drain, \
                patch("services.scan_providers.get_provider", side_effect=AssertionError("provider consulted")):
            second = self.client.post(
                "/api/cards/recognize/jobs",
                files=[("files", ("p0.jpg", _jpeg_bytes(), "image/jpeg"))],
                headers={"Idempotency-Key": KEY_A},
            )

        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(second.headers["Idempotent-Replayed"], "true")
        self.assertEqual(self.db.query(ScanJob).count(), 1)
        drain.assert_not_awaited()
        self.assertEqual(self.db.query(IdempotencyKey).one().scope, "scan.enqueue")

    def test_scan_fingerprint_covers_file_bytes_and_positions(self):
        self._scan(photos=[_jpeg_bytes("#d92828"), _jpeg_bytes("#2828d9")])

        other_bytes = self._scan(photos=[_jpeg_bytes("#d92828"), _jpeg_bytes("#28d928")])
        other_positions = self._scan(
            photos=[_jpeg_bytes("#d92828"), _jpeg_bytes("#2828d9")],
            data={"individual_positions": "[1]"},
        )

        for response in (other_bytes, other_positions):
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(response.json()["detail"]["code"], "idempotency_key_reused")
        self.assertEqual(self.db.query(ScanJob).count(), 1)

    def test_scan_without_key_is_unchanged_and_records_nothing(self):
        self.assertEqual(self._scan(key=None).status_code, 200)
        self.assertEqual(self._scan(key=None).status_code, 200)
        self.assertEqual(self.db.query(ScanJob).count(), 2)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)

    def test_scan_invalid_positions_with_key_is_400_and_stores_nothing(self):
        response = self._scan(data={"individual_positions": "[5]"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)

    def test_scan_failed_upload_stores_no_key(self):
        response = self._scan(photos=[b"not an image"])

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        self.assertEqual(self.db.query(IdempotencyKey).count(), 0)

    def test_scan_expected_user_mismatch_is_409_without_a_key(self):
        response = self._scan(key=None, headers={"X-Expected-User-Id": str(self.other.id)})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "wrong_account")
        self.assertEqual(self.db.query(ScanJob).count(), 0)

    # --- helpers under test ------------------------------------------------

    def test_fingerprint_json_is_stable_across_key_order_and_scope_sensitive(self):
        a = fingerprint_json("s", {"a": 1, "b": [1, 2]})
        b = fingerprint_json("s", {"b": [1, 2], "a": 1})
        self.assertEqual(a, b)
        self.assertNotEqual(a, fingerprint_json("t", {"a": 1, "b": [1, 2]}))
        self.assertEqual(len(a), 64)

    def test_digest_uploads_hashes_bytes_and_rewinds(self):
        class Upload:
            def __init__(self, data):
                self._buffer = io.BytesIO(data)

            async def read(self, size=-1):
                return self._buffer.read(size)

            async def seek(self, position):
                self._buffer.seek(position)

        uploads = [Upload(b"abc"), Upload(b"")]
        digests = asyncio.run(digest_uploads(uploads))

        self.assertEqual(
            digests[0], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        self.assertEqual(asyncio.run(uploads[0].read()), b"abc")
        self.assertEqual(fingerprint_scan("s", [1, 0], digests), fingerprint_scan("s", [0, 1], digests))
        self.assertNotEqual(fingerprint_scan("s", [], digests), fingerprint_scan("s", [], digests[:1]))

    def test_cleanup_deletes_only_expired_rows_in_batches(self):
        now = datetime.datetime.utcnow()
        for index in range(5):
            self.db.add(IdempotencyKey(
                user_id=self.user.id, key=f"expired-key-{index:02d}-0000", scope="s",
                request_hash="h", response_status=200, response_body={},
                expires_at=now - datetime.timedelta(minutes=index + 1),
            ))
        self.db.add(IdempotencyKey(
            user_id=self.user.id, key="live-key-0000000000", scope="s", request_hash="h",
            response_status=200, response_body={}, expires_at=now + datetime.timedelta(days=1),
        ))
        self.db.commit()

        removed = purge_expired_idempotency_keys(self.db, now=now, batch_size=2)

        self.assertEqual(removed, 5)
        self.assertEqual([row.key for row in self.db.query(IdempotencyKey).all()], ["live-key-0000000000"])

    def test_scheduler_registers_hourly_cleanup_job(self):
        from services import scheduler as scheduler_module

        self.assertTrue(callable(scheduler_module.run_idempotency_cleanup))

    def test_health_payload_shape(self):
        from main import health_check
        from services.api_info import API_FEATURES, API_LEVEL

        payload = health_check()

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["service"], "pokemon-tcg-collection")
        self.assertEqual(payload["api_level"], 1)
        self.assertEqual(payload["features"], ["idempotency-v1"])
        self.assertTrue(payload["version"])
        self.assertEqual((API_LEVEL, API_FEATURES), (1, ("idempotency-v1",)))

    def test_cors_allows_the_new_request_headers(self):
        import main

        cors = next(m for m in main.app.user_middleware if m.cls.__name__ == "CORSMiddleware")
        allowed = cors.kwargs["allow_headers"]
        self.assertIn("Idempotency-Key", allowed)
        self.assertIn("X-Expected-User-Id", allowed)

    def test_idempotency_constants(self):
        self.assertEqual(idempotency.KEY_TTL, datetime.timedelta(days=14))
        self.assertEqual(idempotency.REPLAYED_HEADER, "Idempotent-Replayed")


if __name__ == "__main__":
    unittest.main()
