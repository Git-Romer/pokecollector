import datetime
import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    from models import User, Binder, ProductPurchase, Setting
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
    from services.public_profile import (
        HandleError,
        migrate_public_profile_handles,
        public_handle_from_trainer_name,
        validate_handle,
    )
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

    def test_trainer_name_normalizes_common_latin_diacritics(self):
        self.assertEqual(public_handle_from_trainer_name("  Gilles Romér!  "), "gilles-romer")

    def test_problematic_trainer_name_is_rejected(self):
        with self.assertRaises(HandleError):
            public_handle_from_trainer_name("🔥")

    def test_reserved_trainer_name_is_rejected(self):
        with self.assertRaises(HandleError):
            public_handle_from_trainer_name("Admin")


try:
    from services import public_profile as pp
    from models import BinderCard, Card, Set
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
        self.assertEqual(data["trainer_name"], "ash")
        self.assertEqual(data["binders"], [])

    def test_binder_detail_hides_values_when_off(self):
        db = self._db()
        _, binder = self._seed(db, show_values=False)
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual(detail["cards"][0]["name"], "Sprigatito")
        self.assertEqual(detail["cards"][0]["image"], "/api/images/card/sv1-1_en/small")
        self.assertEqual(detail["cards"][0]["quantity"], 2)
        self.assertIsNone(detail["cards"][0]["market_value"])
        self.assertIsNone(detail["total_value"])

    def test_public_card_includes_fallback_metadata_without_exposing_custom_url(self):
        db = self._db()
        _, binder = self._seed(db, show_values=False)
        card = db.query(Card).filter(Card.id == "sv1-1_en").one()
        card.data_source_lang = "fr"
        card.price_source_lang = "de"
        card.image_source_lang = "ja"
        card.images_small = None
        card.images_large = None
        card.custom_image_url = "https://private.example/manual.webp"
        db.commit()

        public_card = pp.serialize_binder_detail(db, binder, show_values=False)["cards"][0]

        self.assertEqual(public_card["data_source_lang"], "fr")
        self.assertEqual(public_card["price_source_lang"], "de")
        self.assertEqual(public_card["image_source_lang"], "ja")
        self.assertTrue(public_card["has_custom_image_fallback"])
        self.assertNotIn("custom_image_url", public_card)

    def test_public_card_proxy_url_encodes_custom_identifiers(self):
        self.assertEqual(
            pp._public_card_image_url("custom card#1"),
            "/api/images/card/custom%20card%231/small",
        )

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
        for banned in ("purchase_price", "condition", "user_id", "username", "custom_image_url"):
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
        self.assertEqual(detail["cards"][0]["lang"], "en")

    def test_serialized_card_variant_defaults_none_without_collection_item(self):
        db = self._db()
        _, binder = self._seed(db)  # seed BinderCard has no collection_item_id
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertIsNone(detail["cards"][0]["variant"])

    def test_binder_detail_orders_by_card_number_naturally(self):
        from datetime import datetime
        db = self._db()
        _, binder = self._seed(db)  # seed card is number "1", added first
        # Add cards whose numbers, sorted as strings, would interleave wrongly
        # (10 before 2), and whose add order is the reverse of number order.
        db.add_all([
            Card(id="sv1-10_en", tcg_card_id="sv1-10", name="Ten", set_id="sv1",
                 number="10", lang="en", rarity="Common", price_trend=1.0),
            Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Two", set_id="sv1",
                 number="2", lang="en", rarity="Common", price_trend=1.0),
        ])
        db.commit()
        db.query(BinderCard).filter(BinderCard.binder_id == binder.id).first().added_at = datetime(2026, 1, 1)
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-10_en", required_quantity=1, added_at=datetime(2026, 2, 1)))
        db.add(BinderCard(binder_id=binder.id, card_id="sv1-2_en", required_quantity=1, added_at=datetime(2026, 3, 1)))
        db.commit()
        detail = pp.serialize_binder_detail(db, binder, show_values=False)
        self.assertEqual([c["number"] for c in detail["cards"]], ["1", "2", "10"])


try:
    from fastapi import HTTPException
    from api.public import get_public_profile, get_public_binder, list_public_profiles
    API_DEPS = True
except ModuleNotFoundError:
    API_DEPS = False


@unittest.skipUnless(API_DEPS, "api deps unavailable")
class PublicApiTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def _seed(self, db, **kw):
        return SerializationTests()._seed(db, **kw)

    def test_unknown_handle_404(self):
        db = self._db()
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("nobody", db=db)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_feature_is_disabled_when_setting_is_missing(self):
        db = self._db(enabled=False)
        self._seed(db)
        with self.assertRaises(HTTPException) as ctx:
            get_public_profile("ash", db=db)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")

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

    def test_directory_lists_only_live_public_profiles_with_public_binder_counts(self):
        db = self._db()
        self._seed(db)
        private = User(username="misty", hashed_password="x", role="trainer", is_active=True,
                       public_handle="misty", is_profile_public=False)
        inactive = User(username="brock", hashed_password="x", role="trainer", is_active=False,
                        public_handle="brock", is_profile_public=True)
        db.add_all([private, inactive])
        db.commit()
        result = list_public_profiles(db=db)
        self.assertEqual(result, [{
            "handle": "ash",
            "trainer_name": "ash",
            "avatar_id": None,
            "binder_count": 1,
        }])

    def test_directory_excludes_public_wishlist_binders(self):
        db = self._db()
        user, _ = self._seed(db)
        db.add(Binder(name="Wishlist", user_id=user.id, binder_type="wishlist", is_public=True))
        db.commit()
        result = list_public_profiles(db=db)
        self.assertEqual(result[0]["binder_count"], 1)

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

    def test_success_sets_short_revalidating_cache(self):
        from fastapi import Response
        db = self._db()
        _, binder = self._seed(db)
        resp = Response()
        get_public_binder("ash", binder.id, db=db, response=resp)
        cc = resp.headers["Cache-Control"]
        self.assertIn("max-age=0", cc)
        self.assertIn("must-revalidate", cc)

    def test_not_found_explicitly_disables_caching(self):
        from fastapi import Response
        db = self._db()  # no seed → unknown handle
        resp = Response()
        with self.assertRaises(HTTPException) as ctx:
            get_public_binder("ash", 1, db=db, response=resp)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "no-store")


try:
    from api.profile import update_profile, get_profile
    from schemas import ProfileUpdate
    PROFILE_DEPS = True
except ModuleNotFoundError:
    PROFILE_DEPS = False


@unittest.skipUnless(PROFILE_DEPS, "profile api deps unavailable")
class ProfileControlTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

    def _user(self, db, username="ash"):
        u = User(username=username, hashed_password="x", role="trainer", is_active=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u

    def test_publish_uses_trainer_name_handle(self):
        db = self._db()
        u = self._user(db, "Ash Ketchum")
        result = update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(result["public_handle"], "ash-ketchum")
        self.assertEqual(result["trainer_name"], "Ash Ketchum")
        self.assertTrue(result["is_profile_public"])

    def test_invalid_trainer_name_422(self):
        db = self._db()
        u = self._user(db, "🔥")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 422)
        db.refresh(u)
        self.assertFalse(u.is_profile_public)
        self.assertIsNone(u.public_handle)

    def test_duplicate_derived_handle_409(self):
        db = self._db()
        taken = self._user(db, "Misty Star")
        update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=taken)
        me = self._user(db, "Misty-Star")
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=me)
        self.assertEqual(ctx.exception.status_code, 409)
        db.refresh(me)
        self.assertFalse(me.is_profile_public)
        self.assertIsNone(me.public_handle)

    def test_concurrent_unique_constraint_is_returned_as_409(self):
        from sqlalchemy.exc import IntegrityError
        from unittest.mock import patch
        db = self._db()
        u = self._user(db)
        with (
            patch.object(pp, "is_handle_available", return_value=True),
            patch.object(
                db,
                "commit",
                side_effect=IntegrityError("insert", {}, Exception("duplicate public_handle")),
            ),
            patch.object(db, "rollback") as rollback,
        ):
            with self.assertRaises(HTTPException) as ctx:
                update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 409)
        rollback.assert_called_once()

    def test_unrelated_integrity_error_is_not_mislabeled_as_handle_conflict(self):
        from sqlalchemy.exc import IntegrityError
        from unittest.mock import patch
        db = self._db()
        u = self._user(db)
        failure = IntegrityError("insert", {}, Exception("unrelated check constraint"))
        with (
            patch.object(pp, "is_handle_available", return_value=True),
            patch.object(db, "commit", side_effect=failure),
            patch.object(db, "rollback") as rollback,
        ):
            with self.assertRaises(IntegrityError):
                update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        rollback.assert_called_once()

    def test_disabling_profile_releases_stored_handle(self):
        db = self._db()
        u = self._user(db)
        update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        result = update_profile(ProfileUpdate(is_profile_public=False), db=db, current_user=u)
        db.refresh(u)
        self.assertIsNone(u.public_handle)
        self.assertEqual(result["public_handle"], "ash")
        self.assertFalse(result["is_profile_public"])

    def test_profile_controls_are_read_only_while_feature_disabled(self):
        db = self._db(enabled=False)
        u = self._user(db)
        result = get_profile(db=db, current_user=u)
        self.assertFalse(result["feature_enabled"])
        with self.assertRaises(HTTPException) as ctx:
            update_profile(ProfileUpdate(is_profile_public=True), db=db, current_user=u)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_get_profile_returns_current_user_values(self):
        db = self._db()
        u = self._user(db, "Ash K")
        update_profile(ProfileUpdate(is_profile_public=True, public_show_values=True),
                       db=db, current_user=u)
        result = get_profile(db=db, current_user=u)
        self.assertEqual(result["public_handle"], "ash-k")
        self.assertEqual(result["trainer_name"], "Ash K")
        self.assertIsNone(result["public_handle_error"])
        self.assertTrue(result["is_profile_public"])
        self.assertTrue(result["public_show_values"])

    def test_get_profile_explains_invalid_trainer_name(self):
        db = self._db()
        u = self._user(db, "🔥")
        result = get_profile(db=db, current_user=u)
        self.assertIsNone(result["public_handle"])
        self.assertIn("Trainer name", result["public_handle_error"])


@unittest.skipUnless(SERVICE_DEPS, "service deps unavailable")
class PublicHandleMigrationTests(unittest.TestCase):
    def test_migration_replaces_legacy_handles_and_disables_collisions(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        first = User(username="Ash K", hashed_password="x", role="trainer", is_active=True,
                     public_handle="custom-one", is_profile_public=True)
        collision = User(username="Ash-K", hashed_password="x", role="trainer", is_active=True,
                         public_handle="custom-two", is_profile_public=True)
        private = User(username="Misty", hashed_password="x", role="trainer", is_active=True,
                       public_handle="legacy", is_profile_public=False)
        db.add_all([first, collision, private])
        db.commit()
        result = migrate_public_profile_handles(db)
        db.refresh(first)
        db.refresh(collision)
        db.refresh(private)
        self.assertEqual(result, {"migrated": 1, "disabled": 1})
        self.assertEqual(first.public_handle, "ash-k")
        self.assertFalse(collision.is_profile_public)
        self.assertIsNone(collision.public_handle)
        self.assertIsNone(private.public_handle)

        repeat = migrate_public_profile_handles(db)
        db.refresh(first)
        self.assertEqual(repeat, {"migrated": 0, "disabled": 0})
        self.assertEqual(first.public_handle, "ash-k")


try:
    from api.binders import update_binder
    from schemas import BinderUpdate
    BINDER_DEPS = True
except ModuleNotFoundError:
    BINDER_DEPS = False


@unittest.skipUnless(BINDER_DEPS, "binder api deps unavailable")
class BinderPublicToggleTests(unittest.TestCase):
    def _db(self, enabled=True):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        if enabled:
            db.add(Setting(key="public_profiles_enabled", value="true"))
            db.commit()
        return db

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

    def test_public_toggle_is_rejected_while_feature_disabled(self):
        db = self._db(enabled=False)
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="B", user_id=user.id, binder_type="collection", is_public=True)
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(binder.id, BinderUpdate(is_public=False), db=db, current_user=user)
        self.assertEqual(ctx.exception.status_code, 403)
        db.refresh(binder)
        self.assertTrue(binder.is_public)

    def test_public_toggle_requires_a_boolean(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="B", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(binder.id, BinderUpdate(is_public=None), db=db, current_user=user)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_wishlist_binder_cannot_be_published(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="Wishlist", user_id=user.id, binder_type="wishlist")
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(binder.id, BinderUpdate(is_public=True), db=db, current_user=user)
        self.assertEqual(ctx.exception.status_code, 422)
        db.refresh(binder)
        self.assertFalse(binder.is_public)

    def test_public_collection_becomes_private_when_changed_to_wishlist(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(
            name="Collection", user_id=user.id, binder_type="collection", is_public=True
        )
        db.add(binder)
        db.commit()
        response = update_binder(
            binder.id, BinderUpdate(binder_type="wishlist"), db=db, current_user=user
        )
        self.assertEqual(response.binder_type, "wishlist")
        self.assertFalse(response.is_public)

    def test_flagged_wishlist_becomes_private_when_changed_to_collection(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(
            name="Legacy", user_id=user.id, binder_type="wishlist", is_public=True
        )
        db.add(binder)
        db.commit()
        response = update_binder(
            binder.id, BinderUpdate(binder_type="collection"), db=db, current_user=user
        )
        self.assertEqual(response.binder_type, "collection")
        self.assertFalse(response.is_public)

    def test_combined_wishlist_conversion_and_publication_is_rejected(self):
        db = self._db()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="Collection", user_id=user.id, binder_type="collection")
        db.add(binder)
        db.commit()
        with self.assertRaises(HTTPException) as ctx:
            update_binder(
                binder.id,
                BinderUpdate(binder_type="wishlist", is_public=True),
                db=db,
                current_user=user,
            )
        self.assertEqual(ctx.exception.status_code, 422)
        db.refresh(binder)
        self.assertEqual(binder.binder_type, "collection")
        self.assertFalse(binder.is_public)

    def test_unrelated_binder_edit_still_works_while_feature_disabled(self):
        db = self._db(enabled=False)
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        binder = Binder(name="Before", user_id=user.id, binder_type="collection", is_public=True)
        db.add(binder)
        db.commit()
        response = update_binder(binder.id, BinderUpdate(name="After"), db=db, current_user=user)
        self.assertEqual(response.name, "After")
        self.assertTrue(response.is_public)


try:
    from api.social import _load_user_stats
    SOCIAL_DEPS = True
except ModuleNotFoundError:
    SOCIAL_DEPS = False


@unittest.skipUnless(SOCIAL_DEPS, "social deps unavailable")
class LeaderboardHandleTests(unittest.TestCase):
    def test_stats_use_combined_portfolio_valuation(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        user = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        db.add(user)
        db.commit()
        db.add(ProductPurchase(
            product_name="Booster Box",
            product_type="Display",
            purchase_price=50,
            current_value=70,
            purchase_date=datetime.date(2026, 8, 8),
            user_id=user.id,
        ))
        db.commit()

        stats = _load_user_stats(db, user_ids=[user.id])

        self.assertEqual(stats[user.id]["total_value"], 70)
        self.assertEqual(stats[user.id]["total_invested"], 50)
        self.assertEqual(stats[user.id]["pnl"], 20)
        self.assertEqual(stats[user.id]["pnl_pct"], 40)

    def test_row_includes_public_handle(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ash", is_profile_public=True)
        db.add_all([u, Setting(key="public_profiles_enabled", value="true")])
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
        db.add_all([u, Setting(key="public_profiles_enabled", value="true")])
        db.commit()
        stats = _load_user_stats(db)
        self.assertIn(u.id, stats)
        self.assertIsNone(stats[u.id]["public_handle"])

    def test_row_hides_handle_when_feature_disabled(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        u = User(username="ash", hashed_password="x", role="trainer", is_active=True,
                 public_handle="ash", is_profile_public=True)
        db.add(u)
        db.commit()
        self.assertIsNone(_load_user_stats(db)[u.id]["public_handle"])


try:
    from api.settings import _get_user_settings, set_setting, update_settings
    SETTINGS_DEPS = True
except ModuleNotFoundError:
    SETTINGS_DEPS = False


@unittest.skipUnless(SETTINGS_DEPS, "settings api deps unavailable")
class PublicProfilesGlobalSettingTests(unittest.TestCase):
    def _db(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine)()

    def _user(self, db, username, role):
        user = User(username=username, hashed_password="x", role=role, is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def test_global_feature_defaults_disabled(self):
        db = self._db()
        admin = self._user(db, "admin-user", "admin")
        self.assertEqual(_get_user_settings(db, admin.id)["public_profiles_enabled"], "false")

    def test_admin_can_enable_global_feature(self):
        db = self._db()
        admin = self._user(db, "admin-user", "admin")
        result = set_setting(
            "public_profiles_enabled", {"value": "true"}, db=db, current_user=admin
        )
        self.assertEqual(result["value"], "true")
        self.assertEqual(_get_user_settings(db, admin.id)["public_profiles_enabled"], "true")

    def test_trainer_cannot_change_global_feature(self):
        db = self._db()
        trainer = self._user(db, "trainer-user", "trainer")
        with self.assertRaises(HTTPException) as ctx:
            set_setting(
                "public_profiles_enabled", {"value": "true"}, db=db, current_user=trainer
            )
        self.assertEqual(ctx.exception.status_code, 403)

    def test_trainer_cannot_change_global_feature_through_bulk_settings(self):
        db = self._db()
        trainer = self._user(db, "trainer-user", "trainer")
        with self.assertRaises(HTTPException) as ctx:
            update_settings(
                {"public_profiles_enabled": "true"}, db=db, current_user=trainer
            )
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(_get_user_settings(db, trainer.id)["public_profiles_enabled"], "false")
