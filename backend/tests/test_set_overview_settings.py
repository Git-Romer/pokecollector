import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.settings import _get_user_settings, update_settings
    from api.sets import MarkSetsSeenRequest, mark_sets_seen
    from database import Base
    from models import Set, Setting, User, UserSetting

    SETTINGS_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    SETTINGS_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(SETTINGS_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class SetOverviewSettingsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([self.user, self.other_user])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def test_set_overview_settings_have_safe_defaults(self):
        settings = _get_user_settings(self.db, self.user.id)

        self.assertEqual(settings["set_overview_filters"], "{}")
        self.assertEqual(settings["hidden_set_ids"], "[]")

    def test_set_overview_settings_are_per_user(self):
        update_settings({
            "set_overview_filters": '{"search":"charizard","sortBy":"name"}',
            "hidden_set_ids": '["sv1_en","sv2_de"]',
        }, db=self.db, current_user=self.user)

        user_settings = _get_user_settings(self.db, self.user.id)
        other_settings = _get_user_settings(self.db, self.other_user.id)

        self.assertEqual(user_settings["set_overview_filters"], '{"search":"charizard","sortBy":"name"}')
        self.assertEqual(user_settings["hidden_set_ids"], '["sv1_en","sv2_de"]')
        self.assertEqual(other_settings["set_overview_filters"], "{}")
        self.assertEqual(other_settings["hidden_set_ids"], "[]")
        self.assertEqual(self.db.query(Setting).filter(Setting.key == "hidden_set_ids").count(), 0)
        self.assertEqual(self.db.query(UserSetting).filter(UserSetting.key == "hidden_set_ids").count(), 1)

    def test_mark_sets_seen_can_target_visible_set_ids(self):
        self.db.add_all([
            Set(id="sv1_en", tcg_set_id="sv1", name="Visible", is_new=True, lang="en"),
            Set(id="sv2_en", tcg_set_id="sv2", name="Hidden", is_new=True, lang="en"),
        ])
        self.db.commit()

        mark_sets_seen(MarkSetsSeenRequest(set_ids=["sv1_en"]), db=self.db, current_user=self.user)

        self.assertFalse(self.db.query(Set).filter(Set.id == "sv1_en").one().is_new)
        self.assertTrue(self.db.query(Set).filter(Set.id == "sv2_en").one().is_new)

    def test_mark_sets_seen_without_body_keeps_existing_mark_all_behavior(self):
        self.db.add_all([
            Set(id="sv1_en", tcg_set_id="sv1", name="One", is_new=True, lang="en"),
            Set(id="sv2_en", tcg_set_id="sv2", name="Two", is_new=True, lang="en"),
        ])
        self.db.commit()

        mark_sets_seen(db=self.db, current_user=self.user)

        self.assertEqual(self.db.query(Set).filter(Set.is_new == True).count(), 0)


if __name__ == "__main__":
    unittest.main()
