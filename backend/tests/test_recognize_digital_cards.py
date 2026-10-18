"""Digital-only (TCG Pocket) printings are never scanner candidates: not from
the local catalogue, and not from the live TCGdex fallback - also for Pocket
sets that are not synced locally.
"""

import unittest
from unittest.mock import AsyncMock, Mock, patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
    from api.recognize import _search_and_rank_candidates
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
class DigitalCardTests(LocalCatalogueTestCase):
    def seed(self):
        self.db.add_all([
            Set(id="B1a_en", tcg_set_id="B1a", name="Pocket", lang="en", is_digital=True),
            self.card("B1a-026_en", "Magnezone", "026", is_digital=True),
            self.card("sma-SV29_en", "Magnezone", "SV29"),
        ])
        self.db.commit()

    async def test_local_digital_rows_are_excluded(self):
        self.seed()
        ids = await self.candidate_ids(name="Magnezone", number_local="SV29")
        self.assertEqual(ids, ["sma-SV29_en"])

    async def test_card_in_digital_set_is_excluded_even_if_card_flag_is_false(self):
        self.db.add_all([
            Set(id="B1a_en", tcg_set_id="B1a", name="Pocket", lang="en", is_digital=True),
            self.card("B1a-026_en", "Magnezone", "026", is_digital=False),
        ])
        self.db.commit()
        self.assertEqual(
            await self.candidate_ids(name="Magnezone", number_local="026"),
            [],
        )

    async def test_card_in_legacy_digital_set_is_excluded_even_if_card_flag_is_false(self):
        self.db.add_all([
            Set(id="B1a_en", tcg_set_id=None, name="Pocket", lang="en", is_digital=True),
            self.card("B1a-026_en", "Magnezone", "026", is_digital=False),
        ])
        self.db.commit()
        self.assertEqual(
            await self.candidate_ids(name="Magnezone", number_local="026"),
            [],
        )

    async def test_unsynced_pocket_artwork_from_the_live_fallback_is_excluded(self):
        self.db.add(self.card("sma-SV29_en", "Magnezone", "SV29"))
        self.db.commit()
        self.fallback.return_value = ([{
            "id": "B9-001_en", "tcg_card_id": "B9-001", "name": "Magnezone", "number": "001",
            "image": "https://assets.tcgdex.net/en/tcgp/B9/001/low.webp"}], True)
        self.assertNotIn("B9-001_en", await self.candidate_ids(name="Magnezone", number_local="1"))

    async def test_live_fallback_rows_from_digital_sets_are_excluded(self):
        self.seed()
        self.fallback.return_value = (
            [{"id": "B1a-026_en", "tcg_card_id": "B1a-026", "name": "Magnezone", "number": "026"}], True)
        ids = await self.candidate_ids(name="Magnezone", number_local="26")
        self.assertNotIn("B1a-026_en", ids)

    async def test_live_fallback_rows_from_legacy_digital_set_are_excluded(self):
        self.db.add_all([
            Set(id="B1a_en", tcg_set_id=None, name="Pocket", lang="en", is_digital=True),
            self.card("sma-SV29_en", "Magnezone", "SV29"),
        ])
        self.db.commit()
        self.fallback.return_value = ([{
            "id": "B1a-026_en",
            "tcg_card_id": "B1a-026",
            "name": "Magnezone",
            "number": "026",
            "image": "https://assets.tcgdex.net/en/x/B1a/B1a-026/low.webp",
        }], True)
        ids = await self.candidate_ids(name="Magnezone", number_local="026")
        self.assertNotIn("B1a-026_en", ids)


if __name__ == "__main__":
    unittest.main()
