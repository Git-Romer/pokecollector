import json
import unittest
from unittest.mock import AsyncMock, patch

try:
    import httpx
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    import api.recognize as recognize_module
    from api.recognize import (
        DEFAULT_GEMINI_MODEL,
        build_gemini_generate_url,
        get_gemini_model,
        gemini_error_message,
        post_gemini_generate,
        router as recognize_router,
        _extract_json,
        _normalize_number,
        _numbers_match,
        _printed_total_mismatch,
        _recognize_composite_chunk,
        _recognize_single_image,
    )
    from api.auth import get_current_user
    from database import get_db
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeConfigTests(unittest.TestCase):
    def test_gemini_model_defaults_to_supported_alias(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(get_gemini_model(), DEFAULT_GEMINI_MODEL)
            self.assertIn(f"/{DEFAULT_GEMINI_MODEL}:generateContent", build_gemini_generate_url())

    def test_gemini_model_uses_env_and_accepts_models_prefix(self):
        with patch.dict("os.environ", {"GEMINI_MODEL": "models/gemini-3.5-flash"}):
            self.assertEqual(get_gemini_model(), "gemini-3.5-flash")
            self.assertIn("/gemini-3.5-flash:generateContent", build_gemini_generate_url())


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeErrorTests(unittest.TestCase):
    def test_extracts_gemini_error_message(self):
        response = httpx.Response(404, json={"error": {"message": "model retired"}})

        self.assertEqual(gemini_error_message(response), "model retired")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_gemini_404_surfaces_upstream_message(self):
        class FakeClient:
            async def post(self, *args, **kwargs):
                return httpx.Response(
                    404,
                    json={"error": {"message": "This model is no longer available to new users."}},
                )

        with self.assertRaises(HTTPException) as ctx:
            await post_gemini_generate(FakeClient(), "https://example.test", "key", {})

        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("GEMINI_MODEL", ctx.exception.detail)
        self.assertIn("no longer available", ctx.exception.detail)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class NumberNormalizationTests(unittest.TestCase):
    def test_strips_leading_zeros_and_denominator(self):
        self.assertEqual(_normalize_number("063"), "63")
        self.assertEqual(_normalize_number("63/88"), "63")
        self.assertEqual(_normalize_number(63), "63")

    def test_no_digits_returns_none(self):
        self.assertIsNone(_normalize_number(None))
        self.assertIsNone(_normalize_number(""))
        self.assertIsNone(_normalize_number("SWSH-PROMO"))

    def test_numbers_match_ignores_leading_zeros(self):
        self.assertTrue(_numbers_match("063", "63"))
        self.assertTrue(_numbers_match("088", 88))
        self.assertFalse(_numbers_match("063", "64"))
        self.assertFalse(_numbers_match(None, "63"))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class PrintedTotalMismatchTests(unittest.TestCase):
    def test_flags_a_real_mismatch(self):
        # Gemini read "088" off the photo, but the matched candidate's set only has 198 cards.
        self.assertTrue(_printed_total_mismatch("088", 198))

    def test_matching_totals_are_not_flagged(self):
        self.assertFalse(_printed_total_mismatch("088", 88))
        self.assertFalse(_printed_total_mismatch(88, 88))

    def test_missing_data_on_either_side_never_flags(self):
        # An unread or unsynced total must never look like a false "wrong match".
        self.assertFalse(_printed_total_mismatch(None, 88))
        self.assertFalse(_printed_total_mismatch("088", None))
        self.assertFalse(_printed_total_mismatch("088", 0))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class ExtractJsonTests(unittest.TestCase):
    def test_extracts_plain_object(self):
        self.assertEqual(_extract_json('{"name": "Gengar"}'), {"name": "Gengar"})

    def test_extracts_object_wrapped_in_markdown_fence(self):
        text = '```json\n{"name": "Gengar", "number_local": "050"}\n```'
        self.assertEqual(_extract_json(text), {"name": "Gengar", "number_local": "050"})

    def test_extracts_array_when_requested(self):
        text = '[{"index": 1, "name": "Gengar"}, {"index": 2, "name": "Snorlax"}]'
        parsed = _extract_json(text, array=True)
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["name"], "Gengar")

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            _extract_json("I could not read this card.")


def _fake_gemini_text_response(text: str):
    return httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": text}]}}]
    })


def _fake_jpeg_bytes() -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (300, 420), (10, 20, 30)).save(buf, format="JPEG")
    return buf.getvalue()


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeSingleImageTests(unittest.IsolatedAsyncioTestCase):
    async def test_parses_card_info_from_gemini_response(self):
        card_info = {"name": "Gengar", "name_en": "Gengar", "number_local": "050", "language": "en"}

        class FakeClient:
            async def post(self, *args, **kwargs):
                return _fake_gemini_text_response(json.dumps(card_info))

        result = await _recognize_single_image(FakeClient(), "https://example.test", "key", "b64", "image/jpeg")
        self.assertEqual(result, card_info)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeCompositeChunkTests(unittest.IsolatedAsyncioTestCase):
    async def test_maps_results_back_to_source_by_echoed_index(self):
        chunk = [
            {"filename": "a.jpg", "bytes": _fake_jpeg_bytes(), "mime_type": "image/jpeg"},
            {"filename": "b.jpg", "bytes": _fake_jpeg_bytes(), "mime_type": "image/jpeg"},
        ]
        gemini_array = [
            {"index": 2, "name": "Snorlax", "name_en": "Snorlax", "language": "en"},
            {"index": 1, "name": "Gengar", "name_en": "Gengar", "language": "en"},
        ]

        class FakeClient:
            async def post(self, *args, **kwargs):
                return _fake_gemini_text_response(json.dumps(gemini_array))

        async def fake_match(db, api_key, gemini_url, card_info, image_b64, mime_type):
            return {"recognized": card_info, "matches": []}

        with patch("api.recognize.httpx.AsyncClient") as mock_client_cls, \
                patch("api.recognize._match_card_info", side_effect=fake_match):
            mock_client_cls.return_value.__aenter__.return_value = FakeClient()
            out = await _recognize_composite_chunk(db=None, api_key="key", gemini_url="https://example.test", chunk=chunk)

        self.assertEqual(len(out), 2)
        # a.jpg is chunk position 1 -> must get the entry echoed with index 1 (Gengar),
        # even though Gemini returned Gengar second in the array.
        self.assertEqual(out[0]["filename"], "a.jpg")
        self.assertEqual(out[0]["recognized"]["name"], "Gengar")
        self.assertEqual(out[1]["filename"], "b.jpg")
        self.assertEqual(out[1]["recognized"]["name"], "Snorlax")

    async def test_missing_index_becomes_a_per_item_error_not_a_silent_drop(self):
        chunk = [
            {"filename": "a.jpg", "bytes": _fake_jpeg_bytes(), "mime_type": "image/jpeg"},
            {"filename": "b.jpg", "bytes": _fake_jpeg_bytes(), "mime_type": "image/jpeg"},
        ]
        # Gemini only found card 1 in this composite — card 2 must not be silently dropped.
        gemini_array = [{"index": 1, "name": "Gengar", "name_en": "Gengar", "language": "en"}]

        class FakeClient:
            async def post(self, *args, **kwargs):
                return _fake_gemini_text_response(json.dumps(gemini_array))

        async def fake_match(db, api_key, gemini_url, card_info, image_b64, mime_type):
            return {"recognized": card_info, "matches": []}

        with patch("api.recognize.httpx.AsyncClient") as mock_client_cls, \
                patch("api.recognize._match_card_info", side_effect=fake_match):
            mock_client_cls.return_value.__aenter__.return_value = FakeClient()
            out = await _recognize_composite_chunk(db=None, api_key="key", gemini_url="https://example.test", chunk=chunk)

        self.assertNotIn("error", out[0])
        self.assertIn("error", out[1])
        self.assertEqual(out[1]["filename"], "b.jpg")

    async def test_whole_chunk_failure_produces_an_error_per_item(self):
        chunk = [
            {"filename": "a.jpg", "bytes": _fake_jpeg_bytes(), "mime_type": "image/jpeg"},
            {"filename": "b.jpg", "bytes": _fake_jpeg_bytes(), "mime_type": "image/jpeg"},
        ]

        class FailingClient:
            async def post(self, *args, **kwargs):
                raise RuntimeError("boom")

        with patch("api.recognize.httpx.AsyncClient") as mock_client_cls:
            mock_client_cls.return_value.__aenter__.return_value = FailingClient()
            out = await _recognize_composite_chunk(db=None, api_key="key", gemini_url="https://example.test", chunk=chunk)

        self.assertEqual(len(out), 2)
        self.assertTrue(all("error" in item for item in out))
        self.assertEqual([item["filename"] for item in out], ["a.jpg", "b.jpg"])


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeBatchEndpointTests(unittest.TestCase):
    """Exercises real FastAPI routing/multipart binding for /recognize/batch —
    specifically that two separately-named List[UploadFile] form fields
    ("files" for batching, "singles" for the disable-batching override) both
    bind correctly from the same request, which isn't obvious from reading
    the code alone.
    """

    def setUp(self):
        app = FastAPI()
        app.include_router(recognize_router, prefix="/api/cards")

        class FakeUser:
            id = 1

        app.dependency_overrides[get_current_user] = lambda: FakeUser()
        app.dependency_overrides[get_db] = lambda: iter([None])
        self.client = TestClient(app)

    def test_rejects_when_no_photos_uploaded_at_all(self):
        resp = self.client.post("/api/cards/recognize/batch")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Keine Bilder", resp.json()["detail"])

    def test_both_file_lists_bind_and_reach_the_api_key_check(self):
        with patch.object(recognize_module, "get_gemini_key", return_value=""):
            files = [
                ("files", ("a.jpg", b"fake-a", "image/jpeg")),
                ("singles", ("b.jpg", b"fake-b", "image/jpeg")),
            ]
            resp = self.client.post("/api/cards/recognize/batch", files=files)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Gemini API Key", resp.json()["detail"])


if __name__ == "__main__":
    unittest.main()
