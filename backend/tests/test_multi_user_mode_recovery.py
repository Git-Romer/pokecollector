import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database
    from api.auth import (
        env_user_mode,
        get_auth_mode,
        get_current_user,
        mode_is_env_locked,
        multi_user_enabled,
        set_auth_mode,
    )
    from api.settings import update_settings
    from database import Base
    from models import User
    from services.auth import hash_password

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class MultiUserModeRecoveryTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()

        patcher = patch.object(database, "SessionLocal", self.Session)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.admin = User(
            username="admin",
            hashed_password=hash_password("known-admin-password"),
            role="admin",
            is_active=True,
        )
        self.db.add(self.admin)
        self.db.commit()
        self.db.refresh(self.admin)

    def tearDown(self):
        self.db.close()

    # --- enable is a plain flip, no password step (item 1) ---

    def test_single_user_serves_admin_without_a_token(self):
        self.assertFalse(multi_user_enabled(self.db))
        self.assertEqual(get_current_user(token=None, db=self.db).id, self.admin.id)

    def test_enable_flips_the_flag_and_then_requires_a_token(self):
        result = set_auth_mode(enabled=True, db=self.db, current_user=self.admin)
        self.assertTrue(result["multi_user"])
        self.assertTrue(get_auth_mode(db=self.db)["multi_user"])
        with self.assertRaises(HTTPException) as exc:
            get_current_user(token=None, db=self.db)
        self.assertEqual(exc.exception.status_code, 401)

    def test_enable_does_not_touch_the_admin_password(self):
        set_auth_mode(enabled=True, db=self.db, current_user=self.admin)
        self.db.refresh(self.admin)
        from services.auth import verify_password
        self.assertTrue(verify_password("known-admin-password", self.admin.hashed_password))

    def test_non_admin_cannot_change_the_mode(self):
        trainer = User(username="t", hashed_password=hash_password("x"), role="trainer", is_active=True)
        self.db.add(trainer)
        self.db.commit()
        with self.assertRaises(HTTPException) as exc:
            set_auth_mode(enabled=True, db=self.db, current_user=trainer)
        self.assertEqual(exc.exception.status_code, 403)

    # --- USER_MODE env override (item 2) ---

    def test_user_mode_single_forces_single_user_even_when_setting_is_on(self):
        set_auth_mode(enabled=True, db=self.db, current_user=self.admin)
        self.assertTrue(get_auth_mode(db=self.db)["multi_user"])

        with patch.dict("os.environ", {"USER_MODE": "single"}):
            self.assertEqual(env_user_mode(), "single")
            self.assertTrue(mode_is_env_locked())
            self.assertFalse(multi_user_enabled(self.db))
            mode = get_auth_mode(db=self.db)
            self.assertFalse(mode["multi_user"])
            self.assertTrue(mode["locked"])
            # local access is restored: an untokened request resolves to the admin again
            self.assertEqual(get_current_user(token=None, db=self.db).id, self.admin.id)

        # not sticky: unset -> stored multi-user setting is enforced again, and unlocked
        after = get_auth_mode(db=self.db)
        self.assertTrue(after["multi_user"])
        self.assertFalse(after["locked"])

    def test_user_mode_multi_forces_multi_user_even_when_setting_is_off(self):
        # stored setting is single-user (the default in setUp)
        self.assertFalse(get_auth_mode(db=self.db)["multi_user"])
        with patch.dict("os.environ", {"USER_MODE": "multi"}):
            self.assertEqual(env_user_mode(), "multi")
            self.assertTrue(multi_user_enabled(self.db))
            mode = get_auth_mode(db=self.db)
            self.assertTrue(mode["multi_user"])
            self.assertTrue(mode["locked"])
            with self.assertRaises(HTTPException):
                get_current_user(token=None, db=self.db)

    def test_set_auth_mode_is_rejected_while_env_locked(self):
        with patch.dict("os.environ", {"USER_MODE": "single"}):
            with self.assertRaises(HTTPException) as exc:
                set_auth_mode(enabled=True, db=self.db, current_user=self.admin)
            self.assertEqual(exc.exception.status_code, 409)
        # the stored setting was not changed by the rejected call
        self.assertFalse(get_auth_mode(db=self.db)["multi_user"])

    def test_single_key_settings_endpoint_cannot_change_user_mode(self):
        # api/settings.py has two writers: PUT / (update_settings) and
        # POST /{key} (set_setting). Guarding only the first leaves the rule
        # that this setting moves only through /api/auth/mode reachable around.
        from api.settings import set_setting

        with self.assertRaises(HTTPException) as exc:
            set_setting(
                "multi_user_mode",
                {"value": "true"},
                db=self.db,
                current_user=self.admin,
            )
        self.assertEqual(exc.exception.status_code, 409)
        self.assertEqual(
            exc.exception.detail,
            "Multi-user mode can only be changed through /api/auth/mode",
        )
        self.assertFalse(get_auth_mode(db=self.db)["multi_user"])

    def test_generic_settings_endpoint_cannot_change_user_mode(self):
        with self.assertRaises(HTTPException) as exc:
            update_settings(
                {"multi_user_mode": "true"},
                db=self.db,
                current_user=self.admin,
            )
        self.assertEqual(exc.exception.status_code, 409)
        self.assertFalse(get_auth_mode(db=self.db)["multi_user"])

    def test_user_mode_parsing(self):
        for val in ["single", "SINGLE", " single ", "single-user", "single_user"]:
            with patch.dict("os.environ", {"USER_MODE": val}):
                self.assertEqual(env_user_mode(), "single", val)
        for val in ["multi", "MULTI", "multi-user", "multi_user"]:
            with patch.dict("os.environ", {"USER_MODE": val}):
                self.assertEqual(env_user_mode(), "multi", val)
        for val in ["", "  ", "true", "1", "off", "nonsense"]:
            with patch.dict("os.environ", {"USER_MODE": val}):
                self.assertIsNone(env_user_mode(), val)
                self.assertFalse(mode_is_env_locked(), val)

    def test_invalid_user_mode_only_warns_when_requested(self):
        with (
            patch.dict("os.environ", {"USER_MODE": "nonsense"}),
            patch("api.auth.logger.warning") as warning,
        ):
            self.assertIsNone(env_user_mode())
            warning.assert_not_called()
            self.assertIsNone(env_user_mode(warn_invalid=True))
            warning.assert_called_once()

if __name__ == "__main__":
    unittest.main()
