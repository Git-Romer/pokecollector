import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.binders import add_owned_set_to_auto_binder, add_owned_set_to_binder, add_collection_item_to_binder
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, Set, User
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class AddOwnedSetToBinderTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.card_a = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en", variants_normal=True)
        self.card_b = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1", number="2", lang="en", variants_normal=True)
        self.foreign_card = Card(id="sv2-1_en", tcg_card_id="sv2-1", name="Charmander", set_id="sv2", number="1", lang="en", variants_normal=True)
        self.set_obj = Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en")
        self.db.add_all([self.user, self.card_a, self.card_b, self.foreign_card, self.set_obj])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _collection_binder(self, name="My Binder"):
        binder = Binder(name=name, user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        return binder

    def _own(self, card_id, variant="Normal", quantity=1, condition="NM"):
        item = CollectionItem(card_id=card_id, user_id=self.user.id, quantity=quantity, condition=condition, variant=variant, lang="en")
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        return item

    def test_owned_variants_become_separate_entries(self):
        self._own(self.card_a.id, variant="Normal")
        self._own(self.card_a.id, variant="Reverse Holo")
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 2)
        self.assertEqual(result["skipped_present"], 0)
        self.assertEqual(result["skipped_no_capacity"], 0)
        self.assertEqual(result["owned_total"], 2)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 2)

    def test_multiple_copies_of_one_variant_make_one_entry(self):
        self._own(self.card_a.id, variant="Normal", quantity=3)
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["owned_total"], 1)
        entry = self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).one()
        self.assertEqual(entry.required_quantity, 3)

    def test_item_already_in_binder_is_skipped(self):
        item = self._own(self.card_a.id, variant="Normal")
        self._own(self.card_b.id, variant="Normal")
        binder = self._collection_binder()
        add_collection_item_to_binder(binder.id, item.id, current_user=self.user, db=self.db)

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["skipped_present"], 1)
        self.assertEqual(result["owned_total"], 2)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 2)

    def test_rerun_adds_nothing(self):
        self._own(self.card_a.id, variant="Normal")
        binder = self._collection_binder()
        add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["skipped_present"], 1)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 1)

    def test_copy_allocated_to_another_binder_is_skipped(self):
        item = self._own(self.card_a.id, variant="Normal", quantity=1)
        other = self._collection_binder(name="Other")
        add_collection_item_to_binder(other.id, item.id, current_user=self.user, db=self.db)
        target = self._collection_binder(name="Target")

        result = add_owned_set_to_binder(target.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["skipped_no_capacity"], 1)
        self.assertEqual(result["owned_total"], 1)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == target.id).count(), 0)

    def test_two_copies_one_free_is_added(self):
        item = self._own(self.card_a.id, variant="Normal", quantity=2)
        other = self._collection_binder(name="Other")
        add_collection_item_to_binder(other.id, item.id, current_user=self.user, db=self.db)
        target = self._collection_binder(name="Target")

        result = add_owned_set_to_binder(target.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 1)
        self.assertEqual(result["skipped_no_capacity"], 0)
        entry = self.db.query(BinderCard).filter(BinderCard.binder_id == target.id).one()
        self.assertEqual(entry.required_quantity, 1)

    def test_wishlist_binder_is_rejected(self):
        self._own(self.card_a.id, variant="Normal")
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="wishlist")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)

        with self.assertRaises(HTTPException) as ctx:
            add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_foreign_set_adds_nothing(self):
        self._own(self.foreign_card.id, variant="Normal")
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result, {"added": 0, "skipped_present": 0, "skipped_no_capacity": 0, "owned_total": 0})

    def test_zero_quantity_row_is_not_added(self):
        self._own(self.card_a.id, variant="Normal", quantity=0)
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["owned_total"], 0)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 0)

    def test_missing_binder_raises_404(self):
        with self.assertRaises(HTTPException) as ctx:
            add_owned_set_to_binder(999, set_id="sv1_en", current_user=self.user, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_unknown_set_raises_404(self):
        binder = self._collection_binder()
        with self.assertRaises(HTTPException) as ctx:
            add_owned_set_to_binder(binder.id, set_id="does-not-exist_en", current_user=self.user, db=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_other_language_of_set_is_not_added(self):
        fr_card = Card(id="sv1-1_fr", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="fr", variants_normal=True)
        self.db.add(fr_card)
        self.db.commit()
        item = CollectionItem(card_id=fr_card.id, user_id=self.user.id, quantity=1, condition="NM", variant="Normal", lang="fr")
        self.db.add(item)
        self.db.commit()
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["owned_total"], 0)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 0)

    def test_other_users_collection_items_are_not_added(self):
        other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add(other_user)
        self.db.commit()
        self.db.refresh(other_user)
        self.db.add(CollectionItem(
            card_id=self.card_a.id,
            user_id=other_user.id,
            quantity=1,
            condition="NM",
            variant="Normal",
            lang="en",
        ))
        self.db.commit()
        binder = self._collection_binder()

        result = add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["owned_total"], 0)
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id).count(), 0)

    def test_other_users_binder_is_not_accessible(self):
        other_user = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        self.db.add(other_user)
        self.db.commit()
        self.db.refresh(other_user)
        binder = Binder(name="Private", user_id=other_user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)

        with self.assertRaises(HTTPException) as ctx:
            add_owned_set_to_binder(binder.id, set_id="sv1_en", current_user=self.user, db=self.db)

        self.assertEqual(ctx.exception.status_code, 404)

    def test_auto_binder_is_created_then_reused(self):
        self._own(self.card_a.id, variant="Normal")

        first = add_owned_set_to_auto_binder(set_id="sv1_en", current_user=self.user, db=self.db)
        second = add_owned_set_to_auto_binder(set_id="sv1_en", current_user=self.user, db=self.db)

        binders = self.db.query(Binder).filter(
            Binder.user_id == self.user.id,
            Binder.auto_owned_set_id == "sv1_en",
            Binder.binder_type == "collection",
        ).all()
        self.assertEqual(len(binders), 1)
        self.assertTrue(first["binder_created"])
        self.assertFalse(second["binder_created"])
        self.assertEqual(first["binder_id"], second["binder_id"])
        self.assertEqual(first["added"], 1)
        self.assertEqual(second["added"], 0)
        self.assertEqual(second["skipped_present"], 1)

    def test_auto_binder_does_not_reuse_wishlist_binder(self):
        wishlist = Binder(
            name="Scarlet & Violet (owned)",
            user_id=self.user.id,
            binder_type="wishlist",
        )
        self.db.add(wishlist)
        self.db.commit()

        result = add_owned_set_to_auto_binder(set_id="sv1_en", current_user=self.user, db=self.db)

        created = self.db.query(Binder).filter(
            Binder.user_id == self.user.id,
            Binder.auto_owned_set_id == "sv1_en",
            Binder.binder_type == "collection",
        ).all()
        self.assertEqual(len(created), 1)
        self.assertTrue(result["binder_created"])

    def test_same_named_localized_sets_get_distinct_auto_binders(self):
        fr_set = Set(id="sv1_fr", tcg_set_id="sv1", name="Scarlet & Violet", lang="fr")
        fr_card = Card(
            id="sv1-2_fr",
            tcg_card_id="sv1-2",
            name="Herbizarre",
            set_id="sv1",
            number="2",
            lang="fr",
            variants_normal=True,
        )
        self.db.add_all([fr_set, fr_card])
        self.db.commit()
        self.db.add(CollectionItem(
            card_id=fr_card.id,
            user_id=self.user.id,
            quantity=1,
            condition="NM",
            variant="Normal",
            lang="fr",
        ))
        self.db.commit()

        en_result = add_owned_set_to_auto_binder(set_id="sv1_en", current_user=self.user, db=self.db)
        fr_result = add_owned_set_to_auto_binder(set_id="sv1_fr", current_user=self.user, db=self.db)

        self.assertNotEqual(en_result["binder_id"], fr_result["binder_id"])
        auto_ids = {
            binder.auto_owned_set_id
            for binder in self.db.query(Binder).filter(Binder.user_id == self.user.id).all()
        }
        self.assertEqual(auto_ids, {"sv1_en", "sv1_fr"})


if __name__ == "__main__":
    unittest.main()
