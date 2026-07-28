import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.analytics import get_duplicates, get_rarity_stats
from api.auth import delete_user
from api.collection import add_to_collection, get_collection_stats, remove_from_collection
from api.dashboard import get_dashboard
from api.sets import get_set_checklist
from database import Base
from models import Card, CollectionItem, InventoryEvent, Set, StorageLocation, User
from schemas import CollectionItemCreate, CollectionItemRemovalRequest


class InventoryLifecycleTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="john", hashed_password="x", role="admin", is_active=True)
        self.set = Set(
            id="sv1_en",
            tcg_set_id="sv1",
            name="Test Set",
            lang="en",
            total=2,
        )
        self.card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Test Card",
            set_id="sv1",
            number="1",
            lang="en",
        )
        self.bulk_card = Card(
            id="sv1-2_en",
            tcg_card_id="sv1-2",
            name="Bulk Test Card",
            set_id="sv1",
            number="2",
            lang="en",
        )
        self.db.add_all([self.user, self.set, self.card, self.bulk_card])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_new_item_uses_required_to_organize_location_and_records_history(self):
        item = add_to_collection(
            CollectionItemCreate(
                card_id=self.card.id,
                acquisition_source="pulled",
                protection_type="penny_sleeve",
            ),
            current_user=self.user,
            db=self.db,
        )

        location = self.db.query(StorageLocation).filter_by(
            user_id=self.user.id,
            name="To organize",
        ).one()
        self.assertEqual(item.storage_location_id, location.id)
        self.assertEqual(item.storage_location.name, "To organize")
        self.assertEqual(item.purchase_price, 4.49)
        self.assertEqual(item.protection_type, "penny_sleeve")
        self.assertEqual(item.inventory_kind, "owned")
        self.assertEqual(item.status, "owned")

        event = self.db.query(InventoryEvent).filter_by(
            user_id=self.user.id,
            entity_type="collection_item",
            entity_id=item.id,
            action="added",
        ).one()
        self.assertEqual(event.entity_uid, item.record_uid)

    def test_bulk_item_is_separate_and_has_no_per_card_cost_basis(self):
        item = add_to_collection(
            CollectionItemCreate(
                card_id=self.card.id,
                acquisition_source="bulk_before_tracking",
                inventory_kind="bulk",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.inventory_kind, "bulk")
        self.assertIsNone(item.purchase_price)

    def test_duplicate_intake_updates_quantity_without_discarding_new_note(self):
        first = add_to_collection(
            CollectionItemCreate(card_id=self.card.id, notes="First copy"),
            current_user=self.user,
            db=self.db,
        )
        second = add_to_collection(
            CollectionItemCreate(card_id=self.card.id, quantity=2, notes="Filed together"),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(second.quantity, 3)
        self.assertEqual(second.notes, "Filed together")
        event = self.db.query(InventoryEvent).filter_by(
            entity_type="collection_item",
            entity_id=first.id,
            action="quantity_increased",
        ).one()
        self.assertEqual(event.changes["notes"]["after"], "Filed together")

    def test_remove_is_soft_and_preserves_history(self):
        item = add_to_collection(
            CollectionItemCreate(card_id=self.card.id),
            current_user=self.user,
            db=self.db,
        )

        result = remove_from_collection(
            item.id,
            removal=CollectionItemRemovalRequest(reason="gifted", notes="Birthday gift"),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["status"], "removed")
        stored = self.db.query(CollectionItem).filter_by(id=item.id).one()
        self.assertEqual(stored.status, "removed")
        self.assertEqual(stored.removal_reason, "gifted")
        self.assertIsNotNone(stored.removed_at)
        self.assertEqual(
            self.db.query(InventoryEvent).filter_by(
                entity_type="collection_item",
                entity_id=item.id,
                action="removed",
            ).count(),
            1,
        )

    def test_collection_intelligence_only_counts_active_owned_cards(self):
        owned = add_to_collection(
            CollectionItemCreate(card_id=self.card.id, quantity=2),
            current_user=self.user,
            db=self.db,
        )
        add_to_collection(
            CollectionItemCreate(
                card_id=self.bulk_card.id,
                quantity=5,
                acquisition_source="bulk_before_tracking",
                inventory_kind="bulk",
            ),
            current_user=self.user,
            db=self.db,
        )
        removed = add_to_collection(
            CollectionItemCreate(card_id=self.card.id, quantity=7, condition="LP"),
            current_user=self.user,
            db=self.db,
        )
        remove_from_collection(
            removed.id,
            removal=CollectionItemRemovalRequest(reason="gifted"),
            current_user=self.user,
            db=self.db,
        )

        dashboard = get_dashboard(
            db=self.db,
            price_field="price_trend",
            current_user=self.user,
        )
        duplicates = get_duplicates(
            db=self.db,
            price_field="price_trend",
            current_user=self.user,
        )
        rarity = get_rarity_stats(
            db=self.db,
            price_field="price_trend",
            current_user=self.user,
        )
        checklist = get_set_checklist(
            "sv1_en",
            db=self.db,
            current_user=self.user,
        )
        collection_stats = get_collection_stats(
            db=self.db,
            price_field="price_trend",
            current_user=self.user,
        )

        self.assertEqual(dashboard["total_cards"], 2)
        self.assertEqual(dashboard["unique_cards"], 1)
        self.assertEqual(collection_stats["total_cards"], 2)
        self.assertEqual(collection_stats["unique_cards"], 1)
        self.assertEqual([item["id"] for item in duplicates], [owned.id])
        self.assertEqual(sum(item["count"] for item in rarity), 2)
        self.assertEqual(checklist["owned_count"], 1)
        bulk_result = next(item for item in checklist["cards"] if item["id"] == self.bulk_card.id)
        self.assertFalse(bulk_result["owned"])

    def test_legacy_holofoil_variant_is_normalized_on_intake(self):
        item = add_to_collection(
            CollectionItemCreate(card_id=self.card.id, quantity=1, variant="Holofoil"),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.variant, "Holo")

    def test_user_deletion_removes_inventory_history_and_storage(self):
        target = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add(target)
        self.db.flush()
        location = StorageLocation(
            user_id=target.id,
            name="To organize",
            is_default=True,
        )
        self.db.add(location)
        self.db.flush()
        self.db.add(InventoryEvent(
            user_id=target.id,
            entity_type="storage_location",
            entity_id=location.id,
            entity_uid=location.record_uid,
            action="added",
            changes={},
        ))
        self.db.commit()

        result = delete_user(
            target.id,
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(result["message"], "User deleted")
        self.assertIsNone(self.db.get(User, target.id))
        self.assertEqual(self.db.query(StorageLocation).filter_by(user_id=target.id).count(), 0)
        self.assertEqual(self.db.query(InventoryEvent).filter_by(user_id=target.id).count(), 0)


if __name__ == "__main__":
    unittest.main()
