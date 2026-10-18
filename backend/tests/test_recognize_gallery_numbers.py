"""Gallery and subset numbers (TG, GG, SV, RC) in scanner matching.

A prefixed printed total ("TG30") agrees with the numeric set size (30). A
gallery printing of a prefix-less read ("06" for TG06) is always offered,
and a plain number match next to it is not treated as unique evidence.
"""

import unittest
from unittest.mock import AsyncMock, Mock, patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
    from api.recognize import (
        _gallery_number_match,
        _metadata_decision,
        _printed_total_signal,
        _search_and_rank_candidates,
        match_card_info,
        RECOGNIZE_PROMPT,
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
class PrintedTotalTests(unittest.TestCase):
    def test_prefixed_total_agrees_with_numeric_set_size(self):
        self.assertEqual(_printed_total_signal("TG30", 30), 0)
        self.assertEqual(_printed_total_signal("GG70", 70), 0)
        self.assertEqual(_printed_total_signal("SV94", 94), 0)
        self.assertEqual(_printed_total_signal("RC32", 32), 0)
        self.assertEqual(_printed_total_signal("30", 30), 0)
        self.assertEqual(_printed_total_signal("TG30", 31), 2)
        self.assertEqual(_printed_total_signal(None, 30), 1)

    def test_unrecognized_prefix_is_unknown_for_total_comparison(self):
        self.assertEqual(_printed_total_signal("XY30", 30), 1)
        self.assertEqual(_printed_total_signal("XY30", 94), 1)

    def test_unrecognized_prefix_does_not_break_a_same_number_tie(self):
        candidates = [
            {"number": "6", "printed_total": "30", "_lang": "en"},
            {"number": "6", "printed_total": "94", "_lang": "en"},
        ]
        confident, reason = _metadata_decision(
            {"number_local": "6", "number_total": "XY30", "language": "en"},
            candidates,
        )
        self.assertFalse(confident)
        self.assertIsNone(reason)

    def test_gallery_match_only_for_prefix_less_digits(self):
        self.assertTrue(_gallery_number_match("TG06", "6"))
        self.assertTrue(_gallery_number_match("SV28", "28"))
        self.assertFalse(_gallery_number_match("6", "6"))
        self.assertFalse(_gallery_number_match("TG06", "tg6"))
        self.assertFalse(_gallery_number_match("TG07", "6"))
        self.assertFalse(_gallery_number_match("TG06", None))

    def test_prompt_asks_for_the_prefix(self):
        self.assertIn("TG06/TG30", RECOGNIZE_PROMPT)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "backend dependencies are not installed")
class GalleryRetrievalTests(LocalCatalogueTestCase):
    async def test_lost_prefix_still_finds_the_gallery_printing(self):
        rows = [self.card(f"a{i:02}-{40 + i}_en", "Gengar", str(40 + i)) for i in range(10)]
        rows.append(self.card("swsh11tg-TG06_en", "Gengar", "TG06"))
        self.db.add_all(rows)
        self.db.commit()
        candidates, _ = await _search_and_rank_candidates(
            self.db, {"name": "Gengar", "number_local": "06", "number_total": "30", "language": "en"})
        gallery = next(c for c in candidates if c["id"] == "swsh11tg-TG06_en")
        self.assertTrue(gallery["_gallery_alternative"])

    async def test_gallery_alternative_survives_a_plain_number_match(self):
        self.db.add_all([self.card("base3-6_en", "Gengar", "6"), self.card("swsh11tg-TG06_en", "Gengar", "TG06")])
        self.db.commit()
        ids = await self.candidate_ids(name="Gengar", number_local="6")
        self.assertEqual(ids[0], "base3-6_en")
        self.assertIn("swsh11tg-TG06_en", ids)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "backend dependencies are not installed")
class GalleryDecisionTests(LocalCatalogueTestCase):
    async def test_plain_number_does_not_decide_next_to_a_gallery_printing(self):
        # Both printings fit in the first-eight window; the gallery one must
        # still stop a number-only decision, end to end.
        self.db.add_all([self.card("base3-6_en", "Gengar", "6"), self.card("swsh11tg-TG06_en", "Gengar", "TG06")])
        self.db.commit()
        read = {"name": "Gengar", "number_local": "6", "language": "en"}
        candidates, count = await _search_and_rank_candidates(self.db, dict(read))
        with patch("api.recognize._search_and_rank_candidates", new=AsyncMock(return_value=(candidates, count))):
            result = await match_card_info(self.db, dict(read))
        self.assertFalse(result["_identity_confident"])
        self.assertEqual({m["id"] for m in result["matches"]}, {"base3-6_en", "swsh11tg-TG06_en"})
        self.assertTrue(all("_gallery_alternative" not in m for m in result["matches"]))

    async def test_prefixed_read_still_decides(self):
        self.db.add_all([self.card("base3-6_en", "Gengar", "6"), self.card("swsh11tg-TG06_en", "Gengar", "TG06")])
        self.db.commit()
        read = {"name": "Gengar", "number_local": "TG06", "number_total": "TG30", "language": "en"}
        candidates, count = await _search_and_rank_candidates(self.db, dict(read))
        with patch("api.recognize._search_and_rank_candidates", new=AsyncMock(return_value=(candidates, count))):
            result = await match_card_info(self.db, dict(read))
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], "swsh11tg-TG06_en")


if __name__ == "__main__":
    unittest.main()
