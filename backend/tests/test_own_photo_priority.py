"""The owner's own photo should surface everywhere an owned collection item's
picture is shown, not just on the Collection page itself.

A user reported the Binders "Add from collection" picker showing card backs
for cards it actually had photos for. That traced to several endpoints never
attaching has_scan_photo / a nested card object the way /api/collection/
already does (see api/collection._annotate_scan_photos) — so the frontend had
nothing to prefer the photo over the missing catalogue scan with.

These tests cover each endpoint that got the same treatment: binders (the
card list, print-optimization preview, and equivalent-prints), the dashboard's
top-valuable-cards strip, and the analytics duplicates list. Each check is the
same shape: attach a CollectionCardPhoto, call the endpoint function directly,
assert has_scan_photo is true and a nested card is present — then assert it is
false for an item with no photo, so a permanently-true flag can't hide here.
"""

import io
import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from PIL import Image

    from api.analytics import get_duplicates
    from api.binders import (
        get_binder_cards,
        preview_binder_print_optimization,
        get_binder_entry_equivalent_prints,
    )
    from api.dashboard import get_dashboard
    from database import Base
    from models import Binder, BinderCard, Card, CollectionCardPhoto, CollectionItem, Set, User
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (24, 34), (200, 30, 30)).save(buf, format="JPEG")
    return buf.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy/Pillow are not installed in this lightweight test environment")
class OwnPhotoPriorityTests(unittest.TestCase):
    """Shared fixture: one user, two cards with no catalogue image (so the
    reported bug — card backs shown despite an own photo — is reproduced
    rather than masked by a catalogue image also being available), one owned
    with a photo and one owned without."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()

        self.user = User(username="ivy", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.user)
        self.db.add(Set(id="pmcg2_ja", tcg_set_id="pmcg2", name="Pokemon Jungle", lang="ja"))
        # No images_small/images_large — matches the reported screenshot,
        # where every affected tile was a card with no catalogue scan.
        self.photographed_card = Card(
            id="pmcg2-035_ja", tcg_card_id="pmcg2-035", name="プリン",
            set_id="pmcg2", number="035", lang="ja",
        )
        self.bare_card = Card(
            id="pmcg2-036_ja", tcg_card_id="pmcg2-036", name="Nidoran",
            set_id="pmcg2", number="036", lang="ja",
        )
        self.db.add_all([self.photographed_card, self.bare_card])
        self.db.commit()
        self.db.refresh(self.user)

        self.photographed_item = CollectionItem(
            card_id=self.photographed_card.id, user_id=self.user.id, quantity=1, lang="ja",
        )
        self.bare_item = CollectionItem(
            card_id=self.bare_card.id, user_id=self.user.id, quantity=1, lang="ja",
        )
        self.db.add_all([self.photographed_item, self.bare_item])
        self.db.commit()
        self.db.refresh(self.photographed_item)
        self.db.refresh(self.bare_item)

        self.db.add(CollectionCardPhoto(
            user_id=self.user.id,
            card_id=self.photographed_card.id,
            data=_jpeg_bytes(),
            content_type="image/jpeg",
        ))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _by_collection_item_id(self, rows, collection_item_id, key="collection_item_id"):
        matches = [r for r in rows if r.get(key) == collection_item_id]
        self.assertEqual(len(matches), 1, f"expected exactly one row with {key}={collection_item_id}, got {matches}")
        return matches[0]

    # ── binders: get_binder_cards ────────────────────────────────────────

    def test_binder_card_list_flags_the_photographed_item(self):
        binder = Binder(name="Ivy's", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        self.db.add_all([
            BinderCard(binder_id=binder.id, card_id=self.photographed_card.id, collection_item_id=self.photographed_item.id),
            BinderCard(binder_id=binder.id, card_id=self.bare_card.id, collection_item_id=self.bare_item.id),
        ])
        self.db.commit()

        result = get_binder_cards(binder.id, price_field="price_trend", current_user=self.user, db=self.db)
        cards = result["cards"]

        photographed = self._by_collection_item_id(cards, self.photographed_item.id)
        bare = self._by_collection_item_id(cards, self.bare_item.id)
        self.assertTrue(photographed["has_scan_photo"])
        self.assertEqual(photographed["card"]["id"], self.photographed_card.id)
        self.assertFalse(bare["has_scan_photo"])
        self.assertEqual(bare["card"]["id"], self.bare_card.id)

    def test_wishlist_binder_unowned_row_is_not_flagged(self):
        """A wishlist binder can list cards nobody owns yet — has_scan_photo
        must default false rather than error when there is no collection_item
        to check at all."""
        other_card = Card(id="pmcg2-037_ja", tcg_card_id="pmcg2-037", name="Rattata", set_id="pmcg2", number="037", lang="ja")
        self.db.add(other_card)
        binder = Binder(name="Wanted", user_id=self.user.id, binder_type="wishlist")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        self.db.add(BinderCard(binder_id=binder.id, card_id=other_card.id, required_quantity=1))
        self.db.commit()

        result = get_binder_cards(binder.id, price_field="price_trend", current_user=self.user, db=self.db)
        row = self._by_collection_item_id(result["cards"], None)
        self.assertFalse(row["has_scan_photo"])
        self.assertEqual(row["card"]["id"], other_card.id)

    # ── binders: print-optimization preview ──────────────────────────────

    def test_print_optimization_preview_flags_the_current_card(self):
        """The 'current' side of a suggested swap is always the card actually
        in the binder — if it has a photo, the preview should say so.

        A candidate has to be a *different print of the same card the user
        also owns* — _collection_optimizer_candidates matches on name and
        fingerprint and only looks at the user's own CollectionItem rows, not
        the catalogue at large.
        """
        cheaper_print = Card(
            id="pmcg2-035_ja_reprint", tcg_card_id="pmcg2-035-reprint", name="プリン",
            set_id="pmcg2", number="035b", lang="ja",
            playable_fingerprint="jigglypuff-035",
            price_trend=0.01,
        )
        self.photographed_card.playable_fingerprint = "jigglypuff-035"
        self.photographed_card.price_trend = 5.0
        self.db.add(cheaper_print)
        self.db.commit()
        cheaper_item = CollectionItem(card_id=cheaper_print.id, user_id=self.user.id, quantity=1, lang="ja")
        self.db.add(cheaper_item)
        self.db.commit()

        binder = Binder(name="Ivy's", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        self.db.add(BinderCard(binder_id=binder.id, card_id=self.photographed_card.id, collection_item_id=self.photographed_item.id))
        self.db.commit()

        result = preview_binder_print_optimization(binder.id, price_field="price_trend", current_user=self.user, db=self.db)
        self.assertEqual(len(result["recommendations"]), 1)
        current = result["recommendations"][0]["current"]
        self.assertTrue(current["has_scan_photo"])
        self.assertEqual(current["card"]["id"], self.photographed_card.id)

    # ── binders: equivalent prints ────────────────────────────────────────

    def test_equivalent_prints_flags_the_owned_photographed_variant(self):
        binder = Binder(name="Ivy's", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        bc = BinderCard(binder_id=binder.id, card_id=self.photographed_card.id, collection_item_id=self.photographed_item.id)
        self.db.add(bc)
        self.db.commit()
        self.db.refresh(bc)

        result = get_binder_entry_equivalent_prints(binder.id, bc.id, price_field="price_trend", current_user=self.user, db=self.db)
        self.assertEqual(result["scope"], "collection")
        current = next(e for e in result["equivalents"] if e["is_current"])
        self.assertTrue(current["has_scan_photo"])

    def test_wishlist_scope_equivalents_are_never_flagged(self):
        """Wishlist-scope equivalents have no collection_item behind them at
        all — has_scan_photo must come back false, not error."""
        # A card with no fingerprint short-circuits to an empty equivalents
        # list ("no playable fingerprint available") before has_scan_photo
        # ever comes into it, which would make this test pass for the wrong
        # reason. Setting it directly also avoids the endpoint reaching out
        # to the real TCGdex API for gameplay data.
        self.photographed_card.playable_fingerprint = "jigglypuff-035"
        self.db.commit()
        binder = Binder(name="Wanted", user_id=self.user.id, binder_type="wishlist")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        bc = BinderCard(binder_id=binder.id, card_id=self.photographed_card.id, required_quantity=1)
        self.db.add(bc)
        self.db.commit()
        self.db.refresh(bc)

        result = get_binder_entry_equivalent_prints(binder.id, bc.id, price_field="price_trend", current_user=self.user, db=self.db)
        self.assertEqual(result["scope"], "wishlist")
        self.assertTrue(result["equivalents"])
        self.assertTrue(all(e["has_scan_photo"] is False for e in result["equivalents"]))

    # ── dashboard: top valuable cards ─────────────────────────────────────

    def test_dashboard_top_cards_flags_the_photographed_item(self):
        self.photographed_item.quantity = 1
        self.photographed_card.price_trend = 100.0
        self.bare_card.price_trend = 1.0
        self.db.commit()

        result = get_dashboard(db=self.db, price_field="price_trend", current_user=self.user)
        top = self._by_collection_item_id(result["top_cards"], self.photographed_item.id)
        self.assertTrue(top["has_scan_photo"])
        self.assertEqual(top["card"]["id"], self.photographed_card.id)

    def test_dashboard_recent_additions_flags_the_photographed_item(self):
        """Regression guard: this path was already fixed once before — make
        sure the later top_cards change didn't disturb it."""
        result = get_dashboard(db=self.db, price_field="price_trend", current_user=self.user)
        recent = self._by_collection_item_id(result["recent_additions"], self.photographed_item.id, key="id")
        self.assertTrue(recent["has_scan_photo"])

    # ── analytics: duplicates ──────────────────────────────────────────────

    def test_duplicates_flags_the_photographed_item(self):
        self.photographed_item.quantity = 3
        self.bare_item.quantity = 2
        self.db.commit()

        result = get_duplicates(price_field="price_trend", db=self.db, current_user=self.user)
        photographed = self._by_collection_item_id(result, self.photographed_item.id, key="id")
        bare = self._by_collection_item_id(result, self.bare_item.id, key="id")
        self.assertTrue(photographed["has_scan_photo"])
        self.assertEqual(photographed["card"]["id"], self.photographed_card.id)
        self.assertFalse(bare["has_scan_photo"])

    def test_duplicates_excludes_single_copies(self):
        """quantity == 1 items are not duplicates and must not appear at all —
        guards that the has_scan_photo change didn't loosen the existing
        quantity > 1 filter."""
        self.photographed_item.quantity = 1
        self.db.commit()

        result = get_duplicates(price_field="price_trend", db=self.db, current_user=self.user)
        self.assertFalse(any(r["id"] == self.photographed_item.id for r in result))


if __name__ == "__main__":
    unittest.main()
