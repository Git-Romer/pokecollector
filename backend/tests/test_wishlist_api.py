import datetime
import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.binders import add_binder_cards_to_wishlist, add_binder_entry_to_wishlist
    from api.cards import migrate_custom_card
    from api.wishlist import add_to_wishlist, update_wishlist_item
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, CustomCardMatch, User, WishlistItem
    from schemas import WishlistItemCreate, WishlistItemUpdate
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class WishlistApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Sprigatito",
            set_id="sv1",
            number="1",
            lang="en",
            variants_normal=True,
        )
        self.other_card = Card(
            id="sv1-2_en",
            tcg_card_id="sv1-2",
            name="Floragato",
            set_id="sv1",
            number="2",
            lang="en",
            variants_normal=True,
        )
        self.db.add_all([self.user, self.card, self.other_card])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_add_existing_wishlist_item_increments_quantity(self):
        first = add_to_wishlist(
            WishlistItemCreate(card_id=self.card.id, quantity=3, price_alert_above=10),
            current_user=self.user,
            db=self.db,
        )
        second = add_to_wishlist(
            WishlistItemCreate(card_id=self.card.id, quantity=2, price_alert_below=5),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(second.quantity, 5)
        self.assertEqual(second.price_alert_above, 10)
        self.assertEqual(second.price_alert_below, 5)
        self.assertEqual(self.db.query(WishlistItem).count(), 1)

    def test_update_wishlist_quantity_and_clear_alert(self):
        item = WishlistItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=4,
            price_alert_above=10,
            created_at=datetime.datetime.utcnow(),
        )
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)

        updated = update_wishlist_item(
            item.id,
            WishlistItemUpdate(quantity=2, price_alert_above=None),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(updated.quantity, 2)
        self.assertIsNone(updated.price_alert_above)

    def test_add_existing_wishlist_item_rejects_quantity_overflow(self):
        item = WishlistItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=99,
            created_at=datetime.datetime.utcnow(),
        )
        self.db.add(item)
        self.db.commit()

        with self.assertRaises(HTTPException):
            add_to_wishlist(
                WishlistItemCreate(card_id=self.card.id, quantity=1),
                current_user=self.user,
                db=self.db,
            )

    def test_wishlist_binder_adds_quantity_deltas_after_owned_and_wished_copies(self):
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="wishlist")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        self.db.add_all([
            BinderCard(binder_id=binder.id, card_id=self.card.id, required_quantity=4),
            BinderCard(binder_id=binder.id, card_id=self.other_card.id, required_quantity=2),
            CollectionItem(card_id=self.card.id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="en"),
            WishlistItem(card_id=self.card.id, user_id=self.user.id, quantity=1, created_at=datetime.datetime.utcnow()),
        ])
        self.db.commit()

        result = add_binder_cards_to_wishlist(binder.id, current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 2)
        self.assertEqual(result["added_copies"], 4)
        self.assertEqual(result["missing_copies"], 5)
        self.assertEqual(result["wishlist_copies"], 1)
        wished = {
            item.card_id: item.quantity
            for item in self.db.query(WishlistItem).filter(WishlistItem.user_id == self.user.id).all()
        }
        self.assertEqual(wished[self.card.id], 3)
        self.assertEqual(wished[self.other_card.id], 2)

    def test_collection_binder_entry_add_to_wishlist_uses_requested_quantity(self):
        binder = Binder(name="Collection Binder", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        entry = BinderCard(binder_id=binder.id, card_id=self.card.id, required_quantity=1)
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)

        first = add_binder_entry_to_wishlist(binder.id, entry.id, quantity=3, current_user=self.user, db=self.db)
        second = add_binder_entry_to_wishlist(binder.id, entry.id, quantity=2, current_user=self.user, db=self.db)

        self.assertEqual(first["added_copies"], 3)
        self.assertEqual(second["added_copies"], 2)
        wishlist_item = self.db.query(WishlistItem).filter(
            WishlistItem.card_id == self.card.id,
            WishlistItem.user_id == self.user.id,
        ).one()
        self.assertEqual(wishlist_item.quantity, 5)

    def test_custom_card_migration_merges_wishlist_and_binder_quantities(self):
        custom_card = Card(
            id="custom-test",
            name="Custom Sprigatito",
            lang="en",
            is_custom=True,
            custom_owner_id=self.user.id,
            variants_normal=True,
        )
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="wishlist")
        self.db.add_all([custom_card, binder])
        self.db.commit()
        self.db.refresh(binder)
        match = CustomCardMatch(custom_card_id=custom_card.id, api_card_id="sv1-1", status="pending")
        self.db.add_all([
            match,
            BinderCard(binder_id=binder.id, card_id=custom_card.id, required_quantity=3),
            BinderCard(binder_id=binder.id, card_id=self.card.id, required_quantity=2),
            WishlistItem(card_id=custom_card.id, user_id=self.user.id, quantity=4, created_at=datetime.datetime.utcnow()),
            WishlistItem(card_id=self.card.id, user_id=self.user.id, quantity=2, created_at=datetime.datetime.utcnow()),
        ])
        self.db.commit()
        self.db.refresh(match)

        parsed_card = {
            "id": self.card.id,
            "tcg_card_id": "sv1-1",
            "name": "Sprigatito",
            "set_id": "sv1",
            "number": "1",
            "lang": "en",
            "variants_normal": True,
        }
        with patch("api.cards.pokemon_api.get_card", return_value={"id": "sv1-1", "name": "Sprigatito"}), \
             patch("api.cards.pokemon_api.parse_card_for_db", return_value=parsed_card), \
             patch("api.cards.apply_cross_language_fallbacks", side_effect=lambda _db, parsed: parsed):
            result = migrate_custom_card(match.id, db=self.db, current_user=self.user)

        self.assertEqual(result["status"], "migrated")
        wishlist_item = self.db.query(WishlistItem).filter(
            WishlistItem.card_id == self.card.id,
            WishlistItem.user_id == self.user.id,
        ).one()
        self.assertEqual(wishlist_item.quantity, 6)
        binder_entries = self.db.query(BinderCard).filter(
            BinderCard.binder_id == binder.id,
            BinderCard.card_id == self.card.id,
        ).all()
        self.assertEqual(len(binder_entries), 1)
        self.assertEqual(binder_entries[0].required_quantity, 5)
        self.assertIsNone(self.db.query(Card).filter(Card.id == custom_card.id).first())


if __name__ == "__main__":
    unittest.main()
