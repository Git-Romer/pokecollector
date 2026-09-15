import datetime
import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.public import (
        PublicDeckDetail,
        PublicWishlist,
        get_public_deck,
        get_public_deck_probability,
        get_public_wishlist,
    )
    from api.social import compare_users
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, Set, Setting, User, WishlistItem
    from schemas import DeckProbabilityResponse
    from services import public_profile as pp
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy dependencies unavailable")
class PublicWishlistDeckTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.owner = User(
            username="ash",
            hashed_password="x",
            role="trainer",
            is_active=True,
            public_handle="ash",
            is_profile_public=True,
            wishlist_visibility="public",
        )
        self.viewer = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.owner,
            self.viewer,
            Setting(key="public_profiles_enabled", value="true"),
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=3),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en", rarity="Common", supertype="Pokemon", stage="Basic", price_trend=5),
            Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Ultra Ball", set_id="sv1", number="2", lang="en", rarity="Uncommon", supertype="Trainer", price_trend=2),
        ])
        self.db.commit()
        self.db.refresh(self.owner)
        self.db.refresh(self.viewer)
        custom = Card(id="custom-1", name="Private proxy", set_id="custom", number="1", lang="en", is_custom=True, custom_owner_id=self.owner.id)
        self.db.add_all([
            custom,
            WishlistItem(user_id=self.owner.id, card_id="sv1-1_en", quantity=3, price_alert_above=10, price_alert_below=1, notified_at=datetime.datetime(2026, 1, 1)),
            WishlistItem(user_id=self.owner.id, card_id="sv1-2_en", quantity=1),
            WishlistItem(user_id=self.owner.id, card_id="custom-1", quantity=9),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _wishlist(self, **overrides):
        params = {
            "search": None,
            "set_id": None,
            "rarity": None,
            "sort": "date_added",
            "order": "desc",
            "page": 1,
            "page_size": 48,
            "db": self.db,
        }
        params.update(overrides)
        return get_public_wishlist("ash", **params)

    def test_public_wishlist_is_paginated_and_never_leaks_private_fields_or_custom_cards(self):
        result = self._wishlist(page_size=1)
        PublicWishlist.model_validate(result)
        self.assertEqual(result["total"], 2)
        self.assertEqual(len(result["cards"]), 1)
        all_cards = self._wishlist()["cards"]
        self.assertNotIn("custom-1", {card["id"] for card in all_cards})
        for card in all_cards:
            for private in ("user_id", "price_alert_above", "price_alert_below", "notified_at", "custom_owner_id", "custom_image_url"):
                self.assertNotIn(private, card)
            self.assertIsNone(card["market_value"])

    def test_public_wishlist_search_filter_sort_and_values_follow_profile_setting(self):
        self.owner.public_show_values = True
        self.db.commit()
        result = self._wishlist(search="sprig", set_id="sv1", rarity="common", sort="price", order="desc")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["cards"][0]["name"], "Sprigatito")
        self.assertEqual(result["cards"][0]["market_value"], 5)

    def test_private_and_trade_match_modes_hide_complete_wishlist(self):
        for visibility in ("private", "trade_matches"):
            self.owner.wishlist_visibility = visibility
            self.db.commit()
            with self.assertRaises(HTTPException) as context:
                self._wishlist()
            self.assertEqual(context.exception.status_code, 404)

    def test_price_sort_is_rejected_when_values_are_hidden(self):
        with self.assertRaises(HTTPException) as context:
            self._wishlist(sort="price")
        self.assertEqual(context.exception.status_code, 422)

    def _public_deck(self, binder_type="deck"):
        deck = Binder(
            name="Tournament",
            user_id=self.owner.id,
            binder_type=binder_type,
            target_size=20,
            format="Standard",
            is_public=True,
        )
        self.db.add(deck)
        self.db.commit()
        self.db.add_all([
            BinderCard(binder_id=deck.id, card_id="sv1-1_en", required_quantity=4),
            BinderCard(binder_id=deck.id, card_id="sv1-2_en", required_quantity=4),
        ])
        self.db.commit()
        return deck

    def test_planned_and_real_public_decks_expose_analysis_without_ownership(self):
        for binder_type in ("deck", "physical_deck"):
            deck = self._public_deck(binder_type)
            result = get_public_deck("ash", deck.id, db=self.db)
            PublicDeckDetail.model_validate(result)
            self.assertEqual(result["binder_type"], binder_type)
            self.assertIn("analysis", result)
            self.assertNotIn("ownership", {check["code"] for check in result["validation"]["checks"]})
            self.assertNotIn("entry_id", repr(result["validation"]))
            for entry in result["entries"]:
                for private in ("owned_quantity", "shortage", "allocated_quantity", "allocated_prints", "collection_item_id", "display_variant"):
                    self.assertNotIn(private, entry)
            probability = get_public_deck_probability(
                "ash", deck.id, hand=7, draws=0, card_name="Sprigatito", prize_count=6, db=self.db
            )
            DeckProbabilityResponse.model_validate(probability)
            self.assertEqual(probability["key_card"]["copies"], 4)

    def test_private_deck_is_not_found(self):
        deck = self._public_deck()
        deck.is_public = False
        self.db.commit()
        with self.assertRaises(HTTPException) as context:
            get_public_deck("ash", deck.id, db=self.db)
        self.assertEqual(context.exception.status_code, 404)

    def test_custom_card_deck_is_hidden_from_profile_directory_and_detail(self):
        deck = Binder(
            name="Private proxy Deck",
            user_id=self.owner.id,
            binder_type="deck",
            target_size=20,
            format="Casual",
            is_public=True,
        )
        self.db.add(deck)
        self.db.flush()
        self.db.add(BinderCard(binder_id=deck.id, card_id="custom-1", required_quantity=1))
        self.db.commit()

        self.assertEqual(pp.serialize_profile(self.db, self.owner)["decks"], [])
        directory_entry = next(item for item in pp.public_profile_directory(self.db) if item["handle"] == "ash")
        self.assertEqual(directory_entry["deck_count"], 0)
        for operation in (
            lambda: get_public_deck("ash", deck.id, db=self.db),
            lambda: get_public_deck_probability(
                "ash", deck.id, hand=7, draws=0, card_name=None, prize_count=6, db=self.db
            ),
        ):
            with self.assertRaises(HTTPException) as context:
                operation()
            self.assertEqual(context.exception.status_code, 404)

    def test_trade_matches_respect_owner_profile_and_visibility(self):
        self.db.add(CollectionItem(user_id=self.viewer.id, card_id="sv1-1_en", quantity=2, variant="Normal", condition="NM", lang="en"))
        self.db.commit()
        result = compare_users(self.owner.id, price_field="price_trend", db=self.db, current_user=self.viewer)
        self.assertEqual(len(result["trade_suggestions"]), 1)
        self.owner.wishlist_visibility = "private"
        self.db.commit()
        result = compare_users(self.owner.id, price_field="price_trend", db=self.db, current_user=self.viewer)
        self.assertEqual(result["trade_suggestions"], [])
        self.owner.wishlist_visibility = "trade_matches"
        self.owner.is_profile_public = False
        self.db.commit()
        result = compare_users(self.owner.id, price_field="price_trend", db=self.db, current_user=self.viewer)
        self.assertEqual(result["trade_suggestions"], [])


if __name__ == "__main__":
    unittest.main()
