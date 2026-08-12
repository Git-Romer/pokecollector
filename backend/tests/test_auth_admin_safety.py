import unittest
import datetime
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.auth import UpdateUserRequest, change_username, delete_user, update_user
    from database import Base
    from models import Card, Trade, TradeItem, User

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class AuthAdminSafetyTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.admin = User(username="admin", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.admin)
        self.db.commit()
        self.db.refresh(self.admin)

    def tearDown(self):
        self.db.close()

    def test_cannot_deactivate_only_active_admin(self):
        with self.assertRaises(HTTPException) as exc:
            update_user(
                self.admin.id,
                UpdateUserRequest(is_active=False),
                current_user=self.admin,
                db=self.db,
            )

        self.assertEqual(exc.exception.status_code, 400)
        self.assertEqual(exc.exception.detail, "At least one active admin account is required")
        self.db.refresh(self.admin)
        self.assertTrue(self.admin.is_active)

    def test_cannot_demote_only_active_admin(self):
        with self.assertRaises(HTTPException) as exc:
            update_user(
                self.admin.id,
                UpdateUserRequest(role="trainer"),
                current_user=self.admin,
                db=self.db,
            )

        self.assertEqual(exc.exception.status_code, 400)
        self.db.refresh(self.admin)
        self.assertEqual(self.admin.role, "admin")

    def test_can_deactivate_admin_when_another_active_admin_remains(self):
        second_admin = User(username="misty", hashed_password="x", role="admin", is_active=True)
        self.db.add(second_admin)
        self.db.commit()
        self.db.refresh(second_admin)

        result = update_user(
            second_admin.id,
            UpdateUserRequest(is_active=False),
            current_user=self.admin,
            db=self.db,
        )

        self.assertFalse(result["is_active"])
        self.db.refresh(second_admin)
        self.assertFalse(second_admin.is_active)
        self.db.refresh(self.admin)
        self.assertTrue(self.admin.is_active)

    def test_can_demote_admin_when_another_active_admin_remains(self):
        second_admin = User(username="misty", hashed_password="x", role="admin", is_active=True)
        self.db.add(second_admin)
        self.db.commit()
        self.db.refresh(second_admin)

        result = update_user(
            second_admin.id,
            UpdateUserRequest(role="trainer"),
            current_user=self.admin,
            db=self.db,
        )

        self.assertEqual(result["role"], "trainer")
        self.db.refresh(second_admin)
        self.assertEqual(second_admin.role, "trainer")
        self.db.refresh(self.admin)
        self.assertEqual(self.admin.role, "admin")
        self.assertTrue(self.admin.is_active)

    def test_can_update_only_active_admin_without_removing_admin_access(self):
        result = update_user(
            self.admin.id,
            UpdateUserRequest(username="owner"),
            current_user=self.admin,
            db=self.db,
        )

        self.assertEqual(result["username"], "owner")
        self.db.refresh(self.admin)
        self.assertEqual(self.admin.username, "owner")
        self.assertEqual(self.admin.role, "admin")
        self.assertTrue(self.admin.is_active)

    def test_public_profile_url_tracks_self_service_trainer_name_change(self):
        self.admin.username = "Owner"
        self.admin.public_handle = "owner"
        self.admin.is_profile_public = True
        self.db.commit()

        result = change_username({"username": "Owner Name"}, current_user=self.admin, db=self.db)

        self.assertEqual(result["username"], "Owner Name")
        self.db.refresh(self.admin)
        self.assertEqual(self.admin.public_handle, "owner-name")

    def test_admin_user_edit_keeps_public_profile_url_in_sync(self):
        trainer = User(
            username="Misty",
            hashed_password="x",
            role="trainer",
            is_active=True,
            public_handle="misty",
            is_profile_public=True,
        )
        self.db.add(trainer)
        self.db.commit()

        update_user(
            trainer.id,
            UpdateUserRequest(username="Misty Waterflower"),
            current_user=self.admin,
            db=self.db,
        )

        self.db.refresh(trainer)
        self.assertEqual(trainer.public_handle, "misty-waterflower")

    def test_invalid_public_trainer_name_change_is_rejected(self):
        self.admin.username = "Owner"
        self.admin.public_handle = "owner"
        self.admin.is_profile_public = True
        self.db.commit()

        with self.assertRaises(HTTPException) as exc:
            change_username({"username": "🔥🔥"}, current_user=self.admin, db=self.db)

        self.assertEqual(exc.exception.status_code, 422)
        self.db.refresh(self.admin)
        self.assertEqual(self.admin.username, "Owner")
        self.assertEqual(self.admin.public_handle, "owner")

    def test_delete_user_removes_trade_history_and_owned_manual_cards(self):
        trainer = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        self.db.add(trainer)
        self.db.commit()
        self.db.refresh(trainer)
        card = Card(
            id="custom-brock-card",
            name="Brock's card",
            is_custom=True,
            custom_owner_id=trainer.id,
            lang="en",
        )
        trade = Trade(
            user_id=trainer.id,
            partner_name="Misty",
            trade_date=datetime.date(2026, 8, 10),
        )
        self.db.add_all([card, trade])
        self.db.flush()
        card_id = card.id
        self.db.add(TradeItem(
            trade_id=trade.id,
            user_id=trainer.id,
            direction="incoming",
            card_id=card.id,
            quantity=1,
            value_per_card=5,
            value_total=5,
            card_name=card.name,
        ))
        self.db.commit()

        with patch("services.scan_trace.revoke_user_traces"):
            result = delete_user(trainer.id, current_user=self.admin, db=self.db)

        self.assertEqual(result, {"message": "User deleted"})
        self.assertIsNone(self.db.query(User).filter(User.id == trainer.id).first())
        self.assertEqual(self.db.query(Trade).filter(Trade.user_id == trainer.id).count(), 0)
        self.assertEqual(self.db.query(TradeItem).filter(TradeItem.user_id == trainer.id).count(), 0)
        self.assertIsNone(self.db.query(Card).filter(Card.id == card_id).first())


if __name__ == "__main__":
    unittest.main()
