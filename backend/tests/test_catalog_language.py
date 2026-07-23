import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.cards import get_card, search_cards
    from api.sets import get_sets
    from database import Base
    from models import Card, CollectionItem, Set, Setting, User, UserSetting, WishlistItem
    from services.display_language import get_tcgdex_display_language

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class CatalogLanguageTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="language", value="de"),
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Setting(key="tcgdex_digital_sets_enabled", value="true"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_catalogue_default_ignores_legacy_global_language_row(self):
        self.db.query(UserSetting).delete()
        self.db.commit()

        self.assertEqual(get_tcgdex_display_language(self.db, self.user.id), "en")

    def test_sets_refresh_uses_user_language_instead_of_global_language(self):
        self.db.add(UserSetting(user_id=self.user.id, key="language", value="en"))
        self.db.commit()

        with patch("api.sets.pokemon_api.get_all_sets", return_value=[]) as get_all_sets:
            get_sets(db=self.db, current_user=self.user, refresh=True, lang=None)

        self.assertGreaterEqual(get_all_sets.call_count, 1)
        for call in get_all_sets.call_args_list:
            self.assertEqual(call.kwargs["languages"], ["en"])

    def test_sets_without_lang_returns_user_language_only(self):
        self.db.add_all([
            UserSetting(user_id=self.user.id, key="language", value="en"),
            Set(id="base1_en", tcg_set_id="base1", name="Base Set", lang="en"),
            Set(id="base1_de", tcg_set_id="base1", name="Grundset", lang="de"),
        ])
        self.db.commit()

        sets = get_sets(db=self.db, current_user=self.user, refresh=False, lang=None)

        self.assertEqual([set_obj.id for set_obj in sets], ["base1_en"])

    def test_sets_explicit_all_returns_all_visible_languages(self):
        self.db.add_all([
            UserSetting(user_id=self.user.id, key="language", value="en"),
            Set(id="base1_en", tcg_set_id="base1", name="Base Set", lang="en"),
            Set(id="base1_de", tcg_set_id="base1", name="Grundset", lang="de"),
        ])
        self.db.commit()

        sets = get_sets(db=self.db, current_user=self.user, refresh=False, lang="all")

        self.assertEqual({set_obj.id for set_obj in sets}, {"base1_en", "base1_de"})

    def test_card_search_without_lang_uses_user_language(self):
        self.db.add_all([
            UserSetting(user_id=self.user.id, key="language", value="en"),
            Set(id="base1_en", tcg_set_id="base1", name="Base Set", lang="en"),
            Set(id="base1_de", tcg_set_id="base1", name="Grundset", lang="de"),
            Card(id="base1-1_en", tcg_card_id="base1-1", name="Alakazam", set_id="base1", number="1", lang="en", is_custom=False),
            Card(id="base1-1_de", tcg_card_id="base1-1", name="Simsala", set_id="base1", number="1", lang="de", is_custom=False),
        ])
        self.db.commit()

        result = search_cards(type_filter=None, lang=None, db=self.db, current_user=self.user)

        self.assertEqual([card["id"] for card in result["data"]], ["base1-1_en"])

    def test_card_search_explicit_all_still_returns_all_visible_languages(self):
        self.db.add_all([
            UserSetting(user_id=self.user.id, key="language", value="en"),
            Set(id="base1_en", tcg_set_id="base1", name="Base Set", lang="en"),
            Set(id="base1_de", tcg_set_id="base1", name="Grundset", lang="de"),
            Card(id="base1-1_en", tcg_card_id="base1-1", name="Alakazam", set_id="base1", number="1", lang="en", is_custom=False),
            Card(id="base1-1_de", tcg_card_id="base1-1", name="Simsala", set_id="base1", number="1", lang="de", is_custom=False),
        ])
        self.db.commit()

        result = search_cards(type_filter=None, lang="all", db=self.db, current_user=self.user)

        self.assertEqual(
            {card["id"] for card in result["data"]},
            {"base1-1_en", "base1-1_de"},
        )

    def test_card_search_includes_current_users_compact_card_state(self):
        card = Card(id="base1-1_en", tcg_card_id="base1-1", name="Alakazam", set_id="base1", number="1", lang="en", is_custom=False)
        other = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([UserSetting(user_id=self.user.id, key="language", value="en"), card, other])
        self.db.commit()
        self.db.add_all([
            CollectionItem(card_id=card.id, user_id=self.user.id, variant="Reverse Holo", condition="NM", quantity=1),
            CollectionItem(card_id=card.id, user_id=self.user.id, variant="Normal", condition="LP", quantity=2),
            CollectionItem(card_id=card.id, user_id=other.id, variant="Holo", quantity=9),
            WishlistItem(card_id=card.id, user_id=self.user.id),
        ])
        self.db.commit()

        result = search_cards(type_filter=None, lang=None, db=self.db, current_user=self.user)
        state = result["data"][0]

        self.assertTrue(state["owned"])
        self.assertEqual(state["owned_quantity"], 3)
        self.assertEqual(state["owned_variants"], [{"variant": "Normal", "quantity": 2}, {"variant": "Reverse Holo", "quantity": 1}])
        self.assertTrue(state["wishlisted"])

    def test_get_card_without_lang_fetches_user_language(self):
        self.db.add(UserSetting(user_id=self.user.id, key="language", value="en"))
        self.db.commit()
        card_payload = {
            "id": "base1-1",
            "name": "Alakazam",
            "localId": "1",
            "set": {"id": "base1", "name": "Base Set", "cardCount": {"total": 102}},
        }
        parsed_card = {
            "id": "base1-1_en",
            "tcg_card_id": "base1-1",
            "name": "Alakazam",
            "set_id": "base1",
            "number": "1",
            "lang": "en",
            "is_custom": False,
        }

        with patch("api.cards.pokemon_api.get_card", return_value=card_payload) as get_card_api, \
             patch("api.cards.pokemon_api.parse_card_for_db", return_value=parsed_card), \
             patch("api.cards.apply_cross_language_fallbacks", side_effect=lambda _db, parsed: parsed):
            card = get_card("base1-1", lang=None, db=self.db, current_user=self.user)

        get_card_api.assert_called_once_with("base1-1", lang="en")
        self.assertEqual(card.id, "base1-1_en")


if __name__ == "__main__":
    unittest.main()
