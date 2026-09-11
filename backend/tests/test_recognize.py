import unittest
from unittest.mock import ANY, AsyncMock, Mock, patch

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
        recognize_sanitized_card,
        retain_ranked_candidates,
        select_search_candidates,
        _search_and_rank_candidates,
    )
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
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


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed")
class ProviderCapabilityRuntimeTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _provider():
        provider = Mock()
        provider.name = "openai"
        provider.model.return_value = "single-image-model"
        provider.credential.return_value = ""
        provider.requires_credential.return_value = False
        provider.generate_text = AsyncMock(return_value=(
            '{"name":"Pikachu","name_en":"Pikachu","language":"en"}',
            None,
        ))
        return provider

    async def test_degraded_capability_disables_runtime_visual_verification(self):
        provider = self._provider()
        matcher = AsyncMock(return_value={"recognized": {}, "matches": []})
        with patch("api.recognize.get_provider", return_value=provider), patch(
            "api.recognize.require_scanner_capability_mode", return_value="degraded"
        ), patch(
            "api.recognize.resolve_scanner_request_timeout", return_value=30
        ), patch("api.recognize.match_card_info", new=matcher):
            await recognize_sanitized_card(
                object(), 7, b"image-bytes", "image/jpeg"
            )

        self.assertFalse(matcher.await_args.kwargs["allow_visual_verification"])

    async def test_changed_endpoint_proof_blocks_scanning_until_retested(self):
        provider = self._provider()
        with patch("api.recognize.get_provider", return_value=provider), patch(
            "api.recognize.require_scanner_capability_mode",
            side_effect=HTTPException(
                status_code=409,
                detail="Test and save the scanner configuration again.",
            ),
        ), patch(
            "api.recognize.resolve_scanner_request_timeout", return_value=30
        ), self.assertRaises(HTTPException) as caught:
            await recognize_sanitized_card(
                object(), 7, b"image-bytes", "image/jpeg"
            )

        self.assertEqual(caught.exception.status_code, 409)
        provider.generate_text.assert_not_awaited()

    async def test_saved_timeout_reaches_extraction_and_visual_matching(self):
        provider = self._provider()
        matcher = AsyncMock(return_value={"recognized": {}, "matches": []})
        observed = {}

        async def generate(client, *_args, **_kwargs):
            observed["timeout"] = client.timeout.read
            return '{"name":"Pikachu","language":"en"}', None

        provider.generate_text = AsyncMock(side_effect=generate)
        with patch("api.recognize.get_provider", return_value=provider), patch(
            "api.recognize.require_scanner_capability_mode", return_value="full"
        ), patch(
            "api.recognize.resolve_scanner_request_timeout", return_value=120
        ) as resolver, patch("api.recognize.match_card_info", new=matcher):
            await recognize_sanitized_card(object(), 7, b"image-bytes", "image/jpeg")

        resolver.assert_called_once_with(ANY, 7, "openai")
        self.assertEqual(observed["timeout"], 120)
        self.assertEqual(matcher.await_args.kwargs["request_timeout_seconds"], 120)


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

    def test_discards_explicit_pokedex_references_from_either_number_field(self):
        for card_info in (
            {"number_local": "No. 0094"},
            {"number_local": "no94"},
            {"number_local": "NO.152"},
            {"number": "No. 0156"},
        ):
            with self.subTest(card_info=card_info):
                normalized = normalize_recognized_card_info(card_info)
                self.assertIsNone(normalized["number_local"])
                self.assertIsNone(normalized["number"])

    def test_preserves_bare_collector_numbers_regardless_of_magnitude(self):
        for number in ("030", "094", "226"):
            with self.subTest(number=number):
                normalized = normalize_recognized_card_info({"number_local": number})
                self.assertEqual(normalized["number_local"], number)
                self.assertEqual(normalized["number"], number)

    def test_invalid_split_number_does_not_hide_a_valid_legacy_number(self):
        normalized = normalize_recognized_card_info({
            "number_local": "No. 0156",
            "number": "12/100",
        })

        self.assertEqual(normalized["number_local"], "12")
        self.assertEqual(normalized["number"], "12/100")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed")
class SearchAndRankCandidatesLocalDbTests(unittest.IsolatedAsyncioTestCase):
    """`_search_and_rank_candidates` now matches against the local `cards`
    table instead of calling the live TCGdex search API, so these seed an
    in-memory SQLite DB (same harness as tests/test_accent_search.py) rather
    than mocking httpx."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()

    def tearDown(self):
        self.db.close()

    async def test_finds_local_card_by_exact_name_and_number(self):
        # Regression case: a real scan recognized "Bill" but TCGdex live
        # search was briefly unreachable even though the local catalogue
        # already had the matching row.
        self.db.add(Card(
            id="base4-118_en",
            tcg_card_id="base4-118",
            name="Bill",
            number="118",
            rarity="Common",
            images_small="https://assets.tcgdex.net/en/base/base4/118/low.webp",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        candidates, number_match_count = await _search_and_rank_candidates(
            self.db, {"name": "Bill", "number_local": "118", "language": "en"}
        )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["id"], "base4-118_en")
        self.assertEqual(candidate["tcg_card_id"], "base4-118")
        self.assertEqual(candidate["name"], "Bill")
        self.assertEqual(candidate["number"], "118")
        self.assertEqual(
            candidate["image"], "https://assets.tcgdex.net/en/base/base4/118/low.webp"
        )
        self.assertEqual(candidate["rarity"], "Common")
        self.assertEqual(candidate["lang"], "en")
        self.assertEqual(candidate["_lang"], "en")
        self.assertEqual(number_match_count, 1)

    async def test_number_match_beyond_query_cap_still_floats_to_top(self):
        cards = [
            Card(
                id=f"aa-{number:03}_en",
                tcg_card_id=f"aa-{number:03}",
                name="Energy Test",
                number=str(1000 + number),
                lang="en",
                is_custom=False,
            )
            for number in range(60)
        ]
        cards.append(Card(
            id="zz-63_en",
            tcg_card_id="zz-63",
            name="Energy Test",
            number="63",
            lang="en",
            is_custom=False,
        ))
        cards.append(Card(
            id="zz-tg1_en",
            tcg_card_id="zz-tg1",
            name="Energy Test",
            number="TG1",
            lang="en",
            is_custom=False,
        ))
        self.db.add_all(cards)
        self.db.commit()

        candidates, number_match_count = await _search_and_rank_candidates(
            self.db,
            {"name": "Energy Test", "number_local": "063", "language": "en"},
        )

        self.assertEqual(len(candidates), 9)
        self.assertEqual(number_match_count, 1)
        # The deterministic ranker sorts the agreeing number match first even
        # though it fell outside both the local query cap and
        # select_search_candidates' baseline_limit=8.
        self.assertEqual(candidates[0]["id"], "zz-63_en")
        self.assertEqual(
            {card["id"] for card in candidates if card["id"] != "zz-63_en"},
            {f"aa-{number:03}_en" for number in range(8)},
        )

        alphanumeric, alphanumeric_count = await _search_and_rank_candidates(
            self.db,
            {"name": "Energy Test", "number_local": "TG01", "language": "en"},
        )
        self.assertEqual(alphanumeric[0]["id"], "zz-tg1_en")
        self.assertEqual(alphanumeric_count, 1)

    async def test_legacy_null_custom_flag_remains_searchable(self):
        row = Card(
            id="base4-118_en",
            tcg_card_id="base4-118",
            name="Bill",
            number="118",
            lang="en",
            is_custom=False,
        )
        self.db.add(row)
        self.db.commit()
        # SQLAlchemy applies the Python default on insert, so write the legacy
        # state directly. Older upgraded databases can still contain NULL.
        self.db.execute(
            text("UPDATE cards SET is_custom = NULL WHERE id = :id"),
            {"id": row.id},
        )
        self.db.commit()

        with self._mock_tcgdex_client([]) as mock_client:
            candidates, _ = await _search_and_rank_candidates(
                self.db,
                {"name": "Bill", "number_local": "118", "language": "en"},
            )

        mock_client.assert_not_called()
        self.assertEqual([card["id"] for card in candidates], ["base4-118_en"])

    async def test_local_rows_without_catalogue_id_are_excluded(self):
        self.db.add(Card(
            id="orphan_en",
            tcg_card_id=None,
            name="Bill",
            number="118",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        with self._mock_tcgdex_client([]):
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": "Bill", "language": "en"}
            )

        self.assertEqual(candidates, [])

    async def test_substring_number_collision_uses_live_fallback(self):
        # A local Mewtwo must not satisfy a scan for Mew merely because both
        # happen to use the same collector number. Candidate ranking does not
        # compare names, so admitting this row could auto-file the wrong card.
        self.db.add(Card(
            id="mewtwo-4_en",
            tcg_card_id="mewtwo-4",
            name="Mewtwo",
            number="4",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()
        api_payload = [{"id": "mew-4", "name": "Mew", "localId": "4"}]

        with self._mock_tcgdex_client(api_payload) as mock_client:
            candidates, number_match_count = await _search_and_rank_candidates(
                self.db,
                {"name": "Mew", "number_local": "4", "language": "en"},
            )

        mock_client.assert_called()
        self.assertEqual([card["id"] for card in candidates], ["mew-4_en"])
        self.assertEqual(number_match_count, 1)

    async def test_live_fallback_excludes_substring_number_collision(self):
        # TCGdex name search is substring-based too: searching for Mew can
        # return Mewtwo. The live path must apply the same complete-name guard
        # as the local catalogue before metadata ranking can mark a match safe.
        api_payload = [{"id": "mewtwo-4", "name": "Mewtwo", "localId": "4"}]

        with self._mock_tcgdex_client(api_payload):
            candidates, number_match_count = await _search_and_rank_candidates(
                self.db,
                {"name": "Mew", "number_local": "4", "language": "en"},
            )

        self.assertEqual(candidates, [])
        self.assertEqual(number_match_count, 0)

    async def test_substring_collision_without_number_uses_live_fallback(self):
        self.db.add(Card(
            id="energy-switch-1_en",
            tcg_card_id="energy-switch-1",
            name="Energy Switch",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()
        api_payload = [{"id": "switch-2", "name": "Switch", "localId": "2"}]

        with self._mock_tcgdex_client(api_payload) as mock_client:
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": "Switch", "language": "en"}
            )

        mock_client.assert_called()
        self.assertEqual([card["id"] for card in candidates], ["switch-2_en"])

    async def test_suffix_only_rows_do_not_displace_exact_printed_name(self):
        self.db.add_all([
            Card(
                id=f"aa-{index:03}_en",
                tcg_card_id=f"aa-{index:03}",
                name="Pikachu",
                number=str(index),
                lang="en",
                is_custom=False,
            )
            for index in range(60)
        ])
        self.db.add(Card(
            id="zz-pikachu-v_en",
            tcg_card_id="zz-pikachu-v",
            name="Pikachu V",
            number="200",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        candidates, _ = await _search_and_rank_candidates(
            self.db, {"name": "Pikachu V", "language": "en"}
        )

        self.assertEqual([card["id"] for card in candidates], ["zz-pikachu-v_en"])

    async def test_local_database_errors_propagate(self):
        database_error = OperationalError("SELECT cards", {}, Exception("offline"))
        with patch.object(self.db, "query", side_effect=database_error):
            with self.assertRaises(OperationalError):
                await _search_and_rank_candidates(
                    self.db, {"name": "Bill", "language": "en"}
                )

    async def test_falls_back_to_english_when_detected_language_has_no_local_row(self):
        self.db.add(Card(
            id="base4-118_en",
            tcg_card_id="base4-118",
            name="Bill",
            number="118",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        # The "de" pair has no local row either, which now also triggers the
        # live-API fallback (see the tests further down) — mocked here to an
        # empty result so this test stays about the *local* English-fallback
        # search pair, not a live network call to the real TCGdex API.
        with self._mock_tcgdex_client([]):
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": "Bill", "number_local": "118", "language": "de"}
            )

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["id"], "base4-118_en")
        self.assertEqual(candidates[0]["lang"], "en")

    async def test_skips_ai_translation_fallback_when_native_results_are_sufficient(self):
        self.db.add_all([
            Card(
                id=f"jp-{index}_ja",
                tcg_card_id=f"jp-{index}",
                name="マグマラシ",
                number=str(index),
                lang="ja",
                is_custom=False,
            )
            for index in range(4)
        ])
        self.db.add(Card(
            id="wrong-1_en",
            tcg_card_id="wrong-1",
            name="Magmar",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        with self._mock_tcgdex_client([]) as mock_client:
            candidates, _ = await _search_and_rank_candidates(
                self.db,
                {"name": "マグマラシ", "name_en": "Magmar", "language": "ja"},
            )

        mock_client.assert_not_called()
        self.assertEqual(len(candidates), 4)
        self.assertEqual({card["_lang"] for card in candidates}, {"ja"})

    async def test_uses_ai_translation_fallback_when_native_results_are_thin(self):
        self.db.add_all([
            Card(
                id="jp-1_ja",
                tcg_card_id="jp-1",
                name="フシギダネ",
                number="1",
                lang="ja",
                is_custom=False,
            ),
            Card(
                id="base-1_en",
                tcg_card_id="base-1",
                name="Bulbasaur",
                number="1",
                lang="en",
                is_custom=False,
            ),
        ])
        self.db.commit()

        with self._mock_tcgdex_client([]) as mock_client:
            candidates, _ = await _search_and_rank_candidates(
                self.db,
                {
                    "name": "フシギダネ",
                    "name_en": "Bulbasaur",
                    "language": "ja",
                },
            )

        mock_client.assert_not_called()
        self.assertEqual({card["_lang"] for card in candidates}, {"ja", "en"})

    async def test_caps_ai_translation_fallback_without_dropping_native_results(self):
        self.db.add(Card(
            id="jp-1_ja",
            tcg_card_id="jp-1",
            name="フシギダネ",
            number="1",
            lang="ja",
            is_custom=False,
        ))
        self.db.add_all([
            Card(
                id=f"en-{index}_en",
                tcg_card_id=f"en-{index}",
                name="Bulbasaur",
                number=str(index),
                lang="en",
                is_custom=False,
            )
            for index in range(10)
        ])
        self.db.commit()

        with self._mock_tcgdex_client([]):
            candidates, _ = await _search_and_rank_candidates(
                self.db,
                {
                    "name": "フシギダネ",
                    "name_en": "Bulbasaur",
                    "language": "ja",
                },
            )

        self.assertEqual(sum(card["_lang"] == "ja" for card in candidates), 1)
        self.assertEqual(sum(card["_lang"] == "en" for card in candidates), 5)
        self.assertEqual(len(candidates), 6)

    async def test_translation_cap_preserves_a_late_exact_number_match(self):
        self.db.add(Card(
            id="jp-1_ja",
            tcg_card_id="jp-1",
            name="フシギダネ",
            number="1",
            lang="ja",
            is_custom=False,
        ))
        self.db.add_all([
            Card(
                id=f"en-{index}_en",
                tcg_card_id=f"en-{index}",
                name="Bulbasaur",
                number="999" if index == 9 else str(index),
                lang="en",
                is_custom=False,
            )
            for index in range(10)
        ])
        self.db.commit()

        with self._mock_tcgdex_client([]):
            candidates, number_match_count = await _search_and_rank_candidates(
                self.db,
                {
                    "name": "フシギダネ",
                    "name_en": "Bulbasaur",
                    "number_local": "999",
                    "language": "ja",
                },
            )

        self.assertEqual(len(candidates), 6)
        self.assertEqual(number_match_count, 1)
        self.assertEqual(candidates[0]["id"], "en-9_en")

    async def test_english_cards_do_not_search_the_ai_translation_name(self):
        self.db.add_all([
            Card(
                id="bill-1_en",
                tcg_card_id="bill-1",
                name="Bill",
                number="1",
                lang="en",
                is_custom=False,
            ),
            Card(
                id="oak-1_en",
                tcg_card_id="oak-1",
                name="Professor Oak",
                number="2",
                lang="en",
                is_custom=False,
            ),
        ])
        self.db.commit()

        candidates, _ = await _search_and_rank_candidates(
            self.db,
            {"name": "Bill", "name_en": "Professor Oak", "language": "en"},
        )

        self.assertEqual([card["name"] for card in candidates], ["Bill"])

    async def test_search_is_accent_insensitive_via_shared_text_search_helper(self):
        self.db.add(Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Pokégear 3.0",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        candidates, _ = await _search_and_rank_candidates(
            self.db, {"name": "Pokegear 3.0", "language": "en"}
        )

        self.assertEqual([c["id"] for c in candidates], ["sv1-1_en"])

    async def test_search_collapses_repeated_ocr_whitespace(self):
        self.db.add(Card(
            id="energy-switch_en",
            tcg_card_id="energy-switch",
            name="Energy Switch",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        with self._mock_tcgdex_client([]) as mock_client:
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": " Energy   Switch ", "language": "en"}
            )

        mock_client.assert_not_called()
        self.assertEqual([card["id"] for card in candidates], ["energy-switch_en"])

    async def test_custom_cards_are_excluded(self):
        self.db.add(Card(
            id="custom-1_en",
            tcg_card_id=None,
            name="Bill",
            number="118",
            lang="en",
            is_custom=True,
        ))
        self.db.commit()

        # The only local row is excluded (is_custom), so the local query is
        # empty and the live-API fallback would otherwise fire for real —
        # mocked to empty so this test stays about custom-card exclusion,
        # not live network state.
        with self._mock_tcgdex_client([]):
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": "Bill", "language": "en"}
            )

        self.assertEqual(candidates, [])

    async def test_local_set_metadata_is_attached_from_sets_table(self):
        self.db.add(Set(
            id="base4_en",
            tcg_set_id="base4",
            name="Base Set 2",
            abbreviation="B2",
            printed_total=130,
            lang="en",
        ))
        self.db.add(Card(
            id="base4-118_en",
            tcg_card_id="base4-118",
            name="Bill",
            number="118",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

        candidates, _ = await _search_and_rank_candidates(
            self.db, {"name": "Bill", "language": "en"}
        )

        self.assertEqual(candidates[0]["set"], "Base Set 2")
        self.assertEqual(candidates[0]["set_abbreviation"], "B2")
        self.assertEqual(candidates[0]["printed_total"], 130)

    async def test_records_trace_as_a_db_query_not_an_http_call(self):
        self.db.add(Card(
            id="base4-118_en",
            tcg_card_id="base4-118",
            name="Bill",
            number="118",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()
        trace = Mock()

        await _search_and_rank_candidates(
            self.db, {"name": "Bill", "language": "en"}, trace
        )

        trace.record_tcgdex.assert_any_call(
            language="en", query="Bill", status=200, count=1
        )

    @staticmethod
    def _mock_tcgdex_client(json_payload=None, *, status_code=200, raises=None):
        """Patch context manager for `async with httpx.AsyncClient(...) as client`,
        matching this codebase's existing httpx-mocking convention (see
        test_community_supporters.py) adapted for a class with no client
        injection point to hand a MockTransport to directly."""
        mock_response = Mock()
        mock_response.status_code = status_code
        mock_response.json = Mock(return_value=json_payload)
        mock_client = AsyncMock()
        if raises is not None:
            mock_client.get = AsyncMock(side_effect=raises)
        else:
            mock_client.get = AsyncMock(return_value=mock_response)
        mock_client_cls = Mock()
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        return patch("api.recognize.httpx.AsyncClient", mock_client_cls)

    async def test_local_hit_never_calls_the_live_api(self):
        # A name-compatible printing the sync already has must never pay for a
        # network round trip.
        self.db.add(Card(
            id="base4-118_en", tcg_card_id="base4-118", name="Bill",
            number="118", lang="en", is_custom=False,
        ))
        self.db.commit()

        with self._mock_tcgdex_client([{"id": "should-not-be-used"}]) as mock_cls:
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": "Bill", "language": "en"}
            )

        mock_cls.assert_not_called()
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["tcg_card_id"], "base4-118")

    async def test_local_miss_falls_back_to_live_api(self):
        # Regression case this whole feature is for: a set released after
        # the last full sync (or one a full sync has not reached yet) has
        # no local rows at all, which looks identical to "does not exist"
        # unless the live API is asked.
        api_payload = [{
            "id": "sv99-1",
            "name": "Brand New Card",
            "localId": "1",
            "image": "https://assets.tcgdex.net/en/sv/sv99/1",
            "rarity": "Rare",
        }]
        with self._mock_tcgdex_client(api_payload):
            candidates, _ = await _search_and_rank_candidates(
                self.db, {"name": "Brand New Card", "language": "en"}
            )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["id"], "sv99-1_en")
        self.assertEqual(candidate["tcg_card_id"], "sv99-1")
        self.assertEqual(candidate["number"], "1")
        self.assertEqual(
            candidate["image"], "https://assets.tcgdex.net/en/sv/sv99/1/low.webp"
        )

    async def test_missing_number_match_falls_back_for_new_reprint(self):
        # A new set can reuse an existing card name. Finding older local rows
        # is not enough when none has the collector number printed on the card.
        self.db.add(Card(
            id="old-1_en",
            tcg_card_id="old-1",
            name="Pikachu",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()
        api_payload = [{
            "id": "new-999",
            "name": "Pikachu",
            "localId": "999",
        }]

        with self._mock_tcgdex_client(api_payload) as mock_client:
            candidates, number_match_count = await _search_and_rank_candidates(
                self.db,
                {"name": "Pikachu", "number_local": "999", "language": "en"},
            )

        mock_client.assert_called()
        self.assertEqual(candidates[0]["id"], "new-999_en")
        self.assertEqual(number_match_count, 1)

    async def test_local_miss_and_api_failure_yields_no_candidates_not_an_error(self):
        # Best-effort: a network failure on the fallback must degrade to
        # "no candidates from this pair", not blow up the whole scan.
        with self._mock_tcgdex_client(raises=Exception("boom")):
            candidates, number_match_count = await _search_and_rank_candidates(
                self.db, {"name": "Totally Unknown Card", "language": "en"}
            )

        self.assertEqual(candidates, [])
        self.assertEqual(number_match_count, 0)

    async def test_api_fallback_trace_entry_is_tagged_by_source(self):
        trace = Mock()

        with self._mock_tcgdex_client([{"id": "sv99-1", "name": "New Card", "localId": "1"}]):
            await _search_and_rank_candidates(
                self.db, {"name": "New Card", "language": "en"}, trace
            )

        trace.record_tcgdex.assert_any_call(
            language="en", query="New Card", status=200, count=1,
            source="api_fallback",
        )

    async def test_local_hit_trace_entry_has_no_fallback_source_tag(self):
        # The default ("local") is implicit, not an explicit kwarg — this
        # pins that down so a future refactor cannot silently start tagging
        # every entry as api_fallback without a test noticing.
        self.db.add(Card(
            id="base4-118_en", tcg_card_id="base4-118", name="Bill",
            number="118", lang="en", is_custom=False,
        ))
        self.db.commit()
        trace = Mock()

        await _search_and_rank_candidates(
            self.db, {"name": "Bill", "language": "en"}, trace
        )

        for call in trace.record_tcgdex.call_args_list:
            self.assertNotIn("source", call.kwargs)


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

    async def test_visual_timeout_does_not_extend_reference_download_timeout(self):
        candidates = [
            {"id": "first", "number": None, "image": "first.webp"},
            {"id": "second", "number": None, "image": "second.webp"},
        ]
        provider = Mock()
        provider.name = "openai"
        provider.is_gemini = False
        provider.requires_credential.return_value = False
        provider.generate_text = AsyncMock(return_value=("2", None))
        client_timeouts = []

        class CapturingClient:
            def __init__(self, *, timeout):
                client_timeouts.append(timeout)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 0)),
        ), patch(
            "api.recognize._download_candidate_images",
            new=AsyncMock(return_value={}),
        ), patch(
            "api.recognize._phash_best_match", return_value=None
        ), patch(
            "api.recognize.httpx.AsyncClient", CapturingClient
        ):
            result = await match_card_info(
                object(),
                {"name": "Pikachu"},
                image_b64="cGhvdG8=",
                mime_type="image/jpeg",
                allow_visual_verification=True,
                provider=provider,
                request_timeout_seconds=180,
            )

        self.assertEqual(client_timeouts, [20, 180])
        self.assertEqual(provider.generate_text.await_args.kwargs["max_attempts"], 2)
        self.assertTrue(result["_identity_confident"])
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

    def test_exact_single_trainer_candidate_can_resolve_without_hp(self):
        recognized = normalize_recognized_card_info({
            "name": "Bill",
            "card_type": "trainer",
            "language": "en",
        })
        candidates = [{
            "id": "bill",
            "name": "Bill",
            "card_type": "Trainer",
            "_lang": "en",
        }]

        confident, decision = _metadata_decision(recognized, candidates)

        self.assertTrue(confident)
        self.assertEqual(decision, "sole_candidate")

    def test_exact_single_energy_candidate_can_resolve_without_hp(self):
        recognized = normalize_recognized_card_info({
            "name": "Fire Energy",
            "card_type": "energy",
            "language": "en",
        })
        candidates = [{
            "id": "fire-energy",
            "name": "Fire Energy",
            "card_type": "Energy",
            "_lang": "en",
        }]

        confident, decision = _metadata_decision(recognized, candidates)

        self.assertTrue(confident)
        self.assertEqual(decision, "sole_candidate")

    def test_single_pokemon_candidate_keeps_existing_confidence_requirements(self):
        recognized = normalize_recognized_card_info({
            "name": "Mew",
            "card_type": "pokemon",
            "language": "en",
        })
        candidates = [{"id": "mew", "name": "Mew", "_lang": "en"}]

        confident, decision = _metadata_decision(recognized, candidates)

        self.assertFalse(confident)
        self.assertIsNone(decision)

    def test_single_trainer_requires_exact_name_and_matching_language(self):
        recognized = normalize_recognized_card_info({
            "name": "Bill",
            "card_type": "trainer",
            "language": "en",
        })

        for candidate in (
            {
                "id": "wrong-name",
                "name": "Bill's Transfer",
                "card_type": "Trainer",
                "_lang": "en",
            },
            {
                "id": "wrong-language",
                "name": "Bill",
                "card_type": "Trainer",
                "_lang": "de",
            },
            {"id": "unknown-language", "name": "Bill", "card_type": "Trainer"},
            {
                "id": "wrong-type",
                "name": "Bill",
                "card_type": "Pokemon",
                "_lang": "en",
            },
            {"id": "unknown-type", "name": "Bill", "_lang": "en"},
        ):
            with self.subTest(candidate=candidate):
                confident, decision = _metadata_decision(recognized, [candidate])
                self.assertFalse(confident)
                self.assertIsNone(decision)

    def test_single_trainer_contradiction_still_prevents_confidence(self):
        recognized = normalize_recognized_card_info({
            "name": "Bill",
            "card_type": "trainer",
            "language": "en",
            "number_local": "118",
        })
        candidates = [{
            "id": "bill",
            "name": "Bill",
            "card_type": "Trainer",
            "number": "119",
            "_lang": "en",
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
