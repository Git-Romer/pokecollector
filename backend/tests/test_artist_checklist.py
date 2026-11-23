import unittest
from unittest.mock import patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import get_current_user
    from api.cards import router as cards_router
    from database import Base, get_db
    from models import Card, CollectionItem, Set, Setting, User, WishlistItem

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE,
    "FastAPI/SQLAlchemy are not installed in this lightweight test environment",
)
class ArtistChecklistTests(unittest.TestCase):
    """Artist completion checklist contract.

    Catalogue under test (artist queries match ``arita`` unless noted):

    - sv8-123: en/de/ja printings; only the en row is owned (Holo x2).
    - sv8-45: ja only; on the wishlist.
    - sv6-7, sv6-9, sv6-11: one en printing each (set released 2024-06-07).
      sv6-7 is owned by another user only, so it must stay missing for us.
    - sv7-5: set with no release date, so it sorts last.
    - sv8-99_fr: hidden (fr is not a configured language and no fr pair is pinned).
    - custom-1_en: user custom card, always excluded.
    - sv6-20_en: artist "Éclair Baron" for accent-insensitive matching.
    - sv10-1: en/de printings priced only in de (price fallback).
    """

    def setUp(self):
        engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.engine = engine
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(
            username="ash", hashed_password="x", role="trainer", is_active=True
        )
        self.other_user = User(
            username="misty", hashed_password="x", role="trainer", is_active=True
        )
        self.db.add_all([
            self.user,
            self.other_user,
            Setting(key="tcgdex_sync_languages", value="en,de,ja"),
            Set(
                id="sv8_en",
                tcg_set_id="sv8",
                name="Surging Sparks",
                abbreviation="SSP",
                lang="en",
                release_date="2024-11-08",
            ),
            Set(
                id="sv8_de",
                tcg_set_id="sv8",
                name="Glühende Funken",
                abbreviation="SSP",
                lang="de",
                release_date="2024-11-08",
            ),
            Set(
                id="sv8_ja",
                tcg_set_id="sv8",
                name="Surging Sparks",
                abbreviation="SSP",
                lang="ja",
                release_date="2024-11-08",
            ),
            Set(
                id="sv6_en",
                tcg_set_id="sv6",
                name="Twilight Masquerade",
                abbreviation="TWM",
                lang="en",
                release_date="2024-06-07",
            ),
            Set(
                id="sv7_en",
                tcg_set_id="sv7",
                name="Stellar Crown",
                abbreviation="SCR",
                lang="en",
            ),
            Card(
                id="sv8-123_en",
                tcg_card_id="sv8-123",
                name="Pikachu ex",
                set_id="sv8",
                number="123",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
                price_market=10.0,
            ),
            Card(
                id="sv8-123_de",
                tcg_card_id="sv8-123",
                name="Pikachu ex",
                set_id="sv8",
                number="123",
                artist="Mitsuhiro Arita",
                lang="de",
                is_custom=False,
                price_market=12.0,
            ),
            Card(
                id="sv8-123_ja",
                tcg_card_id="sv8-123",
                name="ピカチュウex",
                set_id="sv8",
                number="123",
                artist="Mitsuhiro Arita",
                lang="ja",
                is_custom=False,
                price_market=5.0,
            ),
            Card(
                id="sv8-45_ja",
                tcg_card_id="sv8-45",
                name="ピカチュウ",
                set_id="sv8",
                number="45",
                artist="Mitsuhiro Arita",
                lang="ja",
                is_custom=False,
                price_market=2.0,
            ),
            Card(
                id="sv6-7_en",
                tcg_card_id="sv6-7",
                name="Charizard",
                set_id="sv6",
                number="7",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
                price_market=3.5,
            ),
            Card(
                id="sv6-9_en",
                tcg_card_id="sv6-9",
                name="Blastoise",
                set_id="sv6",
                number="9",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
                price_market=4.25,
            ),
            Card(
                id="sv6-11_en",
                tcg_card_id="sv6-11",
                name="Venusaur",
                set_id="sv6",
                number="11",
                artist="Arita's Studio",
                lang="en",
                is_custom=False,
                price_market=1.0,
            ),
            Card(
                id="sv7-5_en",
                tcg_card_id="sv7-5",
                name="Mew",
                set_id="sv7",
                number="5",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
                price_market=6.0,
            ),
            Card(
                id="sv8-99_fr",
                tcg_card_id="sv8-99",
                name="Pikachu",
                set_id="sv8",
                number="99",
                artist="Mitsuhiro Arita",
                lang="fr",
                is_custom=False,
                price_market=50.0,
            ),
            Card(
                id="custom-1_en",
                tcg_card_id=None,
                name="My Custom Card",
                set_id="custom",
                number="1",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=True,
                custom_owner_id=None,
                price_market=99.0,
            ),
            Card(
                id="sv6-20_en",
                tcg_card_id="sv6-20",
                name="Éclair",
                set_id="sv6",
                number="20",
                artist="Éclair Baron",
                lang="en",
                is_custom=False,
                price_market=0.75,
            ),
            Card(
                id="sv10-1_en",
                tcg_card_id="sv10-1",
                name="Price Fallback",
                set_id="sv6",
                number="1",
                artist="Fallback Artist",
                lang="en",
                is_custom=False,
                price_market=None,
            ),
            Card(
                id="sv10-1_de",
                tcg_card_id="sv10-1",
                name="Price Fallback",
                set_id="sv6",
                number="1",
                artist="Fallback Artist",
                lang="de",
                is_custom=False,
                price_market=7.5,
            ),
        ])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

        self.owned_en_row = CollectionItem(
            card_id="sv8-123_en",
            user_id=self.user.id,
            quantity=2,
            variant="Holo",
        )
        self.db.add_all([
            self.owned_en_row,
            # Another user's copy must not count towards our checklist.
            CollectionItem(
                card_id="sv6-7_en",
                user_id=self.other_user.id,
                quantity=1,
                variant="Normal",
            ),
            WishlistItem(card_id="sv8-45_ja", user_id=self.user.id, quantity=1),
        ])
        self.db.commit()

        app = FastAPI()
        app.include_router(cards_router, prefix="/api/cards")
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _checklist(self, **params):
        response = self.client.get("/api/cards/artist-checklist", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def _group(self, payload, tcg_card_id):
        for card in payload["cards"]:
            if card["tcg_card_id"] == tcg_card_id:
                return card
        self.fail(f"{tcg_card_id} not in checklist: {[c['tcg_card_id'] for c in payload['cards']]}")

    def test_all_languages_group_printings_and_aggregate_ownership(self):
        payload = self._checklist(artist="arita", lang="all")

        group = self._group(payload, "sv8-123")
        self.assertEqual(group["id"], "sv8-123_en")
        self.assertTrue(group["owned"])
        self.assertEqual(group["owned_quantity"], 2)
        self.assertEqual(group["owned_variants"], [{"variant": "Holo", "quantity": 2}])
        self.assertEqual(group["set_name"], "Surging Sparks")
        self.assertEqual(
            [printing["lang"] for printing in group["printings"]],
            ["en", "de", "ja"],
        )
        self.assertEqual(
            [printing["id"] for printing in group["printings"]],
            ["sv8-123_en", "sv8-123_de", "sv8-123_ja"],
        )
        printings = {printing["lang"]: printing for printing in group["printings"]}
        self.assertTrue(printings["en"]["owned"])
        self.assertEqual(printings["en"]["owned_quantity"], 2)
        self.assertFalse(printings["ja"]["owned"])
        self.assertEqual(printings["ja"]["owned_quantity"], 0)
        self.assertEqual(printings["ja"]["owned_variants"], [])
        self.assertEqual(group["printings"][0]["price_market"], 10.0)

    def test_specific_language_only_counts_that_language(self):
        payload = self._checklist(artist="arita", lang="ja")

        self.assertEqual(payload["total_count"], 2)
        self.assertEqual(payload["owned_count"], 0)
        self.assertEqual(payload["progress"], 0)
        self.assertEqual(payload["languages"], ["ja"])

        group = self._group(payload, "sv8-123")
        self.assertFalse(group["owned"])
        self.assertEqual(group["owned_quantity"], 0)
        self.assertEqual(group["id"], "sv8-123_ja")
        self.assertEqual([printing["lang"] for printing in group["printings"]], ["ja"])
        self.assertFalse(group["printings"][0]["owned"])

    def test_summary_counts_and_missing_value_cover_whole_filtered_set(self):
        payload = self._checklist(artist="arita", lang="all", page=1, page_size=1)

        self.assertEqual(payload["total_count"], 6)
        self.assertEqual(payload["owned_count"], 1)
        self.assertEqual(payload["list_count"], 6)
        self.assertEqual(payload["progress"], 16.7)
        # unowned representative prices: 2.0 + 3.5 + 4.25 + 1.0 + 6.0
        self.assertEqual(payload["missing_value"], 16.75)
        self.assertEqual(payload["languages"], ["de", "en", "ja"])
        self.assertEqual(payload["artists"], ["Arita's Studio", "Mitsuhiro Arita"])
        self.assertEqual(len(payload["cards"]), 1)

        full = self._checklist(artist="arita", lang="all", page_size=200)
        self.assertEqual(
            [printing["id"] for printing in self._group(full, "sv8-45")["printings"]],
            ["sv8-45_ja"],
        )
        self.assertTrue(self._group(full, "sv8-45")["wishlisted"])

    def test_ownership_filter_applies_to_groups_before_paging(self):
        # Header statistics stay over the whole artist scope; list_count is the
        # ownership-filtered list the UI paginates over.
        owned = self._checklist(artist="arita", lang="all", ownership="owned")
        self.assertEqual(owned["total_count"], 6)
        self.assertEqual(owned["owned_count"], 1)
        self.assertEqual(owned["list_count"], 1)
        self.assertEqual(owned["progress"], 16.7)
        self.assertEqual(owned["missing_value"], 16.75)
        self.assertEqual(owned["languages"], ["de", "en", "ja"])
        self.assertEqual(owned["artists"], ["Arita's Studio", "Mitsuhiro Arita"])
        self.assertEqual([card["tcg_card_id"] for card in owned["cards"]], ["sv8-123"])

        missing = self._checklist(artist="arita", lang="all", ownership="missing")
        self.assertEqual(missing["total_count"], 6)
        self.assertEqual(missing["owned_count"], 1)
        self.assertEqual(missing["list_count"], 5)
        self.assertEqual(missing["progress"], 16.7)
        self.assertEqual(missing["missing_value"], 16.75)
        self.assertNotIn("sv8-123", [card["tcg_card_id"] for card in missing["cards"]])
        # Another user's copy does not make sv6-7 owned for us.
        self.assertIn("sv6-7", [card["tcg_card_id"] for card in missing["cards"]])

        response = self.client.get(
            "/api/cards/artist-checklist",
            params={"artist": "arita", "ownership": "bogus"},
        )
        self.assertEqual(response.status_code, 400)

    def test_pagination_is_stable_and_page_size_is_clamped(self):
        first = self._checklist(artist="arita", lang="all", page=1, page_size=2)
        second = self._checklist(artist="arita", lang="all", page=2, page_size=2)
        third = self._checklist(artist="arita", lang="all", page=3, page_size=2)
        fourth = self._checklist(artist="arita", lang="all", page=4, page_size=2)

        self.assertEqual(
            [card["tcg_card_id"] for card in first["cards"]], ["sv6-7", "sv6-9"]
        )
        self.assertEqual(
            [card["tcg_card_id"] for card in second["cards"]], ["sv6-11", "sv8-45"]
        )
        # sv7-5 has no set release date, so it sorts last.
        self.assertEqual(
            [card["tcg_card_id"] for card in third["cards"]], ["sv8-123", "sv7-5"]
        )
        self.assertEqual(fourth["cards"], [])

        seen = []
        for page in (1, 2, 3):
            payload = self._checklist(artist="arita", lang="all", page=page, page_size=2)
            seen.extend(card["tcg_card_id"] for card in payload["cards"])
        self.assertEqual(len(seen), 6)
        self.assertEqual(len(set(seen)), 6)

        clamped_large = self._checklist(artist="arita", lang="all", page_size=1000)
        self.assertEqual(clamped_large["page_size"], 200)
        clamped_zero = self._checklist(artist="arita", lang="all", page_size=0)
        self.assertEqual(clamped_zero["page_size"], 1)
        clamped_page = self._checklist(artist="arita", lang="all", page=0)
        self.assertEqual(clamped_page["page"], 1)
        for payload in (first, second, third):
            self.assertEqual(payload["total_count"], 6)
            self.assertEqual(payload["owned_count"], 1)
            self.assertEqual(payload["list_count"], 6)

    def test_sorting_modes(self):
        by_name = self._checklist(artist="arita", lang="en", sort_by="name")
        self.assertEqual(
            [card["name"] for card in by_name["cards"]],
            ["Blastoise", "Charizard", "Mew", "Pikachu ex", "Venusaur"],
        )

        by_price = self._checklist(artist="arita", lang="all", sort_by="price")
        self.assertEqual(
            [card["tcg_card_id"] for card in by_price["cards"]],
            ["sv6-11", "sv8-45", "sv6-7", "sv6-9", "sv7-5", "sv8-123"],
        )

        by_price_desc = self._checklist(
            artist="arita", lang="all", sort_by="price", sort_order="desc"
        )
        self.assertEqual(
            [card["tcg_card_id"] for card in by_price_desc["cards"]],
            ["sv8-123", "sv7-5", "sv6-9", "sv6-7", "sv8-45", "sv6-11"],
        )

        by_number_desc = self._checklist(
            artist="arita", lang="all", sort_by="number", sort_order="desc"
        )
        self.assertEqual(by_number_desc["cards"][-1]["tcg_card_id"], "sv7-5")
        self.assertEqual(
            [card["tcg_card_id"] for card in by_number_desc["cards"]],
            ["sv8-123", "sv8-45", "sv6-11", "sv6-9", "sv6-7", "sv7-5"],
        )

        response = self.client.get(
            "/api/cards/artist-checklist",
            params={"artist": "arita", "sort_by": "rarity"},
        )
        self.assertEqual(response.status_code, 400)

    def test_artist_match_is_case_and_accent_insensitive(self):
        lower = self._checklist(artist="arita", lang="all")
        upper = self._checklist(artist="ARITA", lang="all")
        self.assertEqual(
            [card["id"] for card in lower["cards"]],
            [card["id"] for card in upper["cards"]],
        )
        self.assertEqual(upper["artist_query"], "ARITA")

        accented = self._checklist(artist="ECLAIR", lang="all")
        self.assertEqual(accented["total_count"], 1)
        self.assertEqual(accented["artists"], ["Éclair Baron"])
        self.assertEqual(accented["cards"][0]["artist"], "Éclair Baron")

    def test_unknown_artist_returns_empty_shape(self):
        payload = self._checklist(artist="nobody", lang="all")
        self.assertEqual(
            payload,
            {
                "artist_query": "nobody",
                "artists": [],
                "total_count": 0,
                "owned_count": 0,
                "list_count": 0,
                "progress": 0,
                "missing_value": 0,
                "page": 1,
                "page_size": 60,
                "languages": [],
                "cards": [],
            },
        )

    def test_custom_and_hidden_cards_are_excluded(self):
        payload = self._checklist(artist="arita", lang="all", page_size=200)
        visible_ids = {
            printing_id
            for card in payload["cards"]
            for printing_id in [card["id"]]
            + [printing["id"] for printing in card["printings"]]
        }
        self.assertNotIn("custom-1_en", visible_ids)
        self.assertNotIn("sv8-99_fr", visible_ids)
        self.assertEqual(payload["total_count"], 6)

    def test_missing_value_falls_back_to_a_priced_printing(self):
        payload = self._checklist(artist="Fallback Artist", lang="all")

        self.assertEqual(payload["total_count"], 1)
        self.assertEqual(payload["owned_count"], 0)
        # The display-language (en) printing has no price, but de does.
        self.assertEqual(payload["missing_value"], 7.5)


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE,
    "FastAPI/SQLAlchemy are not installed in this lightweight test environment",
)
class CardSearchOwnershipFilterTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.engine = engine
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(
            username="ash", hashed_password="x", role="trainer", is_active=True
        )
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en"),
            Set(
                id="sv8_en",
                tcg_set_id="sv8",
                name="Surging Sparks",
                abbreviation="SSP",
                lang="en",
                release_date="2024-11-08",
            ),
            Card(
                id="sv8-1_en",
                tcg_card_id="sv8-1",
                name="Owned Card",
                set_id="sv8",
                number="1",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
            ),
            Card(
                id="sv8-2_en",
                tcg_card_id="sv8-2",
                name="Missing Card",
                set_id="sv8",
                number="2",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
            ),
            Card(
                id="sv8-3_en",
                tcg_card_id="sv8-3",
                name="Another Missing Card",
                set_id="sv8",
                number="3",
                artist="Mitsuhiro Arita",
                lang="en",
                is_custom=False,
            ),
        ])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.add(CollectionItem(
            card_id="sv8-1_en", user_id=self.user.id, quantity=1, variant="Normal"
        ))
        self.db.commit()

        app = FastAPI()
        app.include_router(cards_router, prefix="/api/cards")
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _search(self, **params):
        with patch("api.cards.enrich_card_metadata_ids_in_background"):
            response = self.client.get("/api/cards/search", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_ownership_filter_and_owned_count(self):
        everything = self._search(artist="arita", lang="all")
        self.assertEqual(everything["total_count"], 3)
        self.assertEqual(everything["owned_count"], 1)

        missing = self._search(artist="arita", lang="all", ownership="missing")
        self.assertEqual(missing["total_count"], 2)
        self.assertEqual(missing["owned_count"], 0)
        self.assertEqual(
            sorted(card["id"] for card in missing["data"]),
            ["sv8-2_en", "sv8-3_en"],
        )

        owned = self._search(artist="arita", lang="all", ownership="owned")
        self.assertEqual(owned["total_count"], 1)
        self.assertEqual(owned["owned_count"], 1)
        self.assertEqual([card["id"] for card in owned["data"]], ["sv8-1_en"])

        response = self.client.get(
            "/api/cards/search", params={"artist": "arita", "ownership": "bogus"}
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
