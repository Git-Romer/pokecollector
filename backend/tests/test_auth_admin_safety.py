import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.auth import UpdateUserRequest, update_user
    from database import Base
    from models import User

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


if __name__ == "__main__":
    unittest.main()
