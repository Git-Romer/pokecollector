import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Setting
    from services.card_fallbacks import apply_cross_language_fallbacks, build_missing_language_card
    FALLBACK_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    FALLBACK_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(FALLBACK_TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class TcgdexFallbackTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.db.add_all([
            Setting(key="cross_language_price_fallback", value="true"),
            Setting(key="cross_language_image_fallback", value="true"),
            Card(
                id="sv1-1_en",
                tcg_card_id="sv1-1",
                name="Sprigatito",
                set_id="sv1",
                number="1",
                lang="en",
                images_small="https://img/small.webp",
                images_large="https://img/large.webp",
                price_trend=1.23,
            ),
            Card(
                id="sv1-2_de",
                tcg_card_id="sv1-2",
                name="Felori",
                set_id="sv1",
                number="2",
                lang="de",
                images_small="https://de/small.webp",
                images_large="https://de/large.webp",
                price_trend=2.34,
            ),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_non_english_card_uses_english_fallback_by_same_tcg_id(self):
        parsed = {
            "id": "sv1-1_fr",
            "tcg_card_id": "sv1-1",
            "lang": "fr",
            "name": "Poussacha",
            "set_id": "sv1",
            "number": "1",
            "images_small": None,
            "images_large": None,
            "price_trend": None,
        }

        result = apply_cross_language_fallbacks(self.db, parsed)

        self.assertEqual(result["price_trend"], 1.23)
        self.assertEqual(result["images_small"], "https://img/small.webp")
        self.assertEqual(result["price_source_lang"], "en")
        self.assertEqual(result["image_source_lang"], "en")

    def test_english_card_does_not_fallback_to_german(self):
        parsed = {
            "id": "sv1-2_en",
            "tcg_card_id": "sv1-2",
            "lang": "en",
            "name": "Sprigatito",
            "set_id": "sv1",
            "number": "2",
            "images_small": None,
            "images_large": None,
            "price_trend": None,
        }

        result = apply_cross_language_fallbacks(self.db, parsed)

        self.assertIsNone(result["price_trend"])
        self.assertIsNone(result["images_small"])
        self.assertIsNone(result["price_source_lang"])
        self.assertIsNone(result["image_source_lang"])

    def test_missing_language_card_fetches_english_exact_id(self):
        english_card = {
            "id": "sv2-3",
            "name": "Pikachu",
            "localId": "3",
            "image": "https://img/pika",
            "set": {"id": "sv2"},
            "pricing": {"cardmarket": {"trend": 4.56}},
        }
        with patch("services.card_fallbacks.pokemon_api.get_card", return_value=english_card) as get_card:
            parsed = build_missing_language_card(self.db, "sv2-3", "ja", default_set_id="sv2")

        get_card.assert_called_once_with("sv2-3", lang="en")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["id"], "sv2-3_ja")
        self.assertEqual(parsed["lang"], "ja")
        self.assertEqual(parsed["data_source_lang"], "en")


if __name__ == "__main__":
    unittest.main()
