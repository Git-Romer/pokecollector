import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    from models import User, Binder
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "SQLAlchemy not installed in this lightweight test environment")
class PublicBindersModelTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def test_new_columns_default_private(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        binder = Binder(name="Binder", binder_type="collection")
        db.add_all([user, binder])
        db.commit()
        db.refresh(user)
        db.refresh(binder)
        self.assertIsNone(user.public_handle)
        self.assertFalse(user.is_profile_public)
        self.assertFalse(user.public_show_values)
        self.assertFalse(binder.is_public)


try:
    from services.public_profile import validate_handle, HandleError
    SERVICE_DEPS = True
except ModuleNotFoundError:
    SERVICE_DEPS = False


@unittest.skipUnless(SERVICE_DEPS, "service deps unavailable")
class HandleValidationTests(unittest.TestCase):
    def test_valid_handle_is_normalized(self):
        self.assertEqual(validate_handle("  Ash-Ketchum "), "ash-ketchum")

    def test_too_short_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ab")

    def test_bad_chars_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ash_ketchum")

    def test_leading_hyphen_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("-ash")

    def test_double_hyphen_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("ash--ketchum")

    def test_reserved_rejected(self):
        with self.assertRaises(HandleError):
            validate_handle("admin")
