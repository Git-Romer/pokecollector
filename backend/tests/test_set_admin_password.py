import sys
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import User
    from scripts import set_admin_password
    from services.auth import hash_password, verify_password

    TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(TEST_DEPS_AVAILABLE, "Backend dependencies are not installed")
class SetAdminPasswordTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            db.add(
                User(
                    username="admin",
                    hashed_password=hash_password("old-password"),
                    role="trainer",
                    is_active=False,
                    must_change_password=True,
                )
            )
            db.commit()

    def run_script(self, *args):
        argv = ["set_admin_password", *args]
        with (
            patch.object(set_admin_password, "SessionLocal", self.Session),
            patch.object(sys, "argv", argv),
        ):
            return set_admin_password.main()

    def test_resets_password_and_clears_forced_change(self):
        self.assertEqual(
            self.run_script("--username", "admin", "--password", "new-password"),
            0,
        )
        with self.Session() as db:
            user = db.query(User).filter(User.username == "admin").one()
            self.assertTrue(verify_password("new-password", user.hashed_password))
            self.assertFalse(user.must_change_password)
            self.assertEqual(user.role, "trainer")
            self.assertFalse(user.is_active)

    def test_make_admin_promotes_and_activates_account(self):
        self.assertEqual(
            self.run_script(
                "--username",
                "admin",
                "--password",
                "new-password",
                "--make-admin",
            ),
            0,
        )
        with self.Session() as db:
            user = db.query(User).filter(User.username == "admin").one()
            self.assertEqual(user.role, "admin")
            self.assertTrue(user.is_active)

    def test_unknown_user_returns_error_without_modifying_accounts(self):
        self.assertEqual(
            self.run_script("--username", "missing", "--password", "new-password"),
            1,
        )
        with self.Session() as db:
            user = db.query(User).filter(User.username == "admin").one()
            self.assertTrue(verify_password("old-password", user.hashed_password))

    def test_blank_non_interactive_password_is_rejected(self):
        with self.assertRaises(SystemExit) as exc:
            self.run_script("--username", "admin", "--password", "   ")
        self.assertEqual(exc.exception.code, 2)
        with self.Session() as db:
            user = db.query(User).filter(User.username == "admin").one()
            self.assertTrue(verify_password("old-password", user.hashed_password))


if __name__ == "__main__":
    unittest.main()
