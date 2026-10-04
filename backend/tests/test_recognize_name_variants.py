"""Printed names match catalogue names written with a trailing qualifier or
different separators and punctuation, in local retrieval and in the live
TCGdex fallback. Identity symbols still distinguish names.
"""

import unittest
from unittest.mock import AsyncMock, Mock, patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
    from api.recognize import (
        _name_search_terms,
        _scanner_names_compatible,
        _search_and_rank_candidates,
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

    def test_hyphen_and_space_are_the_same_separator(self):
        self.assertTrue(_scanner_names_compatible("Charizard & Braixen-GX", "Charizard & Braixen GX"))
        self.assertTrue(_scanner_names_compatible("Charizard&Braixen GX", "Charizard & Braixen GX"))
        self.assertTrue(_scanner_names_compatible("Hop\u2019s Zacian ex", "Hop's Zacian ex"))
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

    async def test_space_read_reaches_hyphenated_catalogue_name(self):
        self.db.add(self.card("neo2-7_en", "Ho-Oh", "7"))
        self.db.commit()
        self.assertEqual(await self.candidate_ids(name="Ho Oh", number_local="7"), ["neo2-7_en"])

    async def test_live_fallback_tries_name_variants(self):
        self.fallback.side_effect = lambda lang, term, expected, trace: (
            ([{"id": "neo2-7_en", "tcg_card_id": "neo2-7", "name": "Ho-Oh", "number": "7"}], True)
            if term == "Ho-Oh" else ([], True))
        self.assertEqual(await self.candidate_ids(name="Ho Oh", number_local="7"), ["neo2-7_en"])


if __name__ == "__main__":
    unittest.main()
