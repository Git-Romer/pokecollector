import datetime
import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.cards import get_card, get_price_history
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, Set, Setting, User, WishlistItem
    from services.card_visibility import (
        get_pinned_set_language_pairs,
        sync_set_filter,
        visible_card_filter,
        visible_set_filter,
    )
    from services.sync_service import _price_sync_plan
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class CardVisibilityTests(unittest.TestCase):
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
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Set(id="sv1_en", tcg_set_id="sv1", name="SV1 EN", lang="en"),
            Set(id="sv1_de", tcg_set_id="sv1", name="SV1 DE", lang="de"),
            Set(id="sv1_fr", tcg_set_id="sv1", name="SV1 FR", lang="fr"),
            Set(id="sv2_fr", tcg_set_id="sv2", name="SV2 FR", lang="fr"),
            Set(id="sv3_ja", tcg_set_id="sv3", name="SV3 JA", lang="ja"),
            Set(id="sv4_nl", tcg_set_id="sv4", name="SV4 NL", lang="nl"),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Active EN", set_id="sv1", number="1", lang="en", is_custom=False),
            Card(id="sv1-1_fr", tcg_card_id="sv1-1", name="Hidden FR", set_id="sv1", number="1", lang="fr", is_custom=False),
            Card(id="sv2-1_fr", tcg_card_id="sv2-1", name="Pinned Collection FR", set_id="sv2", number="1", lang="fr", is_custom=False),
            Card(id="sv2-2_fr", tcg_card_id="sv2-2", name="Pinned Set Other FR", set_id="sv2", number="2", lang="fr", is_custom=False),
            Card(id="sv3-1_ja", tcg_card_id="sv3-1", name="Pinned Wishlist JA", set_id="sv3", number="1", lang="ja", is_custom=False),
            Card(id="sv4-1_nl", tcg_card_id="sv4-1", name="Pinned Binder NL", set_id="sv4", number="1", lang="nl", is_custom=False),
        ])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)
        binder = Binder(name="Wishlist binder", user_id=self.user.id, binder_type="wishlist")
        self.db.add_all([
            CollectionItem(
                card_id="sv2-1_fr",
                user_id=self.user.id,
                quantity=1,
                condition="NM",
                variant="Normal",
                lang="fr",
                added_at=datetime.datetime.utcnow(),
            ),
            WishlistItem(card_id="sv3-1_ja", user_id=self.user.id, quantity=1, created_at=datetime.datetime.utcnow()),
            binder,
        ])
        self.db.commit()
        self.db.refresh(binder)
        self.db.add(BinderCard(binder_id=binder.id, card_id="sv4-1_nl", required_quantity=1))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_collection_wishlist_and_binder_cards_pin_their_localized_sets(self):
        self.assertEqual(
            get_pinned_set_language_pairs(self.db, user_id=self.user.id),
            {("sv2", "fr"), ("sv3", "ja"), ("sv4", "nl")},
        )

    def test_all_sets_show_active_languages_and_current_user_pins_only(self):
        visible_ids = {
            row.id
            for row in self.db.query(Set).filter(visible_set_filter(self.db, self.user.id, "all")).all()
        }
        self.assertIn("sv1_en", visible_ids)
        self.assertIn("sv1_de", visible_ids)
        self.assertIn("sv2_fr", visible_ids)
        self.assertIn("sv3_ja", visible_ids)
        self.assertIn("sv4_nl", visible_ids)
        self.assertNotIn("sv1_fr", visible_ids)

        other_visible_ids = {
            row.id
            for row in self.db.query(Set).filter(visible_set_filter(self.db, self.other_user.id, "all")).all()
        }
        self.assertEqual(other_visible_ids, {"sv1_en", "sv1_de"})

    def test_disabled_language_filter_only_shows_pinned_sets_and_cards(self):
        fr_set_ids = {
            row.id
            for row in self.db.query(Set).filter(visible_set_filter(self.db, self.user.id, "fr")).all()
        }
        self.assertEqual(fr_set_ids, {"sv2_fr"})

        fr_card_ids = {
            row.id
            for row in self.db.query(Card).filter(visible_card_filter(self.db, self.user.id, "fr")).all()
        }
        self.assertEqual(fr_card_ids, {"sv2-1_fr", "sv2-2_fr"})

    def test_background_sync_keeps_app_wide_pinned_sets(self):
        sync_set_ids = {row.id for row in self.db.query(Set).filter(sync_set_filter(self.db)).all()}
        self.assertIn("sv1_en", sync_set_ids)
        self.assertIn("sv1_de", sync_set_ids)
        self.assertIn("sv2_fr", sync_set_ids)
        self.assertIn("sv3_ja", sync_set_ids)
        self.assertIn("sv4_nl", sync_set_ids)
        self.assertNotIn("sv1_fr", sync_set_ids)

    def test_full_sync_price_plan_includes_all_cards_in_pinned_set(self):
        plan = _price_sync_plan(self.db, force=True, include_pinned_sets=True)

        self.assertIn("sv2-1_fr", plan["ids"])
        self.assertIn("sv2-2_fr", plan["ids"])

    def test_unsuffixed_disabled_language_fetch_is_blocked(self):
        with patch("api.cards.pokemon_api.get_card") as get_card_api:
            with self.assertRaises(HTTPException) as ctx:
                get_card("sv1-99", lang="fr", db=self.db, current_user=self.user)

        self.assertEqual(ctx.exception.status_code, 404)
        get_card_api.assert_not_called()

    def test_price_history_for_hidden_disabled_language_card_is_blocked(self):
        with self.assertRaises(HTTPException) as ctx:
            get_price_history("sv1-1_fr", db=self.db, current_user=self.user)

        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
