import datetime
import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database
    from api.analytics import get_duplicates, get_top_movers
    from api.cards import (
        clone_custom_card,
        create_custom_card,
        delete_custom_card,
        dismiss_custom_match,
        list_custom_cards,
        migrate_custom_card,
        update_custom_card,
    )
    from api.collection import add_to_collection
    from api.collection import get_user_collection
    from api.dashboard import get_dashboard
    from database import Base, migrate_custom_card_ownership
    from models import (
        Binder,
        BinderCard,
        Card,
        CollectionItem,
        CustomCardMatch,
        ImageCache,
        PriceHistory,
        Setting,
        User,
        WishlistItem,
    )
    from schemas import CardCustomCreate, CollectionItemCreate, CustomCardUpdate
    from services.sync_service import check_custom_card_matches

    TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed")
class CustomCardOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.owner = User(username="owner", hashed_password="x", role="trainer", is_active=True)
        self.other = User(username="other", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.owner,
            self.other,
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Setting(key="tcgdex_digital_sets_enabled", value="false"),
        ])
        self.db.commit()
        self.db.refresh(self.owner)
        self.db.refresh(self.other)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def _create(self, user=None, shared=False, name="Manual Pikachu"):
        return create_custom_card(
            CardCustomCreate(
                name=name,
                number="25",
                image_url="https://8.8.8.8/pikachu.jpg",
                is_shared_template=shared,
            ),
            db=self.db,
            current_user=user or self.owner,
        )

    def test_private_cards_are_owner_only_and_ids_are_collision_safe(self):
        first = self._create()
        second = self._create()

        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["custom_owner_id"], self.owner.id)
        self.assertTrue(first["is_custom_owner"])
        self.assertFalse(first["is_shared_template"])
        self.assertEqual(
            {card["id"] for card in list_custom_cards(db=self.db, current_user=self.owner)},
            {first["id"], second["id"]},
        )
        self.assertEqual(list_custom_cards(db=self.db, current_user=self.other), [])

    def test_shared_template_must_be_cloned_and_clone_is_independent(self):
        source = self._create(shared=True)

        visible_to_other = list_custom_cards(db=self.db, current_user=self.other)
        self.assertEqual([card["id"] for card in visible_to_other], [source["id"]])
        self.assertFalse(visible_to_other[0]["is_custom_owner"])

        with self.assertRaises(HTTPException) as add_error:
            add_to_collection(
                CollectionItemCreate(card_id=source["id"], quantity=1, lang="en"),
                current_user=self.other,
                db=self.db,
            )
        self.assertEqual(add_error.exception.status_code, 409)

        clone = clone_custom_card(source["id"], db=self.db, current_user=self.other)
        self.assertNotEqual(clone["id"], source["id"])
        self.assertEqual(clone["custom_owner_id"], self.other.id)
        self.assertFalse(clone["is_shared_template"])

        add_to_collection(
            CollectionItemCreate(card_id=clone["id"], quantity=1, lang="en"),
            current_user=self.other,
            db=self.db,
        )
        update_custom_card(
            clone["id"],
            CustomCardUpdate(name="Independent Raichu"),
            db=self.db,
            current_user=self.other,
        )
        self.assertEqual(self.db.query(Card).filter(Card.id == source["id"]).one().name, "Manual Pikachu")

        delete_custom_card(source["id"], db=self.db, current_user=self.owner)
        self.assertIsNotNone(self.db.query(Card).filter(Card.id == clone["id"]).first())
        self.assertIsNotNone(
            self.db.query(CollectionItem).filter(
                CollectionItem.user_id == self.other.id,
                CollectionItem.card_id == clone["id"],
            ).first()
        )

    def test_only_owner_can_edit_or_delete(self):
        source = self._create(shared=True)

        with self.assertRaises(HTTPException) as edit_error:
            update_custom_card(
                source["id"],
                CustomCardUpdate(name="Hijacked"),
                db=self.db,
                current_user=self.other,
            )
        self.assertEqual(edit_error.exception.status_code, 403)

        with self.assertRaises(HTTPException) as delete_error:
            delete_custom_card(source["id"], db=self.db, current_user=self.other)
        self.assertEqual(delete_error.exception.status_code, 403)

    def test_foreign_match_status_is_not_disclosed(self):
        source = self._create(shared=True)
        match = CustomCardMatch(
            custom_card_id=source["id"],
            api_card_id="base1-25",
            status="dismissed",
        )
        self.db.add(match)
        self.db.commit()
        self.db.refresh(match)

        with self.assertRaises(HTTPException) as dismiss_error:
            dismiss_custom_match(match.id, db=self.db, current_user=self.other)
        self.assertEqual(dismiss_error.exception.status_code, 404)

        with self.assertRaises(HTTPException) as migrate_error:
            migrate_custom_card(match.id, db=self.db, current_user=self.other)
        self.assertEqual(migrate_error.exception.status_code, 404)

    def test_manual_image_urls_reject_private_network_targets(self):
        with self.assertRaises(HTTPException) as create_error:
            create_custom_card(
                CardCustomCreate(
                    name="Private endpoint",
                    image_url="http://127.0.0.1:8000/secret",
                ),
                db=self.db,
                current_user=self.owner,
            )
        self.assertEqual(create_error.exception.status_code, 422)

        card = self._create()
        with self.assertRaises(HTTPException) as update_error:
            update_custom_card(
                card["id"],
                CustomCardUpdate(image_url="http://192.168.1.2/card.jpg"),
                db=self.db,
                current_user=self.owner,
            )
        self.assertEqual(update_error.exception.status_code, 422)

        self.db.add(ImageCache(
            image_key=f"card:{card['id']}:small:manual:stale",
            data=b"old",
            content_type="image/jpeg",
        ))
        self.db.commit()
        update_custom_card(
            card["id"],
            CustomCardUpdate(image_url="https://1.1.1.1/new-card.jpg"),
            db=self.db,
            current_user=self.owner,
        )
        self.assertEqual(
            self.db.query(ImageCache).filter(
                ImageCache.image_key.like(f"card:{card['id']}:%")
            ).count(),
            0,
        )

    def test_private_manual_cards_are_excluded_from_another_users_collection_view(self):
        private_card = self._create()
        add_to_collection(
            CollectionItemCreate(card_id=private_card["id"], quantity=1, lang="en"),
            current_user=self.owner,
            db=self.db,
        )

        visible = get_user_collection(
            self.owner.id,
            current_user=self.other,
            db=self.db,
        )
        self.assertEqual(visible, [])

    def test_dashboard_marks_manual_cards_for_homepage_badges(self):
        private_card = self._create()
        add_to_collection(
            CollectionItemCreate(card_id=private_card["id"], quantity=1, lang="en"),
            current_user=self.owner,
            db=self.db,
        )

        dashboard = get_dashboard(
            db=self.db,
            price_field="price_trend",
            current_user=self.owner,
        )

        self.assertTrue(dashboard["top_cards"][0]["is_custom"])
        self.assertTrue(dashboard["recent_additions"][0]["is_custom"])

    def test_analytics_payloads_mark_manual_cards(self):
        private_card = self._create()
        item = add_to_collection(
            CollectionItemCreate(card_id=private_card["id"], quantity=2, lang="en"),
            current_user=self.owner,
            db=self.db,
        )
        card = self.db.query(Card).filter(Card.id == private_card["id"]).one()
        card.price_trend = 12
        self.db.add(PriceHistory(
            card_id=card.id,
            date=datetime.date.today() - datetime.timedelta(days=1),
            price_trend=10,
        ))
        self.db.commit()

        duplicates = get_duplicates(
            price_field="price_trend",
            db=self.db,
            current_user=self.owner,
        )
        movers = get_top_movers(
            days=7,
            price_field="price_trend",
            sort_by="percentage",
            db=self.db,
            current_user=self.owner,
        )

        self.assertTrue(duplicates[0]["is_custom"])
        self.assertTrue(movers[0]["is_custom"])

    def test_match_notifications_use_the_manual_card_owners_telegram_settings(self):
        create_custom_card(
            CardCustomCreate(
                name="Owner-only match",
                set_id="base1",
                number="25",
                image_url="https://8.8.8.8/card.jpg",
            ),
            db=self.db,
            current_user=self.owner,
        )

        with patch(
            "services.sync_service.pokemon_api.get_card",
            return_value={"id": "base1-25"},
        ), patch("services.sync_service.telegram.send_message", return_value=True) as send_message:
            check_custom_card_matches(self.db)

        send_message.assert_called_once()
        self.assertEqual(send_message.call_args.kwargs["user_id"], self.owner.id)


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed")
class CustomCardOwnershipMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        self.first_admin = User(username="first", hashed_password="x", role="admin", is_active=True)
        self.second_admin = User(username="second", hashed_password="x", role="admin", is_active=True)
        self.trainer = User(username="trainer", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([self.first_admin, self.second_admin, self.trainer])
        self.db.commit()
        for user in (self.first_admin, self.second_admin, self.trainer):
            self.db.refresh(user)
        self.first_admin_id = self.first_admin.id
        self.second_admin_id = self.second_admin.id
        self.trainer_id = self.trainer.id

        self.card = Card(
            id="custom-legacy",
            name="Legacy manual card",
            number="1",
            is_custom=True,
            custom_owner_id=None,
            is_shared_template=False,
            lang="en",
        )
        binder = Binder(name="Trainer binder", user_id=self.trainer.id, binder_type="wishlist")
        self.db.add_all([self.card, binder])
        self.db.flush()
        self.db.add_all([
            CollectionItem(
                card_id=self.card.id,
                user_id=self.first_admin.id,
                quantity=1,
                condition="NM",
                variant="Normal",
                lang="en",
                added_at=datetime.datetime.utcnow(),
            ),
            CollectionItem(
                card_id=self.card.id,
                user_id=self.second_admin.id,
                quantity=1,
                condition="NM",
                variant="Normal",
                lang="en",
                added_at=datetime.datetime.utcnow(),
            ),
            WishlistItem(
                card_id=self.card.id,
                user_id=self.trainer.id,
                quantity=1,
                created_at=datetime.datetime.utcnow(),
            ),
            BinderCard(binder_id=binder.id, card_id=self.card.id, required_quantity=1),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_legacy_card_goes_to_first_admin_and_other_users_receive_private_clones(self):
        self.db.close()
        with patch.object(database, "SessionLocal", self.Session):
            migrate_custom_card_ownership()
            migrate_custom_card_ownership()

        self.db = self.Session()
        original = self.db.query(Card).filter(Card.id == "custom-legacy").one()
        self.assertEqual(original.custom_owner_id, self.first_admin_id)
        self.assertTrue(original.is_shared_template)

        clones = self.db.query(Card).filter(
            Card.custom_source_card_id == original.id
        ).order_by(Card.custom_owner_id.asc()).all()
        self.assertEqual(
            [clone.custom_owner_id for clone in clones],
            [self.second_admin_id, self.trainer_id],
        )
        self.assertTrue(all(not clone.is_shared_template for clone in clones))

        second_admin_item = self.db.query(CollectionItem).filter(
            CollectionItem.user_id == self.second_admin_id
        ).one()
        trainer_wishlist = self.db.query(WishlistItem).filter(
            WishlistItem.user_id == self.trainer_id
        ).one()
        trainer_binder_card = self.db.query(BinderCard).join(Binder).filter(
            Binder.user_id == self.trainer_id
        ).one()
        self.assertEqual(second_admin_item.card_id, clones[0].id)
        self.assertEqual(trainer_wishlist.card_id, clones[1].id)
        self.assertEqual(trainer_binder_card.card_id, clones[1].id)


if __name__ == "__main__":
    unittest.main()
