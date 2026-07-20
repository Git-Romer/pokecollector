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

    def test_serialized_card_includes_variant(self):
        from models import CollectionItem
        db = self._db()
        _, binder = self._seed(db)
        # Link the binder card to a collection item carrying a variant.
        item = CollectionItem(card_id="sv1-1_en", user_id=1, quantity=2,
                              variant="Reverse Holo", condition="NM")
        db.add(item)
        db.commit()
        bc = db.query(BinderCard).filter(BinderCard.binder_id == binder.id).first()
        bc.collection_item_id = item.id
        db.commit()
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual(detail["cards"][0]["variant"], "Reverse Holo")

    def test_serialized_card_variant_defaults_none_without_collection_item(self):
        db = self._db()
        _, binder = self._seed(db)  # seed BinderCard has no collection_item_id
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertIsNone(detail["cards"][0]["variant"])

    def test_binder_detail_orders_by_added_at_desc(self):
        from datetime import datetime, timedelta
        db = self._db()
        _, binder = self._seed(db)
        db.add(Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1",
                    number="2", lang="en", rarity="Common", price_trend=6.0))
        db.commit()
        # Existing seed card was added first; add a newer card explicitly.
        old = db.query(BinderCard).filter(BinderCard.binder_id == binder.id).first()
        old.added_at = datetime(2026, 1, 1)
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-2_en", required_quantity=1,
                          added_at=datetime(2026, 6, 1)))
        db.commit()
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        names = [c["name"] for c in detail["cards"]]
        self.assertEqual(names, ["Floragato", "Sprigatito"])  # newest first


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


try:
    from api.profile import update_profile, handle_available, get_profile
    from schemas import ProfileUpdate
    PROFILE_DEPS = True
except ModuleNotFoundError:
    PROFILE_DEPS = False


@unittest.skipUnless(PROFILE_DEPS, "profile api deps unavailable")
class ProfileControlTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _user(self, db, username="ash"):
        u = User(username=username, hashed_password="x", role="trainer", is_active=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u

    def test_set_handle_and_publish(self):
        db = self._db()
        u = self._user(db)
        result = update_profile(ProfileUpdate(public_handle="Ash-K", is_profile_public=True),
                                db=db, current_user=u)
        self.assertEqual(result["public_handle"], "ash-k")
        self.assertTrue(result["is_profile_public"])

    def test_invalid_handle_422(self):
        db = self._db()
        u = self._user(db)
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(public_handle="a"), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_duplicate_handle_409(self):
        db = self._db()
        taken = self._user(db, "misty")
        update_profile(ProfileUpdate(public_handle="star"), db=db, current_user=taken)
        me = self._user(db, "ash")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(public_handle="star"), db=db, current_user=me)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_handle_available_check(self):
        db = self._db()
        u = self._user(db)
        self.assertTrue(handle_available("brand-new", db=db, current_user=u)["available"])
        self.assertFalse(handle_available("ADMIN", db=db, current_user=u)["available"])

    def test_get_profile_returns_current_user_values(self):
        db = self._db()
        u = self._user(db)
        update_profile(ProfileUpdate(public_handle="Ash-K", is_profile_public=True, public_show_values=True),
                       db=db, current_user=u)
        result = get_profile(current_user=u)
        self.assertEqual(result["public_handle"], "ash-k")
        self.assertTrue(result["is_profile_public"])
        self.assertTrue(result["public_show_values"])


try:
    from api.binders import update_binder
    from schemas import BinderUpdate
    BINDER_DEPS = True
except ModuleNotFoundError:
    BINDER_DEPS = False


@unittest.skipUnless(BINDER_DEPS, "binder api deps unavailable")
class BinderPublicToggleTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def test_update_binder_sets_is_public(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        binder = Binder(name="B", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        resp = update_binder(binder.id, BinderUpdate(is_public=True), db=db, current_user=user)
        self.assertTrue(resp.is_public)


try:
    from api.social import _load_user_stats
    SOCIAL_DEPS = True
except ModuleNotFoundError:
    SOCIAL_DEPS = False


@unittest.skipUnless(SOCIAL_DEPS, "social deps unavailable")
class LeaderboardHandleTests(unittest.TestCase):
    def test_row_includes_public_handle(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ash", is_profile_public=True)
        db.add(u)
        db.commit()
        stats = _load_user_stats(db)
        self.assertIn(u.id, stats)
        self.assertEqual(stats[u.id]["public_handle"], "ash")

    def test_row_hides_handle_when_profile_not_public(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ghost", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ghost", is_profile_public=False)
        db.add(u)
        db.commit()
        stats = _load_user_stats(db)
        self.assertIn(u.id, stats)
        self.assertIsNone(stats[u.id]["public_handle"])
