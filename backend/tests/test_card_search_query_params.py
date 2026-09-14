import os
import unittest
from unittest.mock import patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import get_current_user
    from api.cards import router as cards_router, search_cards
    from database import Base, get_db
    from models import Card, Set, Setting, User
    from services.card_numbers import card_number_filter, card_number_matches

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE,
    "FastAPI/SQLAlchemy are not installed in this lightweight test environment",
)
class CardSearchQueryParameterTests(unittest.TestCase):
    def setUp(self):
        database_url = os.environ.get(
            "CARD_SEARCH_TEST_DATABASE_URL", "sqlite:///:memory:"
        )
        engine_options = {}
        if database_url.startswith("sqlite"):
            engine_options = {
                "connect_args": {"check_same_thread": False},
                "poolclass": StaticPool,
            }
        self.engine = create_engine(database_url, **engine_options)
        Base.metadata.create_all(self.engine)
        Session = sessionmaker(bind=self.engine)
        self.db = Session()
        self.user = User(
            username="ash", hashed_password="x", role="trainer", is_active=True
        )
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en,ja"),
            Set(
                id="M2a_ja",
                tcg_set_id="M2a",
                name="Mega Dream ex",
                abbreviation="M2A",
                lang="ja",
            ),
            Card(
                id="M2a-228_ja",
                tcg_card_id="M2a-228",
                name="メガルカリオex",
                set_id="M2a",
                number="228",
                lang="ja",
                is_custom=False,
            ),
            Card(
                id="M2a-022_ja",
                tcg_card_id="M2a-022",
                name="ルカリオ",
                set_id="M2a",
                number="022",
                lang="ja",
                is_custom=False,
            ),
            Card(
                id="M2a-TG01_ja",
                tcg_card_id="M2a-TG01",
                name="Training Gallery",
                set_id="M2a",
                number="TG01",
                lang="ja",
                is_custom=False,
            ),
            Card(
                id="other-228_en",
                tcg_card_id="other-228",
                name="Different Card",
                set_id="other",
                number="228",
                lang="en",
                is_custom=False,
            ),
        ])
        self.db.commit()
        self.db.refresh(self.user)
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

    def _search_ids(self, **kwargs):
        result = search_cards(
            type_filter=None,
            db=self.db,
            current_user=self.user,
            **kwargs,
        )
        return [card["id"] for card in result["data"]]

    def test_q_routes_to_existing_name_search(self):
        self.assertEqual(self._search_ids(q="メガルカリオ", lang="ja"), ["M2a-228_ja"])

    def test_q_routes_to_existing_set_code_and_number_search(self):
        self.assertEqual(self._search_ids(q="m2a 228", lang="ja"), ["M2a-228_ja"])

    def test_http_query_binding_decodes_q_and_keeps_legacy_name_compatible(self):
        with patch("api.cards.enrich_card_metadata_ids_in_background"):
            response = self.client.get("/api/cards/search?q=m2a+228&lang=ja")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                [card["id"] for card in response.json()["data"]], ["M2a-228_ja"]
            )

            response = self.client.get(
                "/api/cards/search?number=228&set_id=M2a&lang=ja"
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                [card["id"] for card in response.json()["data"]], ["M2a-228_ja"]
            )

            response = self.client.get(
                "/api/cards/search",
                params={"q": "   ", "name": "Different Card", "lang": "all"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                [card["id"] for card in response.json()["data"]], ["other-228_en"]
            )

    def test_number_combines_with_set_and_language_filters(self):
        self.assertEqual(
            self._search_ids(number="228", set_id="M2a", lang="ja"),
            ["M2a-228_ja"],
        )

    def test_number_uses_shared_numeric_and_alphanumeric_normalization(self):
        self.assertEqual(self._search_ids(number="22", lang="ja"), ["M2a-022_ja"])
        self.assertEqual(self._search_ids(number="tg01", lang="ja"), ["M2a-TG01_ja"])

    def test_sql_number_filter_matches_python_number_contract(self):
        cards = self.db.query(Card).order_by(Card.id).all()
        requested_numbers = (
            "228",
            "0228",
            "22",
            "00022",
            "TG01",
            "tg01",
            "0",
            "missing",
        )
        for requested in requested_numbers:
            with self.subTest(requested=requested):
                sql_ids = [
                    card.id
                    for card in self.db.query(Card)
                    .filter(card_number_filter(Card.number, requested))
                    .order_by(Card.id)
                    .all()
                ]
                python_ids = [
                    card.id for card in cards if card_number_matches(card.number, requested)
                ]
                self.assertEqual(sql_ids, python_ids)

    def test_q_takes_precedence_and_blank_q_falls_back_to_legacy_name(self):
        self.assertEqual(
            self._search_ids(q="メガルカリオ", name="Different Card", lang="all"),
            ["M2a-228_ja"],
        )
        self.assertEqual(
            self._search_ids(q="   ", name="Different Card", lang="all"),
            ["other-228_en"],
        )


if __name__ == "__main__":
    unittest.main()
