import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Setting, User, UserSetting
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False

# Imported outside the guard above: that guard exists to skip these tests where
# SQLAlchemy is absent, and must not also swallow a genuinely missing module.
if API_TEST_DEPS_AVAILABLE:
    from services.display_language import get_display_language


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class DisplayLanguageTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.ash = User(username="ash", hashed_password="x", role="admin", is_active=True)
        self.misty = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([self.ash, self.misty])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_prefers_the_users_own_language_over_the_global_setting(self):
        self.db.add(Setting(key="language", value="de"))
        self.db.add(UserSetting(user_id=self.ash.id, key="language", value="en"))
        self.db.commit()

        self.assertEqual(get_display_language(self.db, self.ash.id), "en")

    def test_each_user_resolves_their_own_language_independently(self):
        self.db.add(Setting(key="language", value="de"))
        self.db.add(UserSetting(user_id=self.ash.id, key="language", value="en"))
        self.db.add(UserSetting(user_id=self.misty.id, key="language", value="fr"))
        self.db.commit()

        self.assertEqual(get_display_language(self.db, self.ash.id), "en")
        self.assertEqual(get_display_language(self.db, self.misty.id), "fr")

    def test_falls_back_to_the_global_setting_when_the_user_has_no_override(self):
        self.db.add(Setting(key="language", value="fr"))
        self.db.commit()

        self.assertEqual(get_display_language(self.db, self.misty.id), "fr")

    def test_falls_back_to_the_default_when_neither_is_set(self):
        self.assertEqual(get_display_language(self.db, self.ash.id), "en")

    def test_falls_back_to_the_global_setting_when_no_user_is_given(self):
        self.db.add(Setting(key="language", value="de"))
        self.db.commit()

        self.assertEqual(get_display_language(self.db, None), "de")


if __name__ == "__main__":
    unittest.main()
