import unittest

try:
    from sqlalchemy import JSON, create_engine
    from sqlalchemy.orm import sessionmaker

    from api.cards import search_cards
    from database import Base
    from models import Card, Setting, User

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class CardRuleTextSearchTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en"),
            Card(id="attack-name_en", name="Attack Name", set_id="test", number="1", lang="en", is_custom=False,
                 attacks=[{"name": "Thunder Jab", "effect": "Normal attack effect"}]),
            Card(id="attack-effect_en", name="Attack Effect", set_id="test", number="2", lang="en", is_custom=False,
                 attacks=[{"name": "Normal Attack", "effect": "Discard a Prism Orb."}]),
            Card(id="ability-name_en", name="Ability Name", set_id="test", number="3", lang="en", is_custom=False,
                 abilities=[{"name": "Solar Engine", "effect": "Normal ability effect"}]),
            Card(id="ability-effect_en", name="Ability Effect", set_id="test", number="4", lang="en", is_custom=False,
                 abilities=[{"name": "Normal Ability", "effect": "Create a Moon Bridge."}]),
            Card(id="card-effect_en", name="Card Effect", set_id="test", number="5", lang="en", is_custom=False,
                 card_effect="Search your deck for a Crystal Map."),
            Card(id="accent_en", name="Accent", set_id="test", number="6", lang="en", is_custom=False,
                 attacks=[{"name": "Éclair Burst", "effect": "Normal effect"}]),
            Card(id="category_en", name="Category Match", set_id="test", number="7", lang="en", is_custom=False,
                 supertype="Trainer", card_effect="Recover a Lost Compass."),
            Card(id="nulls_en", name="Null Values", set_id="test", number="8", lang="en", is_custom=False,
                 attacks=None, abilities=None),
            Card(id="json-null_en", name="JSON Null", set_id="test", number="9", lang="en", is_custom=False,
                 attacks=JSON.NULL),
            Card(id="empty-arrays_en", name="Empty Arrays", set_id="test", number="10", lang="en", is_custom=False,
                 attacks=[], abilities=[]),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _search_ids(self, **kwargs):
        result = search_cards(type_filter=None, db=self.db, current_user=self.user, **kwargs)
        return [card["id"] for card in result["data"]]

    def test_rule_text_matches_attack_name(self):
        self.assertEqual(self._search_ids(rule_text="thunder jab"), ["attack-name_en"])

    def test_rule_text_matches_attack_effect(self):
        self.assertEqual(self._search_ids(rule_text="prism orb"), ["attack-effect_en"])

    def test_rule_text_matches_ability_name(self):
        self.assertEqual(self._search_ids(rule_text="solar engine"), ["ability-name_en"])

    def test_rule_text_matches_ability_effect(self):
        self.assertEqual(self._search_ids(rule_text="moon bridge"), ["ability-effect_en"])

    def test_rule_text_matches_card_effect(self):
        self.assertEqual(self._search_ids(rule_text="crystal map"), ["card-effect_en"])

    def test_rule_text_no_match_and_null_json_values_are_safe(self):
        self.assertEqual(self._search_ids(rule_text="does not exist"), [])

    def test_rule_text_omitted_preserves_unfiltered_search(self):
        self.assertEqual(len(self._search_ids()), 10)

    def test_rule_text_combines_with_existing_filter(self):
        self.assertEqual(self._search_ids(rule_text="lost compass", category="Trainer"), ["category_en"])
        self.assertEqual(self._search_ids(rule_text="lost compass", name="Category"), ["category_en"])

    def test_rule_text_matches_accents_insensitively(self):
        self.assertEqual(self._search_ids(rule_text="eclair burst"), ["accent_en"])


if __name__ == "__main__":
    unittest.main()
