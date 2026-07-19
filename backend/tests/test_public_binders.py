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


try:
    from services import public_profile as pp
    from models import BinderCard, Card, Set, UserSetting
    PP_DEPS = True
except ModuleNotFoundError:
    PP_DEPS = False


@unittest.skipUnless(PP_DEPS, "service deps unavailable")
class SerializationTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _seed(self, db, *, profile_public=True, binder_public=True, show_values=False):
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                    public_handle="ash", is_profile_public=profile_public, public_show_values=show_values)
        db.add_all([
            user,
            UserSetting(user_id=1, key="trainer_name", value="Ash K."),
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=1),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1",
                 number="1", lang="en", rarity="Common", images_small="https://img/s.webp",
                 price_trend=5.0),
        ])
        db.commit()
        binder = Binder(name="Starters", user_id=user.id, binder_type="collection", is_public=binder_public)
        db.add(binder)
        db.commit()
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-1_en", required_quantity=2))
        db.commit()
        return user, binder

    def test_get_live_profile_requires_public(self):
        db = self._db()
        self._seed(db, profile_public=False)
        self.assertIsNone(pp.get_live_profile(db, "ash"))

    def test_serialize_profile_lists_only_public_binders(self):
        db = self._db()
        user, _ = self._seed(db, binder_public=False)
        data = pp.serialize_profile(db, user)
        self.assertEqual(data["trainer_name"], "Ash K.")
        self.assertEqual(data["binders"], [])

    def test_binder_detail_hides_values_when_off(self):
        db = self._db()
        _, binder = self._seed(db, show_values=False)
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual(detail["cards"][0]["name"], "Sprigatito")
        self.assertEqual(detail["cards"][0]["quantity"], 2)
        self.assertIsNone(detail["cards"][0]["market_value"])
        self.assertIsNone(detail["total_value"])

    def test_binder_detail_shows_values_when_on(self):
        db = self._db()
        _, binder = self._seed(db, show_values=True)
        detail = pp.serialize_binder_detail(db, binder, show_values=True)
        self.assertEqual(detail["cards"][0]["market_value"], 5.0)
        self.assertEqual(detail["total_value"], 10.0)  # 5.0 * qty 2

    def test_no_private_fields_leak(self):
        db = self._db()
        _, binder = self._seed(db, show_values=True)
        detail = pp.serialize_binder_detail(db, binder, show_values=True)
        card = detail["cards"][0]
        for banned in ("purchase_price", "condition", "user_id", "username"):
            self.assertNotIn(banned, card)


try:
    from fastapi import HTTPException
    from api.public import get_public_profile, get_public_binder
    API_DEPS = True
except ModuleNotFoundError:
    API_DEPS = False


@unittest.skipUnless(API_DEPS, "api deps unavailable")
class PublicApiTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _seed(self, db, **kw):
        return SerializationTests()._seed(db, **kw)

    def test_unknown_handle_404(self):
        db = self._db()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("nobody", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_private_profile_404(self):
        db = self._db()
        self._seed(db, profile_public=False)
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_public_profile_returns_binders(self):
        db = self._db()
        self._seed(db)
        result = get_public_profile("ash", db=db)
        self.assertEqual(result["handle"], "ash")
        self.assertEqual(len(result["binders"]), 1)

    def test_private_binder_404(self):
        db = self._db()
        _, binder = self._seed(db, binder_public=False)
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", binder.id, db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_cross_owner_binder_404(self):
        db = self._db()
        self._seed(db)
        # A public binder id that belongs to a different (nonexistent) handle path
        other = Binder(name="Other", user_id=999, binder_type="collection", is_public=True)
        db.add(other)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", other.id, db=db)
        self.assertEqual(ctx.exception.status_code, 404)
