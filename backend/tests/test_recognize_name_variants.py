"""Printed names match catalogue names written with a trailing qualifier or
different separators and punctuation, in local retrieval and in the live
TCGdex fallback. Identity symbols still distinguish names.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch
from fastapi import HTTPException

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
    from api.recognize import (
        _name_search_terms,
        _scanner_names_compatible,
        _search_and_rank_candidates,
        match_card_info,
    )
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


class LocalCatalogueTestCase(unittest.IsolatedAsyncioTestCase):
    """In-memory catalogue; live TCGdex lookups are stubbed out."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.fallback = AsyncMock(return_value=([], True))
        for target, value in (("api.recognize._api_search_fallback", self.fallback),
                              ("api.recognize._fill_candidate_details", AsyncMock(return_value=None))):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.db.close()

    def card(self, card_id, name, number, **fields):
        tcg_id, lang = card_id.rsplit("_", 1)
        values = dict(id=card_id, tcg_card_id=tcg_id, name=name, number=number, lang=lang,
                      set_id=tcg_id.rsplit("-", 1)[0], is_custom=False,
                      images_small=f"https://assets.tcgdex.net/{lang}/x/{tcg_id}/low.webp")
        values.update(fields)
        return Card(**values)

    async def candidate_ids(self, **read):
        candidates, _ = await _search_and_rank_candidates(self.db, {"language": "en", **read})
        return [candidate["id"] for candidate in candidates]


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "backend dependencies are not installed")
class NameCompatibilityTests(unittest.TestCase):
    def test_trailing_qualifier_is_ignored_on_either_side(self):
        self.assertTrue(_scanner_names_compatible("Boss's Orders", "Boss's Orders (Giovanni)"))
        self.assertTrue(_scanner_names_compatible("Boss's Orders (Giovanni)", "Boss's Orders"))
        self.assertFalse(_scanner_names_compatible("Pikachu", "Pikachu V"))
        self.assertFalse(_scanner_names_compatible("Orders", "Boss's Orders"))
        self.assertFalse(_scanner_names_compatible("", "Boss's Orders"))

    def test_distinct_named_qualifiers_are_not_compatible(self):
        self.assertFalse(_scanner_names_compatible(
            "Professor's Research (Professor Oak)",
            "Professor's Research (Professor Sada)",
        ))

    def test_hyphen_and_space_are_the_same_separator(self):
        self.assertTrue(_scanner_names_compatible("Charizard & Braixen-GX", "Charizard & Braixen GX"))
        self.assertTrue(_scanner_names_compatible("Charizard&Braixen GX", "Charizard & Braixen GX"))
        self.assertTrue(_scanner_names_compatible("Hop\u2019s Zacian ex", "Hop's Zacian ex"))
        self.assertTrue(_scanner_names_compatible("Ho\u2014Oh", "Ho-Oh"))
        self.assertTrue(_scanner_names_compatible("Ho-Oh", "Ho\u2014Oh"))
        self.assertTrue(_scanner_names_compatible("Mr. Mime", "Mr Mime"))
        self.assertTrue(_scanner_names_compatible("Ho Oh", "Ho-Oh"))
        self.assertFalse(_scanner_names_compatible("Ho-Oh", "Ho-Oh GX"))
        self.assertFalse(_scanner_names_compatible("Nidoran\u2640", "Nidoran\u2642"))

    def test_search_terms(self):
        self.assertIn("Ho-Oh", _name_search_terms("Ho Oh"))
        self.assertIn("Porygon Z", _name_search_terms("Porygon-Z"))
        self.assertIn("Charizard & Braixen GX", _name_search_terms("Charizard&Braixen GX"))
        self.assertIn("Hop's Zacian ex", _name_search_terms("Hop\u2019s Zacian ex"))
        self.assertIn("Boss's Orders", _name_search_terms("Boss's Orders (Giovanni)"))
        self.assertEqual(_name_search_terms("Pikachu"), ["Pikachu"])


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "backend dependencies are not installed")
class NameRetrievalTests(LocalCatalogueTestCase):
    async def test_qualified_catalogue_name_is_a_candidate(self):
        self.db.add(self.card("swsh2-200_en", "Boss's Orders (Giovanni)", "200"))
        self.db.commit()
        self.assertEqual(await self.candidate_ids(name="Boss's Orders", number_local="200"), ["swsh2-200_en"])

    async def test_different_named_qualifier_is_excluded_from_retrieval(self):
        self.db.add(self.card(
            "sv08-112_en",
            "Professor's Research (Professor Sada)",
            "112",
        ))
        self.db.commit()
        self.assertEqual(
            await self.candidate_ids(
                name="Professor's Research (Professor Oak)",
                number_local="112",
            ),
            [],
        )

    async def test_local_search_is_punctuation_insensitive_in_both_directions(self):
        cases = [
            ("Mr. Mime", "Mr Mime", "1"),
            ("Mr Mime", "Mr. Mime", "2"),
            ("Hop's Zacian ex", "Hops Zacian ex", "3"),
            ("Hops Zacian ex", "Hop's Zacian ex", "4"),
            ("Charizard&Braixen GX", "Charizard & Braixen GX", "5"),
            ("Charizard & Braixen GX", "Charizard&Braixen GX", "6"),
            ("Ho-Oh", "Ho\u2014Oh", "7"),
            ("Ho\u2014Oh", "Ho-Oh", "8"),
        ]
        for catalogue_name, read_name, number in cases:
            with self.subTest(catalogue_name=catalogue_name, read_name=read_name):
                self.db.query(Card).delete(synchronize_session=False)
                card_id = f"scan-{number}_en"
                self.db.add(self.card(card_id, catalogue_name, number))
                self.db.commit()
                self.assertIn(
                    card_id,
                    await self.candidate_ids(name=read_name, number_local=number),
                )

    async def test_local_punctuation_variant_can_be_confidently_recognized(self):
        self.db.add(self.card("scan-7_en", "Mr. Mime", "7"))
        self.db.commit()
        result = await match_card_info(
            self.db,
            {"name": "Mr Mime", "number_local": "7", "language": "en"},
            allow_visual_verification=False,
        )
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], "scan-7_en")

    async def test_space_read_reaches_hyphenated_catalogue_name(self):
        self.db.add(self.card("neo2-7_en", "Ho-Oh", "7"))
        self.db.commit()
        self.assertEqual(await self.candidate_ids(name="Ho Oh", number_local="7"), ["neo2-7_en"])

    async def test_live_fallback_tries_name_variants(self):
        self.fallback.side_effect = lambda lang, term, expected, trace: (
            ([{"id": "neo2-7_en", "tcg_card_id": "neo2-7", "name": "Ho-Oh", "number": "7"}], True)
            if term == "Ho-Oh" else ([], True))
        self.assertEqual(await self.candidate_ids(name="Ho Oh", number_local="7"), ["neo2-7_en"])

    async def test_live_fallback_reaches_punctuation_variant_with_token_term(self):
        row = {
            "id": "scan-11_en",
            "tcg_card_id": "scan-11",
            "name": "Mr. Mime",
            "number": "11",
        }
        self.fallback.side_effect = lambda lang, term, expected, trace: (
            ([row], True) if term == "Mime" else ([], True)
        )
        self.assertIn(
            "scan-11_en",
            await self.candidate_ids(name="Mr Mime", number_local="11"),
        )

    async def test_live_fallback_reaches_em_dash_variant(self):
        row = {
            "id": "neo2-7_en",
            "tcg_card_id": "neo2-7",
            "name": "Ho-Oh",
            "number": "7",
        }
        self.fallback.side_effect = lambda lang, term, expected, trace: (
            ([row], True) if term == "Ho-Oh" else ([], True)
        )
        self.assertIn(
            "neo2-7_en",
            await self.candidate_ids(name="Ho\u2014Oh", number_local="7"),
        )

    async def test_fallback_query_count_is_bounded(self):
        self.fallback.return_value = ([], True)
        terms = [f"query-{index}" for index in range(20)]
        with patch("api.recognize._name_search_terms", return_value=terms):
            candidates, _ = await _search_and_rank_candidates(
                self.db,
                {
                    "name": "Alpha-Beta Gamma Delta GX",
                    "name_en": "Omega-Beta Zeta Theta GX",
                    "language": "de",
                    "number_local": "1",
                },
            )
        self.assertEqual(candidates, [])
        self.assertEqual(self.fallback.await_count, 12)

    async def test_live_fallback_stops_at_the_total_deadline(self):
        async def slow_empty_fallback(*args):
            await asyncio.sleep(0.05)
            return [], True

        self.fallback.side_effect = slow_empty_fallback
        with patch(
            "api.recognize.CATALOGUE_FALLBACK_TOTAL_TIMEOUT_SECONDS",
            0.005,
            create=True,
        ):
            with self.assertRaises(HTTPException):
                await self.candidate_ids(name="Alpha Beta", number_local="1")
        self.assertEqual(self.fallback.await_count, 1)


if __name__ == "__main__":
    unittest.main()
