import unittest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import get_current_user
    from api.cards import router as cards_router
    from database import Base, get_db
    from models import Card, CollectionItem, Set, Setting, User

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE,
    "FastAPI/SQLAlchemy are not installed in this lightweight test environment",
)
class ArtistIndexTests(unittest.TestCase):
    """``GET /api/cards/artists`` contract.

    Catalogue under test (set languages en/de/ja are configured):

    - Mitsuhiro Arita: sv8-123 as en/de/ja printings (one identity, en owned),
      sv8-45 ja, sv6-7 en (owned by another user only) and sv7-5 en.
    - 5ban Graphics: sv9-1 en (owned), sv9-2 en, sv9-3 en with no price.
    - Éclair Baron: sv6-20 en, for accent-insensitive matching.
    - Alpha Artist: one unowned card priced only in de (its en printing has no
      price); the one-card/0-progress ties exercise stable ordering.
    - Zeta Artist: one unowned en card, so ties stay stable.
    - sv8-99_fr: hidden (fr is not configured and no fr set pair is pinned).
    - custom-1_en: user custom card, always excluded.
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
            Set(id="sv8_en", tcg_set_id="sv8", name="Surging Sparks", lang="en"),
            Set(id="sv8_de", tcg_set_id="sv8", name="Glühende Funken", lang="de"),
            Set(id="sv8_ja", tcg_set_id="sv8", name="Surging Sparks", lang="ja"),
            Set(id="sv6_en", tcg_set_id="sv6", name="Twilight Masquerade", lang="en"),
            Set(id="sv7_en", tcg_set_id="sv7", name="Stellar Crown", lang="en"),
            Set(id="sv9_en", tcg_set_id="sv9", name="Journey Together", lang="en"),
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
                id="sv9-1_en",
                tcg_card_id="sv9-1",
                name="Iono",
                set_id="sv9",
                number="1",
                artist="5ban Graphics",
                lang="en",
                is_custom=False,
                price_market=1.0,
            ),
            Card(
                id="sv9-2_en",
                tcg_card_id="sv9-2",
                name="Boss's Orders",
                set_id="sv9",
                number="2",
                artist="5ban Graphics",
                lang="en",
                is_custom=False,
                price_market=2.0,
            ),
            Card(
                id="sv9-3_en",
                tcg_card_id="sv9-3",
                name="Professor's Research",
                set_id="sv9",
                number="3",
                artist="5ban Graphics",
                lang="en",
                is_custom=False,
                price_market=None,
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
                id="sv9-10_en",
                tcg_card_id="sv9-10",
                name="Alpha Card",
                set_id="sv9",
                number="10",
                artist="Alpha Artist",
                lang="en",
                is_custom=False,
                price_market=None,
            ),
            Card(
                id="sv9-10_de",
                tcg_card_id="sv9-10",
                name="Alpha Card",
                set_id="sv9",
                number="10",
                artist="Alpha Artist",
                lang="de",
                is_custom=False,
                price_market=1.5,
            ),
            Card(
                id="sv9-11_en",
                tcg_card_id="sv9-11",
                name="Zeta Card",
                set_id="sv9",
                number="11",
                artist="Zeta Artist",
                lang="en",
                is_custom=False,
                price_market=1.0,
            ),
            Card(
                id="sv8-99_fr",
                tcg_card_id="sv8-99",
                name="Pikachu",
                set_id="sv8",
                number="99",
                artist="Fr Only Artist",
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
                artist="Custom Only Artist",
                lang="en",
                is_custom=True,
                custom_owner_id=None,
                price_market=99.0,
            ),
        ])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

        self.db.add_all([
            CollectionItem(
                card_id="sv8-123_en", user_id=self.user.id, quantity=2, variant="Holo"
            ),
            CollectionItem(
                card_id="sv9-1_en", user_id=self.user.id, quantity=1, variant="Normal"
            ),
            # Another user's copy must not count towards our ownership.
            CollectionItem(
                card_id="sv6-7_en",
                user_id=self.other_user.id,
                quantity=1,
                variant="Normal",
            ),
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

    def _index(self, **params):
        response = self.client.get("/api/cards/artists", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    @staticmethod
    def _by_name(payload):
        return {artist["name"]: artist for artist in payload["artists"]}

    def _names(self, **params):
        return [artist["name"] for artist in self._index(**params)["artists"]]

    def test_counts_group_printings_and_aggregate_ownership(self):
        payload = self._index(lang="all")

        self.assertEqual(payload["total_count"], 5)
        self.assertEqual(payload["languages"], ["de", "en", "ja"])
        artists = self._by_name(payload)

        arita = artists["Mitsuhiro Arita"]
        # sv8-123 (en/de/ja) is one identity; sv8-45, sv6-7, sv7-5 are three more.
        self.assertEqual(arita["total_count"], 4)
        self.assertEqual(arita["owned_count"], 1)
        self.assertEqual(arita["missing_count"], 3)
        self.assertEqual(arita["progress"], 25.0)
        # Unowned representatives: sv8-45 ja 2.0, sv6-7 en 3.5, sv7-5 en 6.0.
        self.assertEqual(arita["missing_value"], 11.5)
        self.assertEqual(arita["languages"], ["de", "en", "ja"])

        graphics = artists["5ban Graphics"]
        self.assertEqual(graphics["total_count"], 3)
        self.assertEqual(graphics["owned_count"], 1)
        self.assertEqual(graphics["missing_count"], 2)
        self.assertEqual(graphics["progress"], 33.3)
        # sv9-3 has no market price and must not poison the sum.
        self.assertEqual(graphics["missing_value"], 2.0)
        self.assertEqual(graphics["languages"], ["en"])

        self.assertEqual(
            artists["Éclair Baron"]["missing_value"], 0.75
        )

        # Alpha's en printing has no price; the de printing must be used.
        self.assertEqual(artists["Alpha Artist"]["missing_value"], 1.5)

    def test_ownership_is_scoped_to_user_and_language(self):
        # sv6-7 is owned only by the other user, so Arita stays at 1 owned.
        arita = self._by_name(self._index(lang="all"))["Mitsuhiro Arita"]
        self.assertEqual(arita["owned_count"], 1)

        # With lang=ja the owned en printing does not count for this identity.
        ja = self._index(lang="ja")
        self.assertEqual([artist["name"] for artist in ja["artists"]], ["Mitsuhiro Arita"])
        self.assertEqual(ja["total_count"], 1)
        self.assertEqual(ja["languages"], ["ja"])
        arita_ja = ja["artists"][0]
        self.assertEqual(arita_ja["total_count"], 2)
        self.assertEqual(arita_ja["owned_count"], 0)
        self.assertEqual(arita_ja["missing_count"], 2)
        self.assertEqual(arita_ja["progress"], 0.0)
        self.assertEqual(arita_ja["missing_value"], 7.0)

        de = self._index(lang="de")
        self.assertEqual(
            [artist["name"] for artist in de["artists"]],
            ["Alpha Artist", "Mitsuhiro Arita"],
        )
        arita_de = self._by_name(de)["Mitsuhiro Arita"]
        self.assertEqual(arita_de["total_count"], 1)
        self.assertEqual(arita_de["owned_count"], 0)
        self.assertEqual(arita_de["missing_value"], 12.0)

    def test_query_is_case_and_accent_insensitive(self):
        self.assertEqual(self._names(q="ARITA"), ["Mitsuhiro Arita"])
        payload = self._index(q="arita")
        # Hidden and custom Arita-artist rows are excluded from the same scope.
        self.assertEqual(payload["artists"][0]["total_count"], 4)

        self.assertEqual(self._names(q="ECLAIR"), ["Éclair Baron"])
        self.assertEqual(self._names(q="éclair"), ["Éclair Baron"])

        empty = self._index(q="nobody")
        self.assertEqual(
            empty,
            {
                "artists": [],
                "total_count": 0,
                "page": 1,
                "page_size": 50,
                "languages": [],
            },
        )

        # Empty q is the same as omitting it.
        self.assertEqual(self._names(q=""), self._names())

    def test_sorting_modes_and_stable_ties(self):
        self.assertEqual(
            self._names(lang="all", sort_by="name", sort_order="asc"),
            ["5ban Graphics", "Alpha Artist", "Mitsuhiro Arita", "Zeta Artist", "Éclair Baron"],
        )
        self.assertEqual(
            self._names(lang="all", sort_by="name", sort_order="desc"),
            ["Éclair Baron", "Zeta Artist", "Mitsuhiro Arita", "Alpha Artist", "5ban Graphics"],
        )

        # Equal primary values stay name-ascending in both directions.
        self.assertEqual(
            self._names(lang="all", sort_by="cards", sort_order="asc"),
            ["Alpha Artist", "Zeta Artist", "Éclair Baron", "5ban Graphics", "Mitsuhiro Arita"],
        )
        self.assertEqual(
            self._names(lang="all", sort_by="cards", sort_order="desc"),
            ["Mitsuhiro Arita", "5ban Graphics", "Alpha Artist", "Zeta Artist", "Éclair Baron"],
        )

        self.assertEqual(
            self._names(lang="all", sort_by="progress", sort_order="asc"),
            ["Alpha Artist", "Zeta Artist", "Éclair Baron", "Mitsuhiro Arita", "5ban Graphics"],
        )
        self.assertEqual(
            self._names(lang="all", sort_by="progress", sort_order="desc"),
            ["5ban Graphics", "Mitsuhiro Arita", "Alpha Artist", "Zeta Artist", "Éclair Baron"],
        )

        self.assertEqual(
            self._names(lang="all", sort_by="missing", sort_order="asc"),
            ["Alpha Artist", "Zeta Artist", "Éclair Baron", "5ban Graphics", "Mitsuhiro Arita"],
        )
        self.assertEqual(
            self._names(lang="all", sort_by="missing", sort_order="desc"),
            ["Mitsuhiro Arita", "5ban Graphics", "Alpha Artist", "Zeta Artist", "Éclair Baron"],
        )

        for params in ({"sort_by": "rarity"}, {"sort_order": "sideways"}):
            response = self.client.get("/api/cards/artists", params=params)
            self.assertEqual(response.status_code, 400, response.text)

    def test_pagination_pages_are_disjoint_and_clamped(self):
        first = self._index(lang="all", page=1, page_size=2)
        second = self._index(lang="all", page=2, page_size=2)
        third = self._index(lang="all", page=3, page_size=2)
        fourth = self._index(lang="all", page=4, page_size=2)

        self.assertEqual(
            [artist["name"] for artist in first["artists"]],
            ["5ban Graphics", "Alpha Artist"],
        )
        self.assertEqual(
            [artist["name"] for artist in second["artists"]],
            ["Mitsuhiro Arita", "Zeta Artist"],
        )
        self.assertEqual([artist["name"] for artist in third["artists"]], ["Éclair Baron"])
        self.assertEqual(fourth["artists"], [])

        for payload in (first, second):
            # total_count is the artist count, not the page length.
            self.assertEqual(payload["total_count"], 5)
            self.assertEqual(payload["page_size"], 2)

        seen = []
        for page in (1, 2, 3):
            payload = self._index(lang="all", page=page, page_size=2)
            seen.extend(artist["name"] for artist in payload["artists"])
        self.assertEqual(len(seen), 5)
        self.assertEqual(len(set(seen)), 5)

        self.assertEqual(self._index(page_size=1000)["page_size"], 200)
        self.assertEqual(self._index(page_size=0)["page_size"], 1)
        self.assertEqual(self._index(page=0)["page"], 1)

    def test_custom_and_hidden_cards_are_excluded(self):
        payload = self._index(lang="all")
        names = [artist["name"] for artist in payload["artists"]]
        self.assertNotIn("Custom Only Artist", names)
        self.assertNotIn("Fr Only Artist", names)
        self.assertNotIn("fr", payload["languages"])

        arita = self._by_name(payload)["Mitsuhiro Arita"]
        # The custom card and the hidden fr card are not part of Arita's count.
        self.assertEqual(arita["total_count"], 4)

        self.assertEqual(self._index(q="Custom Only Artist")["artists"], [])
        self.assertEqual(self._index(q="Fr Only Artist")["artists"], [])

    def test_top_level_language_union(self):
        self.assertEqual(self._index(lang="all")["languages"], ["de", "en", "ja"])
        self.assertEqual(self._index(lang="en")["languages"], ["en"])
        self.assertEqual(self._index(lang="de")["languages"], ["de"])
        self.assertEqual(self._index(lang="ja")["languages"], ["ja"])
        # An unsupported language falls back to the full catalogue, like search.
        self.assertEqual(self._index(lang="xx")["languages"], ["de", "en", "ja"])


if __name__ == "__main__":
    unittest.main()
