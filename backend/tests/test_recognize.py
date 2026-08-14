import unittest
from unittest.mock import AsyncMock, Mock, patch

try:
    import httpx
    from fastapi import HTTPException

    from api.recognize import (
        DEFAULT_GEMINI_MODEL,
        COMPOSITE_PROMPT,
        MAX_GEMINI_RETRY_SECONDS,
        PHASH_CANDIDATE_LIMIT,
        RECOGNIZE_PROMPT,
        _candidate_rank_key,
        _download_candidate_images,
        _metadata_decision,
        _normalize_artist,
        _perceptual_hash,
        _phash_best_match,
        build_gemini_generate_url,
        get_gemini_model,
        gemini_rate_limit_reason,
        gemini_retry_after_seconds,
        match_card_info,
        normalize_recognized_card_info,
        normalize_scanner_card_number,
        post_gemini_generate,
        prioritize_cards_by_number,
        retain_ranked_candidates,
        select_search_candidates,
    )
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
class RecognizeCardNumberTests(unittest.TestCase):
    def test_normalizes_leading_zeros_and_fractional_printed_numbers(self):
        self.assertEqual(normalize_scanner_card_number("063"), "63")
        self.assertEqual(normalize_scanner_card_number("136/182"), "136")

    def test_rejects_missing_and_non_leading_numbers(self):
        self.assertIsNone(normalize_scanner_card_number(None))
        self.assertIsNone(normalize_scanner_card_number(""))
        self.assertIsNone(normalize_scanner_card_number("No. 039"))

    def test_preserves_alphanumeric_collector_number_prefixes(self):
        self.assertEqual(normalize_scanner_card_number("TG01"), "tg1")
        self.assertEqual(normalize_scanner_card_number("GG01"), "gg1")
        self.assertEqual(normalize_scanner_card_number("SVP 001"), "svp1")
        self.assertNotEqual(
            normalize_scanner_card_number("TG01"),
            normalize_scanner_card_number("GG01"),
        )

    def test_high_numbered_match_survives_candidate_cap(self):
        cards = [
            {"id": f"card-{number}", "localId": str(number)}
            for number in range(1, 65)
        ]

        prioritized, match_count = prioritize_cards_by_number(
            cards,
            "63/100",
            number_field="localId",
        )

        self.assertEqual(match_count, 1)
        self.assertEqual(prioritized[0]["id"], "card-63")
        self.assertIn("card-63", [card["id"] for card in prioritized[:8]])

    def test_number_match_augments_instead_of_replacing_baseline_results(self):
        cards = [
            {"id": f"baseline-{number}", "localId": str(number)}
            for number in range(1, 9)
        ] + [{"id": "late-match", "localId": "63"}]

        selected = select_search_candidates(
            cards,
            "63",
            number_field="localId",
        )

        self.assertEqual(
            [card["id"] for card in selected[:8]],
            [f"baseline-{number}" for number in range(1, 9)],
        )
        self.assertEqual(selected[8]["id"], "late-match")

    def test_final_ranking_retains_eight_baseline_results_and_late_match(self):
        cards = [
            {"id": f"baseline-{number}", "localId": str(number)}
            for number in range(1, 9)
        ] + [{"id": "late-match", "localId": "63"}]
        selected = select_search_candidates(cards, "63", number_field="localId")
        candidates = [
            {
                "id": card["id"],
                "number": card["localId"],
                "_number_extra": card["_number_extra"],
            }
            for card in selected
        ]
        recognized = normalize_recognized_card_info({"number_local": "63"})
        candidates.sort(key=lambda card: _candidate_rank_key(recognized, card))

        retained = retain_ranked_candidates(candidates)

        self.assertEqual(len(retained), 9)
        self.assertEqual(retained[0]["id"], "late-match")
        self.assertEqual(
            {card["id"] for card in retained if not card["_number_extra"]},
            {f"baseline-{number}" for number in range(1, 9)},
        )

    def test_leading_zero_matches_and_preserves_stable_order(self):
        cards = [
            {"id": "before", "number": "5"},
            {"id": "first-match", "number": "063"},
            {"id": "between", "number": "9"},
            {"id": "second-match", "number": "63/100"},
            {"id": "after", "number": "70"},
        ]

        prioritized, match_count = prioritize_cards_by_number(cards, "063/100")

        self.assertEqual(match_count, 2)
        self.assertEqual(
            [card["id"] for card in prioritized],
            ["first-match", "second-match", "before", "between", "after"],
        )

    def test_missing_unusual_or_unmatched_number_keeps_original_order(self):
        cards = [
            {"id": "first", "number": "1"},
            {"id": "second", "number": "2"},
        ]

        for recognized_number in (None, "No. 039", "999"):
            with self.subTest(recognized_number=recognized_number):
                prioritized, match_count = prioritize_cards_by_number(
                    cards,
                    recognized_number,
                )
                self.assertIs(prioritized, cards)
                self.assertEqual(match_count, 0)

    def test_normalizes_legacy_and_split_recognized_numbers(self):
        legacy = normalize_recognized_card_info({"number": "136/182"})
        split = normalize_recognized_card_info({
            "number_local": "063",
            "number_total": "100",
        })
        self.assertEqual((legacy["number_local"], legacy["number_total"]), ("136", "182"))
        self.assertEqual(split["number"], "063/100")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed")
class PhashMatchingTests(unittest.IsolatedAsyncioTestCase):
    class StreamResponse:
        def __init__(self, chunks, *, status_code=200, headers=None):
            self._chunks = chunks
            self.status_code = status_code
            self.headers = headers or {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def aiter_bytes(self):
            for chunk in self._chunks:
                yield chunk

    @staticmethod
    def _image(seed: int) -> bytes:
        import io
        import random
        from PIL import Image

        rng = random.Random(seed)
        image = Image.new("RGB", (64, 64))
        image.putdata([
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(64 * 64)
        ])
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def test_picks_a_clear_visual_match(self):
        photo = self._image(7)
        candidates = [{"id": "far"}, {"id": "near"}]
        winner = _phash_best_match(
            candidates,
            photo,
            {"far": self._image(99), "near": photo},
        )
        self.assertIsNotNone(winner)
        self.assertEqual(winner["id"], "near")

    def test_matches_the_imagehash_reference_algorithm(self):
        bits = _perceptual_hash(self._image(7))
        self.assertIsNotNone(bits)
        as_hex = f"{int(''.join('1' if bit else '0' for bit in bits), 2):016x}"
        self.assertEqual(as_hex, "e0693e83b2db14cb")

    def test_abstains_when_candidates_have_the_same_artwork(self):
        photo = self._image(7)
        candidates = [{"id": "reprint-a"}, {"id": "reprint-b"}]
        self.assertIsNone(_phash_best_match(
            candidates,
            photo,
            {"reprint-a": photo, "reprint-b": photo},
        ))

    def test_abstains_without_two_downloaded_candidate_images(self):
        photo = self._image(7)
        candidates = [{"id": "one"}, {"id": "missing"}]
        self.assertIsNone(_phash_best_match(candidates, photo, {"one": photo}))

    async def test_candidate_downloads_reuse_existing_bytes(self):
        client = Mock()
        client.stream.return_value = self.StreamResponse([b"second-image"])
        candidates = [
            {"id": "first", "image": "https://assets.tcgdex.net/first.webp"},
            {"id": "second", "image": "https://assets.tcgdex.net/second.webp"},
        ]

        downloaded = await _download_candidate_images(
            client,
            candidates,
            {"first": b"first-image"},
        )

        self.assertEqual(downloaded["first"], b"first-image")
        self.assertEqual(downloaded["second"], b"second-image")
        client.stream.assert_called_once_with(
            "GET",
            "https://assets.tcgdex.net/second.webp",
            timeout=5,
        )

    async def test_candidate_download_stream_stops_at_hard_byte_limit(self):
        client = Mock()
        client.stream.return_value = self.StreamResponse(
            [b"1234", b"56"],
            headers={"content-length": "4"},
        )
        with patch("api.recognize.MAX_REFERENCE_IMAGE_BYTES", 5):
            downloaded = await _download_candidate_images(
                client,
                [{"id": "large", "image": "https://assets.tcgdex.net/large.webp"}],
            )
        self.assertEqual(downloaded, {})

    async def test_candidate_download_rejects_untrusted_image_host(self):
        client = Mock()
        downloaded = await _download_candidate_images(
            client,
            [{"id": "private", "image": "https://127.0.0.1/private.webp"}],
        )
        self.assertEqual(downloaded, {})
        client.stream.assert_not_called()

    def test_rejects_excessive_decoded_dimensions(self):
        with patch("api.recognize.MAX_REFERENCE_IMAGE_PIXELS", 100):
            self.assertIsNone(_perceptual_hash(self._image(7)))

    async def test_clear_phash_finishes_an_uncertain_match(self):
        photo = self._image(7)
        candidates = [
            {"id": "far", "number": None, "image": "far.webp"},
            {"id": "near", "number": None, "image": "near.webp"},
        ]
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 0)),
        ), patch(
            "api.recognize._download_candidate_images",
            new=AsyncMock(return_value={"far": self._image(99), "near": photo}),
        ):
            result = await match_card_info(
                object(),
                {"name": "Pikachu"},
                photo_bytes=photo,
            )

        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["_identity_decision"], "phash")
        self.assertEqual(result["matches"][0]["id"], "near")

    async def test_phash_does_not_override_known_metadata_contradiction(self):
        photo = self._image(7)
        trace = Mock()
        candidates = [
            {"id": "far", "number": "3", "image": "far.webp"},
            {"id": "near", "number": "2", "image": "near.webp"},
        ]
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 0)),
        ), patch(
            "api.recognize._download_candidate_images",
            new=AsyncMock(return_value={"far": self._image(99), "near": photo}),
        ):
            result = await match_card_info(
                object(),
                {"name": "Pikachu", "number_local": "1"},
                photo_bytes=photo,
                trace=trace,
            )

        self.assertFalse(result["_identity_confident"])
        self.assertIsNone(result["_identity_decision"])
        self.assertEqual(result["matches"][0]["id"], "far")
        trace.reject_phash.assert_called_once_with("metadata_contradiction")

    async def test_metadata_confidence_skips_phash_downloads(self):
        candidates = [
            {"id": "right", "number": "25", "image": "right.webp"},
            {"id": "wrong", "number": "26", "image": "wrong.webp"},
        ]
        downloader = AsyncMock()
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 1)),
        ), patch("api.recognize._download_candidate_images", new=downloader):
            result = await match_card_info(
                object(),
                {"name": "Pikachu", "number_local": "25"},
                photo_bytes=self._image(7),
            )

        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["_identity_decision"], "number_unique")
        downloader.assert_not_awaited()
        self.assertEqual(PHASH_CANDIDATE_LIMIT, 8)

    async def test_phash_failure_preserves_existing_gemini_visual_fallback(self):
        photo = self._image(7)
        candidates = [
            {"id": "first", "number": None, "image": "first.webp"},
            {"id": "second", "number": None, "image": "second.webp"},
        ]
        gemini_response = Mock()
        gemini_response.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": "2"}]}}]
        }
        visual_call = AsyncMock(return_value=gemini_response)
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 0)),
        ), patch(
            "api.recognize._download_candidate_images",
            new=AsyncMock(return_value={}),
        ), patch(
            "api.recognize._phash_best_match",
            side_effect=RuntimeError("unexpected pHash failure"),
        ), patch("api.recognize.post_gemini_generate", new=visual_call):
            result = await match_card_info(
                object(),
                {"name": "Pikachu"},
                api_key="key",
                image_b64="cGhvdG8=",
                mime_type="image/jpeg",
                allow_visual_verification=True,
                photo_bytes=photo,
            )

        visual_call.assert_awaited_once()
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["_identity_decision"], "gemini_visual")
        self.assertEqual(result["matches"][0]["id"], "second")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed")
class DeterministicMatchingTests(unittest.IsolatedAsyncioTestCase):
    def test_prompts_request_only_fields_used_for_matching(self):
        for prompt in (RECOGNIZE_PROMPT, COMPOSITE_PROMPT):
            for field in (
                "number_local",
                "number_total",
                "set_code",
                "regulation_mark",
                "artist",
                "hp",
            ):
                self.assertIn(field, prompt)
            for unused in ("rarity_symbol", "holo_foil_visible", "is_promo", "first_edition"):
                self.assertNotIn(unused, prompt)

    def test_unknown_is_neutral_and_contradiction_is_demoted(self):
        recognized = normalize_recognized_card_info({
            "number_local": "25",
            "number_total": "100",
            "set_code": "ABC",
        })
        matching = {
            "number": "025",
            "printed_total": 100,
            "set_abbreviation": "abc",
        }
        unknown = {"number": None, "printed_total": None, "set_abbreviation": None}
        contradiction = {
            "number": "26",
            "printed_total": 99,
            "set_abbreviation": "XYZ",
        }
        self.assertTrue(
            _candidate_rank_key(recognized, matching)
            < _candidate_rank_key(recognized, unknown)
            < _candidate_rank_key(recognized, contradiction)
        )

    def test_malformed_printed_total_is_neutral_not_a_match(self):
        recognized = normalize_recognized_card_info({"number_total": "100"})
        matching = {"printed_total": 100}
        malformed = {"printed_total": "unknown"}
        contradiction = {"printed_total": 99}

        self.assertEqual(_candidate_rank_key(recognized, matching)[2], 0)
        self.assertEqual(_candidate_rank_key(recognized, malformed)[2], 1)
        self.assertEqual(_candidate_rank_key(recognized, contradiction)[2], 2)

    def test_artist_prefix_and_hp_can_resolve_numberless_card(self):
        recognized = normalize_recognized_card_info({
            "artist": "Illus. Kagemaru  Himeno",
            "hp": "60",
        })
        candidates = [
            {"id": "wrong", "artist": "Mitsuhiro Arita", "hp": "60"},
            {"id": "right", "artist": "Kagemaru Himeno", "hp": "060"},
        ]
        candidates.sort(key=lambda card: _candidate_rank_key(recognized, card))
        confident, decision = _metadata_decision(recognized, candidates)
        self.assertEqual(_normalize_artist("Illus. Kagemaru Himeno"), "kagemaru himeno")
        self.assertEqual(candidates[0]["id"], "right")
        self.assertTrue(confident)
        self.assertEqual(decision, "artist_hp")

    def test_number_and_set_metadata_resolve_ambiguous_reprints(self):
        recognized = normalize_recognized_card_info({
            "number_local": "52",
            "number_total": "130",
        })
        candidates = [
            {"id": "reprint", "number": "52", "printed_total": 64},
            {"id": "right", "number": "052", "printed_total": 130},
        ]
        candidates.sort(key=lambda card: _candidate_rank_key(recognized, card))
        confident, decision = _metadata_decision(recognized, candidates)
        self.assertEqual(candidates[0]["id"], "right")
        self.assertTrue(confident)
        self.assertEqual(decision, "number_metadata")

    def test_detected_language_resolves_same_printing_across_languages(self):
        recognized = normalize_recognized_card_info({
            "number_local": "029",
            "language": "de",
        })
        candidates = [
            {"id": "english", "number": "29", "_lang": "en"},
            {"id": "german", "number": "029", "_lang": "de"},
        ]
        candidates.sort(key=lambda card: _candidate_rank_key(recognized, card))
        confident, decision = _metadata_decision(recognized, candidates)
        self.assertEqual(candidates[0]["id"], "german")
        self.assertTrue(confident)
        self.assertEqual(decision, "number_metadata")

    def test_contradictory_known_metadata_prevents_confidence(self):
        recognized = normalize_recognized_card_info({
            "number_local": "25",
            "number_total": "100",
            "language": "de",
        })
        candidates = [{
            "id": "contradiction",
            "number": "25",
            "printed_total": 99,
            "_lang": "en",
        }]

        confident, decision = _metadata_decision(recognized, candidates)

        self.assertFalse(confident)
        self.assertIsNone(decision)

    def test_artist_hp_does_not_override_a_contradictory_number(self):
        recognized = normalize_recognized_card_info({
            "number_local": "TG01",
            "artist": "Kagemaru Himeno",
            "hp": "60",
        })
        candidates = [{
            "id": "wrong-number",
            "number": "GG01",
            "artist": "Kagemaru Himeno",
            "hp": "60",
        }]

        confident, decision = _metadata_decision(recognized, candidates)

        self.assertFalse(confident)
        self.assertIsNone(decision)

    async def test_shared_matcher_is_used_without_visual_call_for_composites(self):
        recognized = {"name": "Pikachu", "number_local": "25"}
        candidates = [{"id": "right", "number": "25"}, {"id": "wrong", "number": "26"}]
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 1)),
        ):
            result = await match_card_info(object(), recognized)
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["_identity_decision"], "number_unique")
        self.assertEqual(result["matches"][0]["id"], "right")

    async def test_shared_matcher_returns_late_match_without_losing_baseline(self):
        recognized = {"name": "Pikachu", "number_local": "63"}
        candidates = [
            {"id": "late-match", "number": "63", "_number_extra": True},
            *[
                {
                    "id": f"baseline-{number}",
                    "number": str(number),
                    "_number_extra": False,
                }
                for number in range(1, 9)
            ],
        ]
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 1)),
        ):
            result = await match_card_info(object(), recognized)

        self.assertEqual(len(result["matches"]), 9)
        self.assertEqual(result["matches"][0]["id"], "late-match")
        self.assertIn("baseline-8", [card["id"] for card in result["matches"]])


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeErrorTests(unittest.TestCase):
    def test_extracts_retry_delay_from_gemini_retry_info(self):
        response = httpx.Response(
            429,
            json={"error": {"details": [{"retryDelay": "42.5s"}]}},
        )
        self.assertEqual(gemini_retry_after_seconds(response), 42.5)

    def test_extracts_http_date_retry_after_and_prefers_header(self):
        response = httpx.Response(
            429,
            headers={
                "date": "Sun, 09 Aug 2026 18:00:00 GMT",
                "retry-after": "Sun, 09 Aug 2026 18:00:42 GMT",
            },
            json={"error": {"details": [{"retryDelay": "90s"}]}},
        )
        self.assertEqual(gemini_retry_after_seconds(response), 42)

    def test_rejects_non_finite_and_excessive_retry_delays(self):
        excessive = MAX_GEMINI_RETRY_SECONDS + 1
        for header, body_delay in (("inf", "inf"), (str(excessive), f"{excessive}s")):
            with self.subTest(header=header):
                response = httpx.Response(
                    429,
                    headers={"retry-after": header},
                    json={"error": {"details": [{"retryDelay": body_delay}]}},
                )
                self.assertIsNone(gemini_retry_after_seconds(response))

    def test_classifies_structured_requests_per_day_quota(self):
        response = httpx.Response(
            429,
            json={"error": {"details": [{
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                "violations": [{
                    "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                    "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                }],
            }]}},
        )
        self.assertEqual(gemini_rate_limit_reason(response), "daily_quota")

    def test_unknown_quota_defaults_to_short_term_rate_limit(self):
        response = httpx.Response(429, json={"error": {"message": "Resource exhausted"}})
        self.assertEqual(gemini_rate_limit_reason(response), "rate_limit")

    def test_unstructured_daily_words_do_not_trigger_daily_classification(self):
        response = httpx.Response(
            429,
            json={"error": {
                "message": "Requests per day quota exceeded",
                "details": [{"description": "daily quota"}],
            }},
        )
        self.assertEqual(gemini_rate_limit_reason(response), "rate_limit")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class RecognizeApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_gemini_404_is_permanent_without_upstream_text(self):
        upstream_secret = "This model echoed private-key-material."

        class FakeClient:
            async def post(self, *args, **kwargs):
                return httpx.Response(
                    404,
                    json={"error": {"message": upstream_secret}},
                )

        with patch("api.recognize.acquire_gemini_slot") as acquire, \
                patch("api.recognize.logger") as provider_logger:
            acquire.return_value = None
            with self.assertRaises(HTTPException) as ctx:
                await post_gemini_generate(
                    FakeClient(),
                    "https://example.test/v1beta/models/removed-model:generateContent",
                    "key",
                    {},
                )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("removed-model", ctx.exception.detail)
        self.assertNotIn(upstream_secret, ctx.exception.detail)
        from services.scan_queue import PermanentScanError, _scan_error_from_http

        queue_error = _scan_error_from_http(ctx.exception)
        self.assertIsInstance(queue_error, PermanentScanError)
        self.assertNotIn(upstream_secret, str(queue_error))
        self.assertNotIn(upstream_secret, repr(provider_logger.mock_calls))

    async def test_other_gemini_4xx_errors_are_permanent_and_safe(self):
        upstream_secret = "arbitrary-upstream-secret"

        class FakeClient:
            def __init__(self, status_code):
                self.status_code = status_code

            async def post(self, *args, **kwargs):
                return httpx.Response(
                    self.status_code,
                    json={"error": {"message": upstream_secret}},
                )

        with patch("api.recognize.acquire_gemini_slot") as acquire:
            acquire.return_value = None
            for status_code in (409, 422):
                with self.subTest(status_code=status_code):
                    with self.assertRaises(HTTPException) as ctx:
                        await post_gemini_generate(
                            FakeClient(status_code),
                            "https://example.test/v1beta/models/test:generateContent",
                            "key",
                            {},
                        )
                    self.assertEqual(ctx.exception.status_code, 400)
                    self.assertNotIn(upstream_secret, ctx.exception.detail)
                    from services.scan_queue import PermanentScanError, _scan_error_from_http

                    queue_error = _scan_error_from_http(ctx.exception)
                    self.assertIsInstance(queue_error, PermanentScanError)
                    self.assertNotIn(upstream_secret, str(queue_error))

    async def test_gemini_429_persists_provider_retry_delay(self):
        class FakeClient:
            async def post(self, *args, **kwargs):
                return httpx.Response(429, headers={"retry-after": "37"})

        with patch("api.recognize.acquire_gemini_slot") as acquire, \
                patch("api.recognize.penalize_gemini_key") as penalize:
            acquire.return_value = None
            penalize.return_value = 37.0
            with self.assertRaises(HTTPException) as ctx:
                await post_gemini_generate(FakeClient(), "https://example.test", "key", {})

        penalize.assert_called_once_with("key", seconds=37.0, reason="rate_limit")
        self.assertEqual(ctx.exception.retry_after_seconds, 37.0)
        self.assertEqual(ctx.exception.retry_reason, "rate_limit")
        self.assertNotIn("automatisch", ctx.exception.detail)

    async def test_gemini_daily_429_uses_structured_provider_delay(self):
        class FakeClient:
            async def post(self, *args, **kwargs):
                return httpx.Response(429, json={"error": {"details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                        "violations": [{
                            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                        }],
                    },
                    {
                        "@type": "type.googleapis.com/google.rpc.RetryInfo",
                        "retryDelay": "21s",
                    },
                ]}})

        with patch("api.recognize.acquire_gemini_slot") as acquire, \
                patch("api.recognize.penalize_gemini_key", return_value=21) as penalize:
            acquire.return_value = None
            with self.assertRaises(HTTPException) as ctx:
                await post_gemini_generate(FakeClient(), "https://example.test", "key", {})

        penalize.assert_called_once_with("key", seconds=21.0, reason="daily_quota")
        self.assertEqual(ctx.exception.retry_after_seconds, 21)
        self.assertEqual(ctx.exception.retry_reason, "daily_quota")


if __name__ == "__main__":
    unittest.main()
