import asyncio
import io
import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException, UploadFile
    from sqlalchemy import create_engine
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import sessionmaker

    from api.binders import (
        add_collection_item_to_binder,
        add_card_to_binder,
        add_binder_cards_to_wishlist,
        apply_binder_print_optimization,
        convert_collection_binder_to_wishlist,
        convert_wishlist_binder_to_collection,
        export_binder_csv,
        get_binder_cards,
        import_binder_csv,
        switch_binder_entry_card,
        update_binder,
        update_binder_entry,
    )
    from api.collection import remove_from_collection, update_collection_item
    import database
    from database import Base, migrate_legacy_collection_binder_entries
    from models import Binder, BinderCard, Card, CollectionItem, Set, User, WishlistItem
    from schemas import BinderCardSwitch, BinderCardUpdate, BinderUpdate, CollectionItemUpdate
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed")
class BinderAllocatedQuantityTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.Session = Session
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.card = Card(
            id="sv1-25_en",
            tcg_card_id="sv1-25",
            name="Pikachu",
            set_id="sv1",
            number="25",
            lang="en",
            price_trend=10,
            playable_fingerprint="pikachu-basic",
        )
        self.alt_card = Card(
            id="base1-58_en",
            tcg_card_id="base1-58",
            name="Pikachu",
            set_id="base1",
            number="58",
            lang="en",
            price_trend=8,
            playable_fingerprint="pikachu-basic",
        )
        self.set = Set(
            id="sv1_en",
            tcg_set_id="sv1",
            name="Scarlet & Violet",
            abbreviation="SV1",
            lang="en",
        )
        self.db.add_all([self.user, self.card, self.alt_card, self.set])
        self.db.commit()
        self.item = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=4,
            condition="NM",
            variant="Holo",
            lang="en",
        )
        self.alt_item = CollectionItem(
            card_id=self.alt_card.id,
            user_id=self.user.id,
            quantity=4,
            condition="NM",
            variant="Normal",
            lang="en",
        )
        self.first = Binder(name="Deck", user_id=self.user.id, binder_type="collection")
        self.second = Binder(name="Trade binder", user_id=self.user.id, binder_type="collection")
        self.db.add_all([self.item, self.alt_item, self.first, self.second])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_allocations_are_enforced_and_existing_entry_is_incremented(self):
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=3, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.second.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )

        with self.assertRaises(HTTPException) as context:
            add_collection_item_to_binder(
                self.second.id, self.item.id, quantity=1, current_user=self.user, db=self.db
            )
        self.assertEqual(context.exception.status_code, 409)

        entry = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).one()
        update_binder_entry(
            self.first.id,
            entry.id,
            BinderCardUpdate(required_quantity=2),
            current_user=self.user,
            db=self.db,
        )
        result = add_collection_item_to_binder(
            self.second.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )
        self.assertEqual(result["required_quantity"], 2)
        self.assertEqual(
            sum(row.required_quantity for row in self.db.query(BinderCard).all()),
            4,
        )

    def test_wishlist_does_not_reserve_and_progress_uses_unallocated_copies(self):
        wishlist = Binder(name="Wishlist", user_id=self.user.id, binder_type="wishlist")
        self.db.add(wishlist)
        self.db.flush()
        self.db.add(BinderCard(
            binder_id=wishlist.id,
            card_id=self.card.id,
            required_quantity=4,
        ))
        self.db.commit()

        before = get_binder_cards(
            wishlist.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(before["owned_count"], 4)
        self.assertEqual(before["missing_count"], 0)

        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )

        after = get_binder_cards(
            wishlist.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(after["cards"][0]["owned_quantity"], 3)
        self.assertEqual(after["owned_count"], 3)
        self.assertEqual(after["missing_count"], 1)

        wishlist_result = add_binder_cards_to_wishlist(
            wishlist.id,
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(wishlist_result["added_copies"], 1)
        global_wishlist = self.db.query(WishlistItem).filter(
            WishlistItem.user_id == self.user.id,
            WishlistItem.card_id == self.card.id,
        ).one()
        self.assertEqual(global_wishlist.quantity, 1)

    def test_allocation_progress_uses_the_exact_collection_item_card(self):
        wishlist = Binder(name="Wishlist", user_id=self.user.id, binder_type="wishlist")
        self.db.add(wishlist)
        self.db.flush()
        self.db.add_all([
            BinderCard(
                binder_id=self.first.id,
                card_id=self.alt_card.id,
                collection_item_id=self.item.id,
                required_quantity=1,
            ),
            BinderCard(
                binder_id=wishlist.id,
                card_id=self.card.id,
                required_quantity=4,
            ),
        ])
        self.db.commit()

        detail = get_binder_cards(
            wishlist.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(detail["owned_count"], 3)
        self.assertEqual(detail["missing_count"], 1)

    def test_card_add_rechecks_binder_type_after_a_cache_commit(self):
        wishlist = Binder(name="Wishlist", user_id=self.user.id, binder_type="wishlist")
        self.db.add(wishlist)
        self.db.commit()

        def convert_during_cache(_db, _card_id):
            locked = self.db.query(Binder).filter(Binder.id == wishlist.id).one()
            locked.binder_type = "collection"
            self.db.commit()
            return self.card

        with patch("api.binders.ensure_card_exists", side_effect=convert_during_cache):
            with self.assertRaises(HTTPException) as context:
                add_card_to_binder(
                    wishlist.id,
                    self.card.id,
                    current_user=self.user,
                    db=self.db,
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(
            self.db.query(BinderCard).filter(BinderCard.binder_id == wishlist.id).count(),
            0,
        )

    def test_complete_wishlist_conversion_allocates_exact_owned_rows(self):
        self.item.quantity = 2
        second_item = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=2,
            condition="LP",
            variant="Normal",
            lang="en",
        )
        wishlist = Binder(
            name="Wishlist",
            user_id=self.user.id,
            binder_type="wishlist",
            is_public=True,
        )
        other_wishlist = Binder(
            name="Other wishlist",
            user_id=self.user.id,
            binder_type="wishlist",
        )
        self.db.add_all([second_item, wishlist, other_wishlist])
        self.db.flush()
        self.db.add_all([
            BinderCard(
                binder_id=wishlist.id,
                card_id=self.card.id,
                required_quantity=4,
            ),
            BinderCard(
                binder_id=other_wishlist.id,
                card_id=self.card.id,
                required_quantity=4,
            ),
        ])
        self.db.commit()

        result = convert_wishlist_binder_to_collection(
            wishlist.id,
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["allocated_copies"], 4)
        self.assertEqual(result["binder"].binder_type, "collection")
        self.assertFalse(result["binder"].is_public)
        rows = self.db.query(BinderCard).filter(BinderCard.binder_id == wishlist.id).all()
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            {row.collection_item_id: row.required_quantity for row in rows},
            {self.item.id: 2, second_item.id: 2},
        )
        other_result = get_binder_cards(
            other_wishlist.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(other_result["owned_count"], 0)
        self.assertEqual(other_result["missing_count"], 4)

    def test_collection_conversion_releases_allocations_and_merges_same_card_rows(self):
        second_item = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=3,
            condition="LP",
            variant="Normal",
            lang="en",
        )
        self.first.is_public = True
        self.db.add(second_item)
        self.db.commit()
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=2, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.first.id, second_item.id, quantity=3, current_user=self.user, db=self.db
        )

        result = convert_collection_binder_to_wishlist(
            self.first.id,
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["released_copies"], 5)
        self.assertEqual(result["binder"].binder_type, "wishlist")
        self.assertFalse(result["binder"].is_public)
        rows = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).all()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].collection_item_id)
        self.assertEqual(rows[0].required_quantity, 5)

        add_collection_item_to_binder(
            self.second.id, self.item.id, quantity=4, current_user=self.user, db=self.db
        )
        wishlist = get_binder_cards(
            self.first.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(wishlist["owned_count"], 3)
        self.assertEqual(wishlist["missing_count"], 2)

    def test_collection_conversion_preserves_totals_above_single_row_limit(self):
        self.item.quantity = 99
        second_item = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=51,
            condition="LP",
            variant="Normal",
            lang="en",
        )
        self.db.add(second_item)
        self.db.commit()
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=99, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.first.id, second_item.id, quantity=51, current_user=self.user, db=self.db
        )

        convert_collection_binder_to_wishlist(
            self.first.id,
            current_user=self.user,
            db=self.db,
        )

        rows = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).all()
        self.assertEqual(sorted(row.required_quantity for row in rows), [51, 99])
        self.assertTrue(all(row.collection_item_id is None for row in rows))

    def test_empty_collection_binder_can_be_converted_to_wishlist(self):
        result = convert_collection_binder_to_wishlist(
            self.first.id,
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["released_copies"], 0)
        self.assertEqual(result["binder"].binder_type, "wishlist")

    def test_collection_conversion_does_not_report_legacy_unlinked_rows_as_released(self):
        self.db.add(BinderCard(
            binder_id=self.first.id,
            card_id=self.card.id,
            required_quantity=3,
        ))
        self.db.commit()

        result = convert_collection_binder_to_wishlist(
            self.first.id,
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["released_copies"], 0)
        row = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).one()
        self.assertEqual(row.required_quantity, 3)
        self.assertIsNone(row.collection_item_id)

    def test_collection_conversion_releases_auto_owned_set_identity(self):
        self.first.auto_owned_set_id = self.set.id
        self.db.commit()

        convert_collection_binder_to_wishlist(
            self.first.id,
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(self.first)
        self.assertIsNone(self.first.auto_owned_set_id)
        replacement = Binder(
            name="Scarlet & Violet (owned)",
            user_id=self.user.id,
            binder_type="collection",
            auto_owned_set_id=self.set.id,
        )
        self.db.add(replacement)
        self.db.commit()
        self.assertIsNotNone(replacement.id)

    def test_generic_empty_binder_type_change_releases_auto_owned_set_identity(self):
        self.first.auto_owned_set_id = self.set.id
        self.db.commit()

        update_binder(
            self.first.id,
            BinderUpdate(binder_type="wishlist"),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(self.first)
        self.assertEqual(self.first.binder_type, "wishlist")
        self.assertIsNone(self.first.auto_owned_set_id)

    def test_incomplete_wishlist_conversion_is_atomic(self):
        wishlist = Binder(name="Wishlist", user_id=self.user.id, binder_type="wishlist")
        self.db.add(wishlist)
        self.db.flush()
        wishlist_entry = BinderCard(
            binder_id=wishlist.id,
            card_id=self.card.id,
            required_quantity=4,
        )
        self.db.add(wishlist_entry)
        self.db.commit()
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )

        with self.assertRaises(HTTPException) as context:
            convert_wishlist_binder_to_collection(
                wishlist.id,
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("1 more unallocated", context.exception.detail)
        self.db.refresh(wishlist)
        self.db.refresh(wishlist_entry)
        self.assertEqual(wishlist.binder_type, "wishlist")
        self.assertIsNone(wishlist_entry.collection_item_id)
        self.assertEqual(wishlist_entry.required_quantity, 4)

    def test_duplicate_wishlist_rows_share_available_progress_and_merge_on_conversion(self):
        self.item.quantity = 2
        wishlist = Binder(name="Legacy wishlist", user_id=self.user.id, binder_type="wishlist")
        self.db.add(wishlist)
        self.db.flush()
        self.db.add_all([
            BinderCard(binder_id=wishlist.id, card_id=self.card.id, required_quantity=1),
            BinderCard(binder_id=wishlist.id, card_id=self.card.id, required_quantity=1),
        ])
        self.db.commit()

        detail = get_binder_cards(
            wishlist.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(detail["owned_count"], 2)
        self.assertEqual(detail["missing_count"], 0)
        self.assertEqual(sum(card["owned_quantity"] for card in detail["cards"]), 2)

        result = convert_wishlist_binder_to_collection(
            wishlist.id,
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["allocated_copies"], 2)
        rows = self.db.query(BinderCard).filter(BinderCard.binder_id == wishlist.id).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].collection_item_id, self.item.id)
        self.assertEqual(rows[0].required_quantity, 2)

    def test_duplicate_wishlist_rows_cannot_reuse_the_same_available_copies(self):
        self.item.quantity = 2
        wishlist = Binder(name="Legacy wishlist", user_id=self.user.id, binder_type="wishlist")
        self.db.add(wishlist)
        self.db.flush()
        self.db.add_all([
            BinderCard(binder_id=wishlist.id, card_id=self.card.id, required_quantity=2),
            BinderCard(binder_id=wishlist.id, card_id=self.card.id, required_quantity=2),
        ])
        self.db.commit()

        detail = get_binder_cards(
            wishlist.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(detail["owned_count"], 2)
        self.assertEqual(detail["missing_count"], 2)
        self.assertEqual(sum(card["owned_quantity"] for card in detail["cards"]), 2)

        with self.assertRaises(HTTPException) as context:
            convert_wishlist_binder_to_collection(
                wishlist.id,
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(context.exception.status_code, 409)
        self.db.refresh(wishlist)
        self.assertEqual(wishlist.binder_type, "wishlist")
        self.assertEqual(
            self.db.query(BinderCard).filter(BinderCard.binder_id == wishlist.id).count(),
            2,
        )

    def test_detail_totals_and_value_use_assigned_copies(self):
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=3, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.second.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )

        result = get_binder_cards(
            self.first.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(result["total_count"], 3)
        self.assertEqual(result["total_required_count"], 3)
        self.assertEqual(result["unique_count"], 1)
        self.assertEqual(result["owned_count"], 3)
        self.assertEqual(result["binder_value"], 30)
        self.assertEqual(result["cards"][0]["quantity"], 3)
        self.assertEqual(result["cards"][0]["collection_quantity"], 4)
        self.assertEqual(result["cards"][0]["max_assignable_quantity"], 3)

    def test_unlinked_legacy_entry_does_not_report_exact_item_capacity(self):
        self.db.add(BinderCard(
            binder_id=self.first.id,
            card_id=self.card.id,
            collection_item_id=None,
            required_quantity=2,
        ))
        self.db.commit()

        result = get_binder_cards(
            self.first.id,
            price_field="price_trend",
            current_user=self.user,
            db=self.db,
        )

        self.assertIsNone(result["cards"][0]["collection_item_id"])
        self.assertNotIn("available_quantity", result["cards"][0])
        self.assertNotIn("max_assignable_quantity", result["cards"][0])

    def test_collection_cannot_be_reduced_or_deleted_below_allocations(self):
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=3, current_user=self.user, db=self.db
        )

        with self.assertRaises(HTTPException) as update_context:
            update_collection_item(
                self.item.id,
                CollectionItemUpdate(quantity=2),
                current_user=self.user,
                db=self.db,
            )
        self.assertEqual(update_context.exception.status_code, 409)

        with self.assertRaises(HTTPException) as delete_context:
            remove_from_collection(self.item.id, current_user=self.user, db=self.db)
        self.assertEqual(delete_context.exception.status_code, 409)

    def test_database_rejects_zero_binder_quantity(self):
        self.db.add(BinderCard(
            binder_id=self.first.id,
            card_id=self.card.id,
            collection_item_id=self.item.id,
            required_quantity=0,
        ))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()

    def test_collection_csv_import_uses_quantity_and_exact_physical_metadata(self):
        upload = UploadFile(
            filename="binder.csv",
            file=io.BytesIO(
                b"set_code,number,required_quantity,lang,variant,condition\n"
                b"SV1,25,3,en,Holo,NM\n"
            ),
        )
        result = asyncio.run(import_binder_csv(
            self.first.id,
            upload,
            current_user=self.user,
            db=self.db,
        ))

        self.assertEqual(result, {
            "added": 1,
            "updated": 0,
            "skipped": 0,
            "failed": 0,
            "errors": [],
        })
        entry = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).one()
        self.assertEqual(entry.collection_item_id, self.item.id)
        self.assertEqual(entry.required_quantity, 3)

    def test_csv_header_error_lists_every_supported_format(self):
        upload = UploadFile(
            filename="binder.csv",
            file=io.BytesIO(b"set_code,number,quantity\nSV1,25,1\n"),
        )

        with self.assertRaises(HTTPException) as context:
            asyncio.run(import_binder_csv(
                self.first.id,
                upload,
                current_user=self.user,
                db=self.db,
            ))

        self.assertEqual(context.exception.status_code, 422)
        detail = context.exception.detail
        self.assertIn("set_code,number,required_quantity,lang,variant,condition,collection_item_id", detail)
        self.assertIn("set_code,number,required_quantity,lang,variant,condition", detail)
        self.assertIn("set_code,number,required_quantity,lang", detail)

    def test_collection_csv_roundtrip_preserves_identical_exact_rows(self):
        duplicate = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=2,
            condition="NM",
            variant="Holo",
            lang="en",
            purchase_price=99,
        )
        self.db.add(duplicate)
        self.db.commit()
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.first.id, duplicate.id, quantity=1, current_user=self.user, db=self.db
        )

        response = export_binder_csv(self.first.id, current_user=self.user, db=self.db)

        async def read_body():
            chunks = []
            async for chunk in response.body_iterator:
                chunks.append(chunk.encode() if isinstance(chunk, str) else chunk)
            return b"".join(chunks)

        exported = asyncio.run(read_body())
        self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).delete()
        self.db.commit()
        result = asyncio.run(import_binder_csv(
            self.second.id,
            UploadFile(filename="roundtrip.csv", file=io.BytesIO(exported)),
            current_user=self.user,
            db=self.db,
        ))

        self.assertEqual(result["added"], 2)
        allocations = {
            entry.collection_item_id: entry.required_quantity
            for entry in self.db.query(BinderCard).filter(BinderCard.binder_id == self.second.id).all()
        }
        self.assertEqual(allocations, {self.item.id: 1, duplicate.id: 1})

    def test_equivalent_print_switch_preserves_assigned_quantity(self):
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=3, current_user=self.user, db=self.db
        )
        entry = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).one()

        result = switch_binder_entry_card(
            self.first.id,
            entry.id,
            BinderCardSwitch(card_id=self.alt_card.id, collection_item_id=self.alt_item.id),
            current_user=self.user,
            db=self.db,
        )

        self.assertFalse(result["merged"])
        self.db.refresh(entry)
        self.assertEqual(entry.collection_item_id, self.alt_item.id)
        self.assertEqual(entry.required_quantity, 3)

    def test_legacy_collection_binder_entry_is_linked_without_resetting_quantity(self):
        legacy = BinderCard(
            binder_id=self.first.id,
            card_id=self.card.id,
            collection_item_id=None,
            required_quantity=2,
        )
        self.db.add(legacy)
        self.db.commit()
        original_session_local = database.SessionLocal
        database.SessionLocal = self.Session
        try:
            migrate_legacy_collection_binder_entries()
        finally:
            database.SessionLocal = original_session_local

        self.db.expire_all()
        migrated = self.db.query(BinderCard).filter(BinderCard.id == legacy.id).one()
        self.assertEqual(migrated.collection_item_id, self.item.id)
        self.assertEqual(migrated.required_quantity, 2)

    def test_optimizer_can_merge_multiple_sources_into_one_stocked_target(self):
        second_source = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=1,
            condition="LP",
            variant="Holo",
            lang="en",
        )
        self.db.add(second_source)
        self.db.commit()
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=1, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.first.id, second_source.id, quantity=1, current_user=self.user, db=self.db
        )

        result = apply_binder_print_optimization(
            self.first.id,
            current_user=self.user,
            db=self.db,
            price_field="price_trend",
        )

        self.assertEqual(result["applied"], 2)
        entries = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).all()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].collection_item_id, self.alt_item.id)
        self.assertEqual(entries[0].required_quantity, 2)

    def test_optimizer_preview_does_not_overbook_binder_row_limit(self):
        self.item.quantity = 60
        self.alt_item.quantity = 120
        second_source = CollectionItem(
            card_id=self.card.id,
            user_id=self.user.id,
            quantity=40,
            condition="LP",
            variant="Holo",
            lang="en",
        )
        self.db.add(second_source)
        self.db.commit()
        add_collection_item_to_binder(
            self.first.id, self.item.id, quantity=60, current_user=self.user, db=self.db
        )
        add_collection_item_to_binder(
            self.first.id, second_source.id, quantity=40, current_user=self.user, db=self.db
        )

        result = apply_binder_print_optimization(
            self.first.id,
            current_user=self.user,
            db=self.db,
            price_field="price_trend",
        )

        self.assertEqual(result["applied"], 1)
        entries = self.db.query(BinderCard).filter(BinderCard.binder_id == self.first.id).all()
        self.assertEqual(len(entries), 2)
        target_entry = next(entry for entry in entries if entry.collection_item_id == self.alt_item.id)
        self.assertIn(target_entry.required_quantity, {40, 60})
        self.assertLessEqual(target_entry.required_quantity, 99)
        self.assertEqual(sum(entry.required_quantity for entry in entries), 100)


if __name__ == "__main__":
    unittest.main()
