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
        card_set_id,
        prioritize_candidates,
        get_gemini_model,
        gemini_error_message,
        post_gemini_generate,
        router as recognize_router,
        _extract_json,
        _normalize_number,
        _numbers_match,
        _printed_total_mismatch,
        _artists_match,
        _normalize_artist,
        _recognize_composite_chunk,
        _recognize_single_image,
        gemini_quota_scope,
        DAILY_QUOTA_MARKER,
    )
    from api.auth import get_current_user
    from database import get_db
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


class _NoWaitLimiter:
    """Stand-in for the shared Gemini rate limiter so tests never sleep.

    The limiter's real pacing is covered in test_gemini_rate_limit against a
    virtual clock; here it would only add wall-clock delay to every test that
    happens to issue more calls than the burst allowance.
    """

    def __init__(self):
        self.penalties = 0

    async def acquire(self):
        return None

    def penalize(self, seconds=None):
        self.penalties += 1


class NoWaitLimiterMixin:
    def setUp(self):
        super().setUp()
        self.limiter = _NoWaitLimiter()
        patcher = patch("api.recognize.get_limiter", return_value=self.limiter)
        patcher.start()
        self.addCleanup(patcher.stop)


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
class RecognizeApiTests(NoWaitLimiterMixin, unittest.IsolatedAsyncioTestCase):
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

    async def test_rate_limit_penalizes_the_limiter_and_retries(self):
        # A 429 used to fail immediately. It now backs the shared limiter off
        # and retries, because under a limiter a 429 means "too early", not "broken".
        calls = []

        class FakeClient:
            async def post(self, *args, **kwargs):
                calls.append(1)
                if len(calls) == 1:
                    return httpx.Response(429, json={"error": {"message": "rate limited"}})
                return _fake_gemini_text_response('{"name": "Gengar"}')

        resp = await post_gemini_generate(FakeClient(), "https://example.test", "key", {})

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.limiter.penalties, 1)

    async def test_daily_quota_is_not_retried_and_says_so(self):
        # Retrying a daily exhaustion only produces failing calls: the allowance
        # is gone for hours. Shape taken from a real exhausted free-tier key.
        calls = []
        daily_body = {"error": {"code": 429, "details": [{
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            "violations": [{
                "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                "quotaValue": "20",
            }],
        }, {
            # Present but useless: observed reporting seconds while the daily
            # quota stayed exhausted, so it must not drive a retry.
            "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "29s",
        }]}}

        class DailyLimited:
            async def post(self, *args, **kwargs):
                calls.append(1)
                return httpx.Response(429, json=daily_body)

        with self.assertRaises(HTTPException) as ctx:
            await post_gemini_generate(DailyLimited(), "https://example.test", "key", {})

        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(len(calls), 1, "a daily quota must not be retried")
        self.assertIn(DAILY_QUOTA_MARKER, ctx.exception.detail)

    async def test_rate_limit_still_surfaces_once_retries_are_exhausted(self):
        class AlwaysLimited:
            async def post(self, *args, **kwargs):
                return httpx.Response(429, json={"error": {"message": "rate limited"}})

        with self.assertRaises(HTTPException) as ctx:
            await post_gemini_generate(AlwaysLimited(), "https://example.test", "key", {}, max_attempts=2)

        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(self.limiter.penalties, 2)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class QuotaScopeTests(unittest.TestCase):
    @staticmethod
    def _resp(quota_id):
        return httpx.Response(429, json={"error": {"details": [{
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            "violations": [{"quotaId": quota_id}],
        }]}})

    def test_identifies_a_daily_quota(self):
        self.assertEqual(
            gemini_quota_scope(self._resp("GenerateRequestsPerDayPerProjectPerModel-FreeTier")),
            "daily",
        )

    def test_identifies_a_per_minute_quota(self):
        self.assertEqual(
            gemini_quota_scope(self._resp("GenerateRequestsPerMinutePerProjectPerModel-FreeTier")),
            "minute",
        )

    def test_unrecognised_or_bodyless_responses_are_unknown(self):
        # Unknown must behave like the old short-backoff path, never like a
        # daily exhaustion that stops the queue for an hour.
        self.assertEqual(gemini_quota_scope(self._resp("SomethingElse")), "unknown")
        self.assertEqual(gemini_quota_scope(httpx.Response(429, text="not json")), "unknown")
        self.assertEqual(gemini_quota_scope(httpx.Response(429, json={})), "unknown")


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

    def test_false_means_no_evidence_not_agreement(self):
        # Regression guard: this returns False both for "they agree" and for
        # "we have no total to compare". Callers that rank on it must set the
        # flag only when a total was actually read, or every candidate in a
        # synced set looks like a confirmed match and outranks the right card.
        no_evidence = _printed_total_mismatch(None, 88)
        agreement = _printed_total_mismatch("088", 88)
        self.assertEqual(no_evidence, agreement)
        self.assertIsNone(_normalize_number(None))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class PhashMatchTests(unittest.IsolatedAsyncioTestCase):
    """The pHash re-rank must only fire when the answer is unambiguous.

    Benchmarking showed a wrong same-artwork reprint can score *better* than the
    correct card, so distance alone is not trustworthy — the margin to the
    runner-up is the guard, and anything close defers to Gemini.
    """

    @staticmethod
    def _solid(seed):
        """A deterministic textured image.

        Deliberately not a flat colour: pHash is a DCT over frequency content,
        so every solid image hashes identically and the fixture would prove
        nothing.
        """
        import io as _io
        import random
        from PIL import Image
        rng = random.Random(seed)
        img = Image.new("RGB", (64, 64))
        img.putdata([
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(64 * 64)
        ])
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _patch_downloads(self, mapping):
        class FakeResp:
            def __init__(self, content):
                self.status_code = 200
                self.content = content

        class FakeClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, url, *a, **k): return FakeResp(mapping[url])

        return patch("api.recognize.httpx.AsyncClient", return_value=FakeClient())

    async def test_returns_none_without_enough_images_to_compare(self):
        from api.recognize import _phash_best_match
        photo = self._solid(1)
        self.assertIsNone(await _phash_best_match([{"image": "u1"}], photo))
        self.assertIsNone(await _phash_best_match([{"image": None}, {"image": None}], photo))

    async def test_returns_none_without_a_photo(self):
        from api.recognize import _phash_best_match
        self.assertIsNone(await _phash_best_match([{"image": "u1"}, {"image": "u2"}], None))

    async def test_picks_the_visually_identical_candidate(self):
        from api.recognize import _phash_best_match
        photo = self._solid(7)
        cands = [
            {"tcg_card_id": "far", "image": "u_far"},
            {"tcg_card_id": "near", "image": "u_near"},
        ]
        mapping = {"u_far": self._solid(99), "u_near": photo}
        with self._patch_downloads(mapping):
            winner = await _phash_best_match(cands, photo)
        self.assertIsNotNone(winner)
        self.assertEqual(winner["tcg_card_id"], "near")

    async def test_defers_when_two_candidates_are_too_close(self):
        # Same-artwork reprints land within a hair of each other; picking one
        # would be a coin flip, so it must hand back to Gemini instead.
        from api.recognize import _phash_best_match
        photo = self._solid(7)
        cands = [
            {"tcg_card_id": "reprint_a", "image": "u_a"},
            {"tcg_card_id": "reprint_b", "image": "u_b"},
        ]
        mapping = {"u_a": photo, "u_b": photo}  # identical -> zero margin
        with self._patch_downloads(mapping):
            self.assertIsNone(await _phash_best_match(cands, photo))

    async def test_download_failure_is_non_fatal(self):
        from api.recognize import _phash_best_match
        photo = self._solid(7)

        class BoomClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, *a, **k): raise RuntimeError("network down")

        with patch("api.recognize.httpx.AsyncClient", return_value=BoomClient()):
            self.assertIsNone(await _phash_best_match(
                [{"image": "u1"}, {"image": "u2"}], photo
            ))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class PromptConsistencyTests(unittest.TestCase):
    """The batch prompt must extract every field ranking depends on.

    It previously omitted artist and hp, which silently made the artist/HP
    tie-break inert for batched photos — the ranking behaved differently
    depending on whether a card was composited or sent alone.
    """

    RANKING_FIELDS = ("number_local", "number_total", "set_code", "artist", "hp",
                      "energy_type")

    def test_batch_prompt_requests_every_field_ranking_uses(self):
        batch = recognize_module.BATCH_PROMPT_TEMPLATE
        for field in self.RANKING_FIELDS:
            self.assertIn(field, batch, f"batch prompt must ask for {field}")

    def test_single_prompt_requests_every_field_ranking_uses(self):
        single = recognize_module.RECOGNIZE_PROMPT
        for field in self.RANKING_FIELDS:
            self.assertIn(field, single, f"single prompt must ask for {field}")

    def test_both_prompts_keep_the_anti_hallucination_rule_for_set_code(self):
        # Real-card testing showed Gemini filling set_code from training data for
        # cards that print none; this wording is what stopped it.
        for prompt in (recognize_module.RECOGNIZE_PROMPT, recognize_module.BATCH_PROMPT_TEMPLATE):
            self.assertIn("guessing from memory is not allowed", prompt)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class CandidatePrioritisationTests(unittest.TestCase):
    """Only the first few results of each TCGdex search survive the per-search cap,
    so anything the photo identified has to be floated above it first.
    """

    CARDS = [
        {"id": "tk-bw-e-2", "localId": "2"},
        {"id": "tk-xy-latio-3", "localId": "3"},
        {"id": "mee-006", "localId": "006"},
        {"id": "sve-006", "localId": "006"},
    ]

    def ids(self, cards):
        return [c["id"] for c in cards]

    def test_number_alone_floats_every_printing_with_that_number(self):
        out = self.ids(prioritize_candidates(self.CARDS, "6", set()))
        self.assertEqual(out[:2], ["mee-006", "sve-006"])

    def test_set_alone_floats_the_right_printing(self):
        # The real failure: "MEE" was read, the number was not, and mee-006 was
        # cut from a 51-result search in favour of unrelated trainer kits.
        out = self.ids(prioritize_candidates(self.CARDS, None, {"mee"}))
        self.assertEqual(out[0], "mee-006")

    def test_both_signals_beat_either_alone(self):
        out = self.ids(prioritize_candidates(self.CARDS, "6", {"mee"}))
        self.assertEqual(out[0], "mee-006")
        self.assertEqual(out[1], "sve-006")

    def test_no_signal_leaves_the_order_untouched(self):
        self.assertEqual(self.ids(prioritize_candidates(self.CARDS, None, set())),
                         self.ids(self.CARDS))

    def test_a_signal_that_matches_nothing_leaves_the_order_untouched(self):
        # Ranking downstream still gets to see every candidate; a misread code
        # must not silently reshuffle them.
        self.assertEqual(self.ids(prioritize_candidates(self.CARDS, "999", {"xyz"})),
                         self.ids(self.CARDS))

    def test_padding_differences_still_count_as_a_number_match(self):
        self.assertEqual(
            self.ids(prioritize_candidates(self.CARDS, "006", set()))[:2],
            ["mee-006", "sve-006"],
        )

    def test_set_id_survives_a_dotted_set(self):
        self.assertEqual(card_set_id({"id": "me02.5-022"}), "me02.5")
        self.assertEqual(card_set_id({"id": "sv06.5-098"}), "sv06.5")
        self.assertEqual(card_set_id({}), "")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class ArtistMatchTests(unittest.TestCase):
    def test_folds_case_and_whitespace(self):
        self.assertEqual(_normalize_artist("  Kagemaru   Himeno "), "kagemaru himeno")
        self.assertTrue(_artists_match("Kagemaru Himeno", "kagemaru  himeno"))

    def test_strips_the_printed_illus_prefix(self):
        # Cards print "Illus. <name>" but TCGdex stores the bare name, and the
        # batch prompt was observed returning the prefix while the single prompt
        # did not — matching must not depend on that.
        self.assertEqual(_normalize_artist("Illus. Masako Tomii"), "masako tomii")
        self.assertEqual(_normalize_artist("Illustrator: Ken Sugimori"), "ken sugimori")
        self.assertTrue(_artists_match("Illus. Kagemaru Himeno", "Kagemaru Himeno"))

    def test_does_not_eat_a_name_that_merely_starts_similarly(self):
        # "Illustration Studio" is a plausible studio credit — the prefix token
        # has to end at a separator, not just share opening letters.
        self.assertEqual(_normalize_artist("Illustration Studio"), "illustration studio")
        self.assertEqual(_normalize_artist("Sugimori"), "sugimori")
        self.assertEqual(_normalize_artist("Studio Bora Inc."), "studio bora inc.")

    def test_different_artists_do_not_match(self):
        self.assertFalse(_artists_match("Kagemaru Himeno", "Ken Sugimori"))

    def test_missing_artist_never_matches(self):
        # Unknown must be neutral, not a false positive that promotes a wrong card.
        self.assertIsNone(_normalize_artist(None))
        self.assertIsNone(_normalize_artist("   "))
        self.assertFalse(_artists_match(None, "Ken Sugimori"))
        self.assertFalse(_artists_match("Ken Sugimori", None))
        self.assertFalse(_artists_match(None, None))


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
class RecognizeSingleImageTests(NoWaitLimiterMixin, unittest.IsolatedAsyncioTestCase):
    async def test_parses_card_info_from_gemini_response(self):
        card_info = {"name": "Gengar", "name_en": "Gengar", "number_local": "050", "language": "en"}

        class FakeClient:
            async def post(self, *args, **kwargs):
                return _fake_gemini_text_response(json.dumps(card_info))

        # Real base64: recognition now decodes the image so it can retry at
        # other orientations when a read yields no name.
        import base64 as _b64
        image_b64 = _b64.b64encode(_fake_jpeg_bytes()).decode()
        result = await _recognize_single_image(
            FakeClient(), "https://example.test", "key", image_b64, "image/jpeg"
        )
        self.assertEqual(result, card_info)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RotationFallbackTests(NoWaitLimiterMixin, unittest.IsolatedAsyncioTestCase):
    """A card photographed upside down read as an empty name and the scan failed
    outright — the name is the only thing the search has to go on. Observed on a
    real card in a 72-card set.
    """

    def setUp(self):
        super().setUp()
        import base64
        self.image_b64 = base64.b64encode(_fake_jpeg_bytes()).decode()

    async def test_retries_other_orientations_when_no_name_is_read(self):
        attempts = []

        async def fake_extract(client, url, key, image_bytes, mime):
            attempts.append(len(image_bytes))
            # Fail until the third orientation has been tried.
            if len(attempts) < 3:
                return {"name": ""}, "{}", None
            return {"name": "Energy"}, '{"name":"Energy"}', None

        with patch.object(recognize_module, "_extract_fields", side_effect=fake_extract):
            result = await _recognize_single_image(
                None, "https://example.test", "key", self.image_b64, "image/jpeg"
            )

        self.assertEqual(result["name"], "Energy")
        self.assertEqual(len(attempts), 3, "should have rotated until a name appeared")

    async def test_upright_cards_are_not_rotated_at_all(self):
        calls = []

        async def fake_extract(client, url, key, image_bytes, mime):
            calls.append(1)
            return {"name": "Gengar"}, '{"name":"Gengar"}', None

        with patch.object(recognize_module, "_extract_fields", side_effect=fake_extract):
            await _recognize_single_image(
                None, "https://example.test", "key", self.image_b64, "image/jpeg"
            )

        self.assertEqual(len(calls), 1, "a successful read must cost exactly one call")

    async def test_gives_up_after_every_orientation(self):
        calls = []

        async def fake_extract(client, url, key, image_bytes, mime):
            calls.append(1)
            return {"name": None}, "{}", None

        with patch.object(recognize_module, "_extract_fields", side_effect=fake_extract):
            result = await _recognize_single_image(
                None, "https://example.test", "key", self.image_b64, "image/jpeg"
            )

        # One upright attempt plus each fallback, then stop — never unbounded.
        self.assertEqual(len(calls), 1 + len(recognize_module.ROTATION_FALLBACKS))
        self.assertIsNone(result.get("name"))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeCompositeChunkTests(NoWaitLimiterMixin, unittest.IsolatedAsyncioTestCase):
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

        async def fake_match(db, api_key, gemini_url, card_info, image_b64, mime_type, trace=None):
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

        async def fake_match(db, api_key, gemini_url, card_info, image_b64, mime_type, trace=None):
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
        app.dependency_overrides[get_db] = lambda: None
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


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class CandidateRankingTests(NoWaitLimiterMixin, unittest.IsolatedAsyncioTestCase):
    """Ranking behaviour for the numberless-card case.

    Modelled on a real failure: a 1997 Japanese Jungle Jigglypuff prints no card
    number and no set code, so number ranking has nothing to sort on. TCGdex also
    has no image for it, so visual verification cannot rank it either — artist and
    HP are the only remaining signals.
    """

    JA_CANDIDATES = [
        {"id": "SV2D-026_ja", "tcg_card_id": "SV2D-026", "name": "プリン", "number": "026",
         "image": "https://img/026", "_lang": "ja", "artist": "Yuu Nishida", "hp": "70"},
        {"id": "PMCG2-035_ja", "tcg_card_id": "PMCG2-035", "name": "プリン", "number": "035",
         "image": None, "_lang": "ja", "artist": "Kagemaru Himeno", "hp": "60"},
        {"id": "SV2a-039_ja", "tcg_card_id": "SV2a-039", "name": "プリン", "number": "039",
         "image": "https://img/039", "_lang": "ja", "artist": "saino misaki", "hp": "70"},
    ]

    async def test_artist_and_hp_promote_the_right_card_when_there_is_no_number(self):
        from api.recognize import _artists_match, _numbers_match

        card_info = {"artist": "Kagemaru Himeno", "hp": "60"}
        # Same key the endpoint uses when number/set_code are absent.
        def rank_key(card):
            artist_ok = 0 if _artists_match(card_info["artist"], card.get("artist")) else 1
            hp_ok = 0 if _numbers_match(card_info["hp"], card.get("hp")) else 1
            return (artist_ok, hp_ok)

        ranked = sorted(self.JA_CANDIDATES, key=rank_key)
        self.assertEqual(ranked[0]["tcg_card_id"], "PMCG2-035")

    async def test_detail_fetch_fills_artist_and_hp_from_tcgdex(self):
        from api.recognize import _fill_candidate_details

        candidates = [
            {"id": "PMCG2-035_ja", "tcg_card_id": "PMCG2-035", "_lang": "ja"},
        ]

        class FakeResp:
            status_code = 200
            @staticmethod
            def json():
                return {"illustrator": "Kagemaru Himeno", "hp": 60}

        class FakeClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, *a, **k): return FakeResp()

        class FakeQuery:
            def filter(self, *a, **k): return self
            def all(self): return []

        class FakeDb:
            def query(self, *a, **k): return FakeQuery()

        with patch("api.recognize.httpx.AsyncClient", return_value=FakeClient()):
            await _fill_candidate_details(FakeDb(), candidates)

        self.assertEqual(candidates[0]["artist"], "Kagemaru Himeno")
        self.assertEqual(candidates[0]["hp"], 60)

    async def test_detail_fetch_failure_is_non_fatal(self):
        from api.recognize import _fill_candidate_details

        candidates = [{"id": "X-1_ja", "tcg_card_id": "X-1", "_lang": "ja"}]

        class BoomClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def get(self, *a, **k): raise RuntimeError("network down")

        class FakeQuery:
            def filter(self, *a, **k): return self
            def all(self): return []

        class FakeDb:
            def query(self, *a, **k): return FakeQuery()

        with patch("api.recognize.httpx.AsyncClient", return_value=BoomClient()):
            await _fill_candidate_details(FakeDb(), candidates)

        # No artist/hp added, but no exception — it is a tie-break, not a requirement.
        self.assertIsNone(candidates[0].get("artist"))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class ScanJobEndpointTests(unittest.TestCase):
    """The queue endpoints against a real DB session, including the ownership
    checks — a scan job holds the user's uploaded photos, so another account
    must not be able to read or delete one.
    """

    def setUp(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool
        from database import Base
        from models import User

        # TestClient serves requests on another thread, so an in-memory SQLite
        # DB has to share one connection across threads to stay visible.
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        self.owner = User(username="owner", hashed_password="x")
        self.other = User(username="other", hashed_password="x")
        self.db.add_all([self.owner, self.other])
        self.db.commit()
        self.current_user = self.owner

        app = FastAPI()
        app.include_router(recognize_router, prefix="/api/cards")
        app.dependency_overrides[get_current_user] = lambda: self.current_user
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.db.close()

    def _enqueue(self):
        with patch.object(recognize_module, "get_gemini_key", return_value="key"), \
                patch.object(recognize_module, "drain_scan_queue", new=lambda: None):
            resp = self.client.post(
                "/api/cards/recognize/batch",
                files=[("files", ("a.jpg", _fake_jpeg_bytes(), "image/jpeg"))],
            )
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_enqueue_returns_a_job_without_waiting_for_recognition(self):
        body = self._enqueue()
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["done"], 0)

    def test_job_detail_lists_items(self):
        job = self._enqueue()
        resp = self.client.get(f"/api/cards/recognize/jobs/{job['id']}")
        self.assertEqual(resp.status_code, 200)
        items = resp.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["has_image"])

    def test_another_user_cannot_read_a_job(self):
        job = self._enqueue()
        self.current_user = self.other
        resp = self.client.get(f"/api/cards/recognize/jobs/{job['id']}")
        self.assertEqual(resp.status_code, 404)

    def test_another_user_cannot_delete_a_job(self):
        job = self._enqueue()
        self.current_user = self.other
        resp = self.client.delete(f"/api/cards/recognize/jobs/{job['id']}")
        self.assertEqual(resp.status_code, 404)

    def test_item_image_is_served_then_gone_after_resolve(self):
        from models import ScanJobItem

        job = self._enqueue()
        item = self.db.query(ScanJobItem).first()

        resp = self.client.get(f"/api/cards/recognize/jobs/{job['id']}/items/{item.id}/image")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.content)

        resolved = self.client.post(f"/api/cards/recognize/jobs/{job['id']}/items/{item.id}/resolve")
        self.assertEqual(resolved.status_code, 200)
        self.assertTrue(resolved.json()["resolved"])

        gone = self.client.get(f"/api/cards/recognize/jobs/{job['id']}/items/{item.id}/image")
        self.assertEqual(gone.status_code, 404)

    def test_listing_only_returns_the_callers_own_jobs(self):
        self._enqueue()
        self.current_user = self.other
        resp = self.client.get("/api/cards/recognize/jobs")
        self.assertEqual(resp.json()["jobs"], [])


if __name__ == "__main__":
    unittest.main()
