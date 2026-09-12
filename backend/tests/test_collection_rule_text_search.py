import unittest

try:
    from sqlalchemy import JSON, create_engine
    from sqlalchemy.orm import sessionmaker

    from api.collection import get_collection
    from database import Base
    from models import Card, CollectionItem, Setting, User

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class CollectionRuleTextSearchTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            self.other_user,
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
            Card(id="nulls_en", name="Null Values", set_id="test", number="6", lang="en", is_custom=False,
                 attacks=None, abilities=None),
            Card(id="json-null_en", name="JSON Null", set_id="test", number="7", lang="en", is_custom=False,
                 attacks=JSON.NULL, abilities=JSON.NULL),
            Card(id="empty-arrays_en", name="Empty Arrays", set_id="test", number="8", lang="en", is_custom=False,
                 attacks=[], abilities=[]),
            Card(id="other-user_en", name="Other User", set_id="test", number="9", lang="en", is_custom=False,
                 attacks=[{"name": "Private Signal", "effect": "Normal effect"}]),
        ])
        self.db.flush()
        cards = {card.id: card for card in self.db.query(Card).all()}
        self.db.add_all([
            CollectionItem(card_id=cards["attack-name_en"].id, user_id=self.user.id, quantity=2, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["attack-name_en"].id, user_id=self.user.id, quantity=1, condition="LP", variant="Holo", lang="en"),
            CollectionItem(card_id=cards["attack-effect_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["ability-name_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["ability-effect_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["card-effect_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["nulls_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["json-null_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["empty-arrays_en"].id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            CollectionItem(card_id=cards["other-user_en"].id, user_id=self.other_user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _collection(self, **kwargs):
        return get_collection(current_user=self.user, db=self.db, **kwargs)

    def _card_ids(self, **kwargs):
        return [item.card_id for item in self._collection(**kwargs)]

    def test_rule_text_matches_attack_name_and_preserves_distinct_items(self):
        items = self._collection(rule_text="thunder jab")
        self.assertEqual([item.card_id for item in items], ["attack-name_en", "attack-name_en"])
        self.assertEqual({item.quantity for item in items}, {1, 2})
        self.assertEqual({item.condition for item in items}, {"NM", "LP"})
        self.assertEqual({item.variant for item in items}, {"Normal", "Holo"})

    def test_rule_text_matches_attack_effect(self):
        self.assertEqual(self._card_ids(rule_text="prism orb"), ["attack-effect_en"])

    def test_rule_text_matches_ability_name(self):
        self.assertEqual(self._card_ids(rule_text="solar engine"), ["ability-name_en"])

    def test_rule_text_matches_ability_effect(self):
        self.assertEqual(self._card_ids(rule_text="moon bridge"), ["ability-effect_en"])

    def test_rule_text_matches_card_effect(self):
        self.assertEqual(self._card_ids(rule_text="crystal map"), ["card-effect_en"])

    def test_rule_text_no_match_is_safe_for_null_and_empty_json(self):
        self.assertEqual(self._card_ids(rule_text="does not exist"), [])

    def test_rule_text_is_scoped_to_the_current_user(self):
        self.assertEqual(self._card_ids(rule_text="private signal"), [])

    def test_rule_text_omitted_preserves_all_current_user_items(self):
        self.assertEqual(len(self._collection()), 9)


if __name__ == "__main__":
    unittest.main()
